import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ==============================
// Guide AI server-side settings
// 在这里配置你的 RAGFlow 助手参数（前端不会展示）
// ==============================
const GUIDE_AI_CONFIG = {
  assistantName: process.env.RAGFLOW_ASSISTANT_NAME || '育儿AI问答',

  // 这里填写你要绑定的 dataset_ids 列表（可多个）
  datasetIds: parseDatasetIds(
    process.env.RAGFLOW_DATASET_IDS || process.env.RAGFLOW_DATASET_ID || ''
  ),

  // 留给你自定义的助手参数（按需修改）
  llm: {
    model_name: process.env.RAGFLOW_MODEL_NAME || undefined,
    temperature: parseNumber(process.env.RAGFLOW_TEMPERATURE),
    top_p: parseNumber(process.env.RAGFLOW_TOP_P),
    max_tokens: parseNumber(process.env.RAGFLOW_MAX_TOKENS),
    presence_penalty: parseNumber(process.env.RAGFLOW_PRESENCE_PENALTY),
    frequency_penalty: parseNumber(process.env.RAGFLOW_FREQUENCY_PENALTY),
  },
  prompt: {
    system:
      process.env.RAGFLOW_SYSTEM_PROMPT ||
      '你是专业育儿助手。请结合知识库回答，先给结论，再给可执行建议；不确定时明确说明并建议就医。',
  },
  top_n: parseNumber(process.env.RAGFLOW_TOP_N),
  similarity_threshold: parseNumber(process.env.RAGFLOW_SIMILARITY_THRESHOLD),
};

function parseNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseDatasetIds(value) {
  if (Array.isArray(value)) {
    return value.map((s) => String(s || '').trim()).filter(Boolean);
  }
  const raw = String(value || '');
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const normalized = raw.replace(/^\uFEFF/, '').trim();
    if (!normalized) return null;
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function buildRuntimeConfig(dataDir) {
  const configPath = join(dataDir, 'ragflow', 'config.json');
  const fileConfig = readJsonFile(configPath) || {};

  const baseUrl = String(
    process.env.RAGFLOW_BASE_URL ||
      fileConfig.base_url ||
      fileConfig.RAGFLOW_BASE_URL ||
      ''
  )
    .trim()
    .replace(/\/$/, '');
  const apiKey = String(
    process.env.RAGFLOW_API_KEY ||
      fileConfig.api_key ||
      fileConfig.RAGFLOW_API_KEY ||
      ''
  ).trim();

  // 兼容旧配置：如果你在 config.json 里仍是 dataset_id，也会自动并入列表
  const configuredDatasetIds = [
    ...GUIDE_AI_CONFIG.datasetIds,
    ...parseDatasetIds(fileConfig.dataset_ids),
    ...parseDatasetIds(fileConfig.dataset_id),
  ];

  const assistantName =
    process.env.RAGFLOW_ASSISTANT_NAME ||
    fileConfig.assistant_name ||
    fileConfig.RAGFLOW_ASSISTANT_NAME ||
    GUIDE_AI_CONFIG.assistantName;
  const chatId = String(
    process.env.RAGFLOW_CHAT_ID ||
      fileConfig.chat_id ||
      fileConfig.RAGFLOW_CHAT_ID ||
      ''
  ).trim();

  return {
    baseUrl,
    apiKey,
    assistantName,
    datasetIds: [...new Set(configuredDatasetIds)],
    llm: GUIDE_AI_CONFIG.llm,
    prompt: GUIDE_AI_CONFIG.prompt,
    top_n: GUIDE_AI_CONFIG.top_n,
    similarity_threshold: GUIDE_AI_CONFIG.similarity_threshold,
    chatId,
  };
}

class RagflowError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'RagflowError';
    this.status = status;
  }
}

function ragflowLog(payload) {
  try {
    const line = `[${new Date().toISOString()}] ${JSON.stringify({ event: 'ragflow_http', ...payload })}\n`;
    appendFileSync('server.log', line);
  } catch {
    // ignore logging failure
  }
}

function extractChatVariableKeys(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
  const reserved = new Set([
    'question',
    'stream',
    'quote',
    'session_id',
    'user_id',
    'message_id',
  ]);
  return Object.keys(json).filter((key) => !reserved.has(key));
}

