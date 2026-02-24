import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RAGFLOW_DIR = path.join(DATA_DIR, 'ragflow');
const DEFAULT_EPUB_PATH = path.join(DATA_DIR, 'raw_knowledge', '美国儿科学会育儿百科（第7版）.epub');
const DEFAULT_MD_PATH = path.join(RAGFLOW_DIR, '美国儿科学会育儿百科（第7版）.md');
const DEFAULT_CONFIG_PATH = path.join(RAGFLOW_DIR, 'config.json');

const RAGFLOW_BASE_URL = (process.env.RAGFLOW_BASE_URL || '').replace(/\/$/, '');
const RAGFLOW_API_KEY = process.env.RAGFLOW_API_KEY || '';
const DATASET_NAME = process.env.RAGFLOW_DATASET_NAME || '美国儿科学会育儿百科_第7版';
const CHAT_NAME = process.env.RAGFLOW_CHAT_NAME || '育儿AI问答';
const CHUNK_METHOD = process.env.RAGFLOW_CHUNK_METHOD || 'book';
const FORCE_REUPLOAD = process.env.RAGFLOW_FORCE_REUPLOAD === '1';
const WAIT_PARSE = process.env.RAGFLOW_WAIT_PARSE !== '0';
const PARSE_TIMEOUT_MS = Number(process.env.RAGFLOW_PARSE_TIMEOUT_MS || 20 * 60 * 1000);
const PARSE_POLL_MS = Number(process.env.RAGFLOW_PARSE_POLL_MS || 5000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureEnv() {
  if (!RAGFLOW_BASE_URL) {
    throw new Error('Missing env RAGFLOW_BASE_URL, e.g. http://127.0.0.1:9380');
  }
  if (!RAGFLOW_API_KEY) {
    throw new Error('Missing env RAGFLOW_API_KEY');
  }
}

function resolvePythonRunner() {
  const candidates = [
    { cmd: 'python', prefixArgs: [] },
    { cmd: 'python3', prefixArgs: [] },
    { cmd: 'py', prefixArgs: ['-3'] },
  ];
  for (const item of candidates) {
    const check = spawnSync(item.cmd, [...item.prefixArgs, '--version'], { stdio: 'ignore' });
    if (check.status === 0) return item;
  }
  throw new Error('Python runtime is required but was not found (python/python3/py -3).');
}

function runEpubToMarkdown(epubPath, markdownPath) {
  const python = resolvePythonRunner();
  const scriptPath = path.join(ROOT_DIR, 'scripts', 'epub_to_markdown.py');
  const args = [
    ...python.prefixArgs,
    scriptPath,
    '--input',
    epubPath,
    '--output',
    markdownPath,
  ];
  const result = spawnSync(python.cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`EPUB conversion failed (exit code ${result.status ?? 'unknown'})`);
  }
}

class RagflowClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async request(endpoint, { method = 'GET', json, body } = {}) {
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    let payload = body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers,
      body: payload,
    });

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { code: -1, message: text || 'Unknown response format' };
    }

    if (!response.ok) {
      throw new Error(`RAGFlow HTTP ${response.status}: ${parsed?.message || text}`);
    }
    if (parsed && parsed.code !== undefined && parsed.code !== 0) {
      throw new Error(`RAGFlow API error ${parsed.code}: ${parsed.message || 'Unknown error'}`);
    }
    return parsed?.data;
  }

  async listDatasetsByName(name) {
    const q = new URLSearchParams({
      page: '1',
      page_size: '100',
      name,
    });
    return this.request(`/api/v1/datasets?${q.toString()}`);
  }

  async createDataset(name) {
    return this.request('/api/v1/datasets', {
      method: 'POST',
      json: { name, chunk_method: CHUNK_METHOD },
    });
  }

  async listDocuments(datasetId, extra = {}) {
    const q = new URLSearchParams({ page: '1', page_size: '100', ...extra });
    return this.request(`/api/v1/datasets/${datasetId}/documents?${q.toString()}`);
  }

  async deleteDocuments(datasetId, ids) {
    if (!ids.length) return;
    await this.request(`/api/v1/datasets/${datasetId}/documents`, {
      method: 'DELETE',
      json: { ids },
    });
  }

  async uploadDocument(datasetId, filePath) {
    const fileBuffer = await fs.readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([fileBuffer]), path.basename(filePath));
    const data = await this.request(`/api/v1/datasets/${datasetId}/documents`, {
      method: 'POST',
      body: form,
    });
    return Array.isArray(data) ? data[0] : null;
  }

  async parseDocuments(datasetId, documentIds) {
    await this.request(`/api/v1/datasets/${datasetId}/chunks`, {
      method: 'POST',
      json: { document_ids: documentIds },
    });
  }

  async listChatsByName(name) {
    const q = new URLSearchParams({
      page: '1',
      page_size: '100',
      name,
    });
    return this.request(`/api/v1/chats?${q.toString()}`);
  }

  async createChat(name, datasetId) {
    return this.request('/api/v1/chats', {
      method: 'POST',
      json: {
        name,
        dataset_ids: [datasetId],
      },
    });
  }

  async updateChat(chatId, name, datasetId) {
    return this.request(`/api/v1/chats/${chatId}`, {
      method: 'PUT',
      json: {
        name,
        dataset_ids: [datasetId],
      },
    });
  }
}

function pickLatestByTime(items = [], field = 'update_time') {
  if (!Array.isArray(items) || !items.length) return null;
  return [...items].sort((a, b) => Number(b?.[field] || 0) - Number(a?.[field] || 0))[0];
}