async function ragflowRequest(runtime, endpoint, { method = 'GET', json } = {}) {
  if (!runtime.baseUrl) throw new RagflowError('RAGFlow base URL is not configured.', 503);
  if (!runtime.apiKey) throw new RagflowError('RAGFlow API key is not configured.', 503);

  const headers = {
    Authorization: `Bearer ${runtime.apiKey}`,
  };
  const options = { method, headers };
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(json);
  }

  ragflowLog({
    phase: 'request',
    method,
    endpoint,
    has_body: json !== undefined,
    body_keys: json && typeof json === 'object' ? Object.keys(json) : [],
    has_variables: extractChatVariableKeys(json).length > 0,
    variable_keys: extractChatVariableKeys(json),
  });

  const abortController = new AbortController();
  const timeoutMs = 20000;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${runtime.baseUrl}${endpoint}`, {
      ...options,
      signal: abortController.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      ragflowLog({
        phase: 'request_timeout',
        method,
        endpoint,
        timeout_ms: timeoutMs,
      });
      throw new RagflowError(`RAGFlow request timeout after ${timeoutMs}ms`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { code: -1, message: text || 'Unknown response format' };
  }

  if (!response.ok) {
    ragflowLog({
      phase: 'response_error',
      method,
      endpoint,
      status: response.status,
      message: parsed?.message || text || 'http error',
    });
    throw new RagflowError(`RAGFlow HTTP ${response.status}: ${parsed?.message || text}`, 502);
  }
  if (parsed?.code !== undefined && parsed.code !== 0) {
    ragflowLog({
      phase: 'api_error',
      method,
      endpoint,
      status: response.status,
      code: parsed.code,
      message: parsed.message || 'Unknown error',
    });
    throw new RagflowError(`RAGFlow API ${parsed.code}: ${parsed.message || 'Unknown error'}`, 502);
  }
  ragflowLog({
    phase: 'response_ok',
    method,
    endpoint,
    status: response.status,
    code: parsed?.code ?? null,
  });
  if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'data')) return parsed.data;
  return parsed;
}

async function ragflowRequestStream(runtime, endpoint, { method = 'POST', json, signal } = {}) {
  if (!runtime.baseUrl) throw new RagflowError('RAGFlow base URL is not configured.', 503);
  if (!runtime.apiKey) throw new RagflowError('RAGFlow API key is not configured.', 503);

  const headers = {
    Authorization: `Bearer ${runtime.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };

  ragflowLog({
    phase: 'request_stream',
    method,
    endpoint,
    has_body: json !== undefined,
    body_keys: json && typeof json === 'object' ? Object.keys(json) : [],
    has_variables: extractChatVariableKeys(json).length > 0,
    variable_keys: extractChatVariableKeys(json),
  });

  const response = await fetch(`${runtime.baseUrl}${endpoint}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { message: text || 'Unknown response format' };
    }
    ragflowLog({
      phase: 'response_stream_error',
      method,
      endpoint,
      status: response.status,
      message: parsed?.message || text || 'http error',
    });
    throw new RagflowError(`RAGFlow HTTP ${response.status}: ${parsed?.message || text}`, 502);
  }

  if (!response.body) {
    ragflowLog({
      phase: 'response_stream_empty',
      method,
      endpoint,
      status: response.status,
    });
    throw new RagflowError('RAGFlow streaming response body is empty.', 502);
  }
  ragflowLog({
    phase: 'response_stream_ok',
    method,
    endpoint,
    status: response.status,
  });
  return response.body;
}

function normalizeMessages(question, messages) {
  if (Array.isArray(messages) && messages.length) {
    const normalized = messages
      .map((item) => ({
        role: String(item?.role || '').trim(),
        content: String(item?.content || '').trim(),
      }))
      .filter((item) => ['system', 'user', 'assistant'].includes(item.role) && item.content);
    if (normalized.some((item) => item.role === 'user')) return normalized;
  }

  const content = String(question || '').trim();
  if (!content) return [];
  return [{ role: 'user', content }];
}

function extractLatestUserQuestion(question, messages) {
  const direct = String(question || '').trim();
  if (direct) return direct;

  const normalized = normalizeMessages('', messages);
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    if (normalized[i].role === 'user') return normalized[i].content;
  }
  return '';
}

function normalizeReferenceChunks(reference) {
  const rawChunks = reference?.chunks;
  if (!rawChunks) return [];
  if (Array.isArray(rawChunks)) {
    return rawChunks.map((chunk, index) => ({
      ...chunk,
      citation_id: chunk?.citation_id ?? chunk?.id ?? index + 1,
    }));
  }
  if (typeof rawChunks === 'object') {
    return Object.entries(rawChunks).map(([key, chunk]) => ({
      ...chunk,
      citation_id: chunk?.citation_id ?? key,
    }));
  }
  return [];
}

function toReferenceList(references) {
  const chunks = normalizeReferenceChunks(references);
  return chunks.map((chunk) => ({
    citation_id: chunk.citation_id ?? null,
    id: chunk.id || null,
    document_id: chunk.document_id || null,
    document_name: chunk.document_name || null,
    dataset_id: chunk.dataset_id || null,
    similarity: chunk.similarity ?? null,
    content: chunk.content || '',
    document_metadata: chunk.document_metadata || null,
  }));
}

function extractChunkPayload(raw) {
  if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'data')) {
    return raw.data;
  }
  return raw;
}

function stringifyMaybe(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((v) => stringifyMaybe(v)).join('');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
  }
  return '';
}

function extractThinkingFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const candidates = [
    payload.reasoning_content,
    payload.reasoning,
    payload.think,
    payload.thinking,
    payload.analysis,
    choice?.delta?.reasoning_content,
    choice?.delta?.reasoning,
    choice?.delta?.think,
    choice?.delta?.thinking,
    choice?.message?.reasoning_content,
    choice?.message?.reasoning,
    choice?.message?.think,
    choice?.message?.thinking,
    payload?.delta?.reasoning_content,
    payload?.delta?.reasoning,
    payload?.delta?.think,
    payload?.delta?.thinking,
    payload?.message?.reasoning_content,
    payload?.message?.reasoning,
    payload?.message?.think,
    payload?.message?.thinking,
  ];

  for (const item of candidates) {
    const text = stringifyMaybe(item);
    if (text) return text;
  }
  return '';
}

function extractThinkTagChunks(text) {
  const input = String(text || '');
  if (!input.includes('<think>')) {
    return {
      cleaned: input,
      thinking: '',
      hasOpenTag: false,
    };
  }

  let cleaned = '';
  let thinking = '';
  let cursor = 0;
  let inThink = false;

  while (cursor < input.length) {
    const nextOpen = input.indexOf('<think>', cursor);
    const nextClose = input.indexOf('</think>', cursor);

    if (!inThink) {
      if (nextOpen < 0) {
        cleaned += input.slice(cursor);
        break;
      }
      cleaned += input.slice(cursor, nextOpen);
      cursor = nextOpen + '<think>'.length;
      inThink = true;
      continue;
    }

    if (nextClose < 0) {
      thinking += input.slice(cursor);
      cursor = input.length;
      break;
    }
    thinking += input.slice(cursor, nextClose);
    cursor = nextClose + '</think>'.length;
    inThink = false;
  }

  return {
    cleaned,
    thinking,
    hasOpenTag: inThink,
  };
}

function getPartialTagTail(text, tag) {
  const src = String(text || '');
  const max = Math.min(src.length, tag.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (src.slice(-len) === tag.slice(0, len)) return src.slice(-len);
  }
  return '';
}

function consumeThinkTaggedDelta(delta, state) {
  const openTag = '<think>';
  const closeTag = '</think>';
  let source = `${state.tail || ''}${String(delta || '')}`;
  let idx = 0;
  let clean = '';
  let thinking = '';
  let inThink = Boolean(state.inThink);
  let tail = '';

  while (idx < source.length) {
    if (!inThink) {
      const open = source.indexOf(openTag, idx);
      if (open < 0) {
        clean += source.slice(idx);
        idx = source.length;
        break;
      }
      clean += source.slice(idx, open);
      idx = open + openTag.length;
      inThink = true;
      continue;
    }

    const close = source.indexOf(closeTag, idx);
    if (close < 0) {
      thinking += source.slice(idx);
      idx = source.length;
      break;
    }
    thinking += source.slice(idx, close);
    idx = close + closeTag.length;
    inThink = false;
  }

  if (!inThink) {
    const openTail = getPartialTagTail(clean, openTag);
    if (openTail) {
      clean = clean.slice(0, -openTail.length);
      tail = openTail;
    }
  } else {
    const closeTail = getPartialTagTail(thinking, closeTag);
    if (closeTail) {
      thinking = thinking.slice(0, -closeTail.length);
      tail = closeTail;
    }
  }

  return {
    cleanDelta: clean,
    thinkingDelta: thinking,
    nextState: {
      inThink,
      tail,
    },
  };
}

function extractIncrementalDelta(previous, current) {
  const prev = String(previous || '');
  const next = String(current || '');
  if (!next) return '';
  if (!prev) return next;
  if (next.startsWith(prev)) return next.slice(prev.length);
  return next;
}

function isSameDatasetIds(a, b) {
  const as = [...new Set((a || []).map((id) => String(id).trim()).filter(Boolean))].sort();
  const bs = [...new Set((b || []).map((id) => String(id).trim()).filter(Boolean))].sort();
  if (as.length !== bs.length) return false;
  return as.every((v, i) => v === bs[i]);
}

function compactObject(input) {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

function buildAssistantPayload(runtime) {
  return compactObject({
    name: runtime.assistantName,
    dataset_ids: runtime.datasetIds,
    llm: compactObject(runtime.llm || {}),
    prompt: compactObject(runtime.prompt || {}),
    top_n: runtime.top_n,
    similarity_threshold: runtime.similarity_threshold,
  });
}

function extractChats(data) {
  if (Array.isArray(data?.chats)) return data.chats;
  if (Array.isArray(data)) return data;
  return [];
}

async function findAssistantByName(runtime, name) {
  const query = new URLSearchParams({
    page: '1',
    page_size: '100',
    name,
  });
  const data = await ragflowRequest(runtime, `/api/v1/chats?${query.toString()}`);
  const chats = extractChats(data);
  return chats.find((chat) => String(chat?.name || '').trim() === name) || null;
}

async function ensureGuideAssistant(runtime) {
  if (runtime.chatId) return runtime.chatId;
  throw new RagflowError('RAGFlow chat_id is not configured.', 503);
}

function validateRuntime(runtime) {
  if (!runtime.baseUrl) throw new RagflowError('RAGFlow base URL is not configured.', 503);
  if (!runtime.apiKey) throw new RagflowError('RAGFlow API key is not configured.', 503);
  if (!runtime.chatId) throw new RagflowError('RAGFlow chat_id is not configured.', 503);
}

export async function getGuideAiStatus(dataDir) {
  const runtime = buildRuntimeConfig(dataDir);
  try {
    validateRuntime(runtime);
    return {
      ready: true,
    };
  } catch (error) {
    return {
      ready: false,
      error: error?.message || String(error),
    };
  }
}

export async function createGuideAiSession(dataDir, { name, userId } = {}) {
  const runtime = buildRuntimeConfig(dataDir);
  validateRuntime(runtime);

  const payload = {
    name: String(name || `session-${Date.now()}`),
  };
  if (userId) payload.user_id = String(userId);

  const data = await ragflowRequest(
    runtime,
    `/api/v1/chats/${runtime.chatId}/sessions`,
    { method: 'POST', json: payload }
  );

  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const firstAssistant = messages.find((m) => m?.role === 'assistant' && String(m?.content || '').trim());

  return {
    session_id: data?.id || null,
    welcome_message: firstAssistant ? String(firstAssistant.content) : '',
    raw_messages: messages,
  };
}

export async function listGuideAiSessions(dataDir, { page = 1, pageSize = 50 } = {}) {
  const runtime = buildRuntimeConfig(dataDir);
  validateRuntime(runtime);
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  const data = await ragflowRequest(runtime, `/api/v1/chats/${runtime.chatId}/sessions?${query.toString()}`);
  const sessions = Array.isArray(data?.sessions) ? data.sessions : Array.isArray(data) ? data : [];
  return sessions.map((s) => ({
    id: s?.id || null,
    name: s?.name || '',
    create_time: s?.create_time || null,
    update_time: s?.update_time || null,
  }));
}

export async function getGuideAiSession(dataDir, { sessionId }) {
  const runtime = buildRuntimeConfig(dataDir);
  validateRuntime(runtime);
  if (!sessionId) throw new RagflowError('session_id is required.', 400);
  const query = new URLSearchParams({
    page: '1',
    page_size: '1',
    id: String(sessionId),
  });
  const data = await ragflowRequest(
    runtime,
    `/api/v1/chats/${runtime.chatId}/sessions?${query.toString()}`
  );
  const sessions = Array.isArray(data?.sessions) ? data.sessions : Array.isArray(data) ? data : [];
  const first = sessions[0] || null;
  if (!first) throw new RagflowError(`Session not found: ${sessionId}`, 404);
  const messages = Array.isArray(first?.messages) ? first.messages : [];
  return {
    id: first?.id || sessionId,
    name: first?.name || '',
    messages: messages.map((m) => ({
      role: m?.role || '',
      content: String(m?.content || ''),
    })),
    update_time: first?.update_time || null,
    create_time: first?.create_time || null,
  };
}

export async function deleteGuideAiSession(dataDir, { sessionId }) {
  const runtime = buildRuntimeConfig(dataDir);
  validateRuntime(runtime);
  if (!sessionId) throw new RagflowError('session_id is required.', 400);
  await ragflowRequest(runtime, `/api/v1/chats/${runtime.chatId}/sessions`, {
    method: 'DELETE',
    json: {
      ids: [String(sessionId)],
    },
  });
  return { ok: true };
}

function normalizeVariables(variables) {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return {};
  const normalized = {};
  for (const [key, value] of Object.entries(variables)) {
    const k = String(key || '').trim();
    if (!k) continue;
    normalized[k] = value === undefined || value === null ? '' : String(value);
  }
  return normalized;
}

export async function askGuideAi(dataDir, { question, sessionId, messages, variables }) {
  const runtime = buildRuntimeConfig(dataDir);
  validateRuntime(runtime);

  const chatId = runtime.chatId;
  const userQuestion = extractLatestUserQuestion(question, messages);
  if (!userQuestion) {
    throw new RagflowError('A non-empty user message is required.', 400);
  }

  const normalizedVariables = normalizeVariables(variables);
  const payload = {
    ...normalizedVariables,
    question: userQuestion,
    stream: false,
    quote: true,
  };
  if (sessionId) payload.session_id = sessionId;

  const data = await ragflowRequest(runtime, `/api/v1/chats/${chatId}/completions`, {
    method: 'POST',
    json: payload,
  });

  const rawAnswer = String(data?.answer || '');
  const thinkParsed = extractThinkTagChunks(rawAnswer);
  const answer = String(thinkParsed.cleaned || '').trim();
  const fieldThinking = extractThinkingFromPayload(data);
  const mergedThinking = `${fieldThinking || ''}${thinkParsed.thinking || ''}`.trim();
  if (!answer) {
    throw new RagflowError('RAGFlow returned an empty answer.', 502);
  }

  const references = data?.reference || null;
  const chunks = normalizeReferenceChunks(references);

  return {
    answer,
    thinking: mergedThinking,
    session_id: data?.session_id || sessionId || null,
    message_id: data?.id || null,
    references: chunks.map((chunk) => ({
      citation_id: chunk.citation_id ?? null,
      id: chunk.id || null,
      document_id: chunk.document_id || null,
      document_name: chunk.document_name || null,
      dataset_id: chunk.dataset_id || null,
      similarity: chunk.similarity ?? null,
      content: chunk.content || '',
      document_metadata: chunk.document_metadata || null,
    })),
    usage: data?.usage || null,
  };
}

export async function* askGuideAiStream(dataDir, { question, sessionId, messages, signal, variables } = {}) {
  const runtime = buildRuntimeConfig(dataDir);
  validateRuntime(runtime);

  const chatId = runtime.chatId;
  const userQuestion = extractLatestUserQuestion(question, messages);
  if (!userQuestion) {
    throw new RagflowError('A non-empty user message is required.', 400);
  }

  const normalizedVariables = normalizeVariables(variables);
  const payload = {
    ...normalizedVariables,
    question: userQuestion,
    stream: true,
    quote: true,
  };
  if (sessionId) payload.session_id = sessionId;

  const body = await ragflowRequestStream(
    runtime,
    `/api/v1/chats/${chatId}/completions`,
    { method: 'POST', json: payload, signal }
  );

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let outSessionId = sessionId || null;
  let outMessageId = null;
  let outUsage = null;
  let outReferences = [];
  let outThinking = '';
  let thinkParseState = { inThink: false, tail: '' };
  let explicitThinkMode = false;
  let rawAnswerSnapshot = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let splitIndex = buffer.indexOf('\n\n');
    while (splitIndex >= 0) {
      const block = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      splitIndex = buffer.indexOf('\n\n');

      const lines = block.split('\n');
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;

      const raw = dataLines.join('\n');
      if (raw === '[DONE]') {
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      const wrapped = extractChunkPayload(parsed);
      if (wrapped === true) continue;

      const chunk = wrapped || {};
      const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
      const currentAnswerRaw = String(chunk?.answer || '');
      const choiceDeltaContent = stringifyMaybe(choice?.delta?.content);
      const currentThinking = extractThinkingFromPayload(chunk);
      let rawDelta = '';
      let cleanDelta = '';
      let thinkingDelta = '';

      if (chunk?.start_to_think === true) explicitThinkMode = true;

      // 兼容两种流式格式：
      // 1) 累积格式：chunk.answer = 到当前为止的完整文本
      // 2) 增量格式：chunk.answer = 当前这一个分片
      if (currentAnswerRaw) {
        rawDelta = extractIncrementalDelta(rawAnswerSnapshot, currentAnswerRaw);
        rawAnswerSnapshot = currentAnswerRaw;
      } else if (choiceDeltaContent) {
        rawDelta = choiceDeltaContent;
      }

      if (rawDelta) {
        if (explicitThinkMode) {
          thinkingDelta += rawDelta;
          outThinking += rawDelta;
        } else {
          const parsedDelta = consumeThinkTaggedDelta(rawDelta, thinkParseState);
          cleanDelta = parsedDelta.cleanDelta;
          if (parsedDelta.thinkingDelta) {
            thinkingDelta += parsedDelta.thinkingDelta;
            outThinking += parsedDelta.thinkingDelta;
          }
          thinkParseState = parsedDelta.nextState;
        }
      }

      if (cleanDelta) {
        answer += cleanDelta;
        yield {
          type: 'delta',
          delta: cleanDelta,
          answer,
          session_id: chunk?.session_id || outSessionId || null,
        };
      }

      if (currentThinking) {
        if (currentThinking.startsWith(outThinking)) {
          thinkingDelta = currentThinking.slice(outThinking.length);
          outThinking = currentThinking;
        } else if (outThinking.endsWith(currentThinking)) {
          // ignore duplicated suffix chunks
        } else {
          thinkingDelta = currentThinking;
          outThinking += currentThinking;
        }
      }

      if (thinkingDelta) {
        yield {
          type: 'thinking',
          delta: thinkingDelta,
          thinking: outThinking,
          session_id: chunk?.session_id || outSessionId || null,
        };
      }

      if (chunk?.session_id) outSessionId = chunk.session_id;
      if (chunk?.id) outMessageId = chunk.id;
      if (chunk?.usage) outUsage = chunk.usage;

      const rawReferences =
        chunk?.reference ||
        choice?.delta?.reference ||
        choice?.message?.reference ||
        null;
      if (rawReferences) {
        outReferences = toReferenceList(rawReferences);
        yield {
          type: 'references',
          references: outReferences,
        };
      }

      if (chunk?.end_to_think === true) explicitThinkMode = false;
    }
  }

  yield {
    type: 'done',
    answer: answer.trim(),
    thinking: outThinking.trim(),
    session_id: outSessionId || null,
    message_id: outMessageId || null,
    references: outReferences,
    usage: outUsage,
  };
}

export { RagflowError };