async function ensureDataset(client) {
  const datasets = await client.listDatasetsByName(DATASET_NAME);
  const existing = pickLatestByTime(datasets, 'update_time');
  if (existing) {
    console.log(`Reusing dataset: ${existing.name} (${existing.id})`);
    return existing;
  }
  const created = await client.createDataset(DATASET_NAME);
  console.log(`Created dataset: ${created.name} (${created.id})`);
  return created;
}

async function ensureDocument(client, datasetId, markdownPath) {
  const docName = path.basename(markdownPath);
  const docsResp = await client.listDocuments(datasetId, { name: docName });
  const existingDocs = Array.isArray(docsResp?.docs) ? docsResp.docs : [];
  if (FORCE_REUPLOAD && existingDocs.length) {
    await client.deleteDocuments(datasetId, existingDocs.map((d) => d.id));
    console.log(`Deleted existing document(s): ${existingDocs.length}`);
  } else if (existingDocs.length) {
    const existing = pickLatestByTime(existingDocs, 'update_time');
    console.log(`Reusing document: ${existing.name} (${existing.id}) run=${existing.run}`);
    return existing;
  }

  const uploaded = await client.uploadDocument(datasetId, markdownPath);
  if (!uploaded?.id) {
    throw new Error('Upload succeeded but no document ID returned.');
  }
  console.log(`Uploaded document: ${uploaded.name} (${uploaded.id})`);
  return uploaded;
}

async function waitDocumentParseDone(client, datasetId, documentId) {
  const begin = Date.now();
  while (Date.now() - begin <= PARSE_TIMEOUT_MS) {
    const docsResp = await client.listDocuments(datasetId, { id: documentId });
    const docs = Array.isArray(docsResp?.docs) ? docsResp.docs : [];
    const doc = docs[0];
    if (!doc) throw new Error(`Document not found while polling: ${documentId}`);

    const run = String(doc.run || '').toUpperCase();
    const progress = Number(doc.progress || 0);
    const progressMsg = doc.progress_msg || '';
    console.log(`Parse status: run=${run} progress=${progress}% ${progressMsg}`.trim());

    if (run === 'DONE') return doc;
    if (run === 'FAIL' || run === 'CANCEL') {
      throw new Error(`Document parsing ended with status=${run}, message=${progressMsg || 'N/A'}`);
    }
    await sleep(PARSE_POLL_MS);
  }
  throw new Error(`Parsing timed out after ${PARSE_TIMEOUT_MS}ms`);
}

async function ensureChat(client, datasetId) {
  const chats = await client.listChatsByName(CHAT_NAME);
  const existing = pickLatestByTime(chats, 'update_time');
  if (!existing) {
    const created = await client.createChat(CHAT_NAME, datasetId);
    console.log(`Created chat assistant: ${created.name} (${created.id})`);
    return created;
  }

  const hasDataset = Array.isArray(existing.dataset_ids) && existing.dataset_ids.includes(datasetId);
  if (!hasDataset) {
    const updated = await client.updateChat(existing.id, existing.name || CHAT_NAME, datasetId);
    console.log(`Updated chat assistant dataset binding: ${updated.name} (${updated.id})`);
    return updated;
  }

  console.log(`Reusing chat assistant: ${existing.name} (${existing.id})`);
  return existing;
}

async function writeConfigFile(payload) {
  await fs.mkdir(path.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
  await fs.writeFile(DEFAULT_CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

async function main() {
  ensureEnv();
  await fs.mkdir(RAGFLOW_DIR, { recursive: true });

  const epubPath = process.env.RAGFLOW_EPUB_PATH || DEFAULT_EPUB_PATH;
  const markdownPath = process.env.RAGFLOW_MARKDOWN_PATH || DEFAULT_MD_PATH;

  console.log('Step 1/4: Convert EPUB to Markdown...');
  runEpubToMarkdown(epubPath, markdownPath);

  const client = new RagflowClient(RAGFLOW_BASE_URL, RAGFLOW_API_KEY);

  console.log('Step 2/4: Ensure dataset and upload document...');
  const dataset = await ensureDataset(client);
  const document = await ensureDocument(client, dataset.id, markdownPath);

  console.log('Step 3/4: Trigger document parsing...');
  await client.parseDocuments(dataset.id, [document.id]);
  let parsedDoc = document;
  if (WAIT_PARSE) {
    parsedDoc = await waitDocumentParseDone(client, dataset.id, document.id);
  }

  console.log('Step 4/4: Ensure chat assistant...');
  const chat = await ensureChat(client, dataset.id);

  const config = {
    base_url: RAGFLOW_BASE_URL,
    dataset_id: dataset.id,
    dataset_name: dataset.name,
    document_id: parsedDoc.id,
    document_name: parsedDoc.name,
    document_run: parsedDoc.run,
    chat_id: chat.id,
    chat_name: chat.name,
    markdown_path: path.relative(ROOT_DIR, markdownPath).replaceAll('\\', '/'),
    updated_at: new Date().toISOString(),
  };
  await writeConfigFile(config);

  console.log('\nKnowledge base setup completed.');
  console.log(`Config file: ${path.relative(ROOT_DIR, DEFAULT_CONFIG_PATH).replaceAll('\\', '/')}`);
  console.log(`Dataset ID: ${config.dataset_id}`);
  console.log(`Chat ID: ${config.chat_id}`);
}

main().catch((err) => {
  console.error('\nFailed to setup RAGFlow knowledge base.');
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
