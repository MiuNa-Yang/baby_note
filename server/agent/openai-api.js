import express from 'express';
import { randomUUID } from 'node:crypto';

import { runLocalTurn } from './babynote-agent.js';
import { runCodexTurn } from './codex-turn.js';
import { traceRequest } from './telemetry.js';
import { gatewaySettings, runGatewayTurn } from './gateway-turn.js';
import { createAgentService } from './domain.js';

const DEFAULT_MODEL = 'babynote-agent';
const STREAM_CHUNK_SIZE = 18;
const THINK_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_HISTORY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_HISTORY_MESSAGES = 12;
// Ollama's num_ctx is shared by the system prompt, tool schemas, history,
// current request, and model output. Keep history deliberately conservative
// so the 32K qwen3.5:9b context does not get crowded by old turns.
const DEFAULT_HISTORY_TOKEN_BUDGET = 6_000;
const DEFAULT_MAX_SESSIONS = 64;
const conversationStore = new Map();

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return content == null ? '' : String(content);
}

export function latestUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role || '').toLowerCase() === 'user') {
      return normalizeContent(messages[index]?.content).trim();
    }
  }
  return '';
}

function historyMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => ['user', 'assistant'].includes(String(message?.role || '').toLowerCase()))
    .map((message) => ({
      role: String(message.role).toLowerCase(),
      content: normalizeContent(message.content).trim(),
    }))
    .filter((message) => message.content);
}

function approximateTokenCount(content) {
  const text = String(content || '');
  if (!text) return 0;
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const other = text.length - cjk;
  // This is intentionally conservative for mixed Chinese/Latin text. It is
  // only a preflight bound; Ollama remains the source of actual token counts.
  return Math.max(1, Math.ceil(cjk * 1.1 + other / 4));
}

function trimHistory(messages, maxMessages, maxTokens) {
  const normalized = historyMessages(messages);
  const selected = [];
  let tokenCount = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (selected.length >= maxMessages) break;
    const message = normalized[index];
    const messageTokens = approximateTokenCount(message.content);
    if (selected.length && tokenCount + messageTokens > maxTokens) break;
    selected.push(message);
    tokenCount += messageTokens;
  }
  selected.reverse();
  // Stored history is normally complete user/assistant pairs. If a caller
  // supplied an odd history and the budget cut through a pair, avoid starting
  // the prompt with an orphan assistant answer.
  if (selected[0]?.role === 'assistant') selected.shift();
  return selected;
}

function historyTokenBudget() {
  return Math.floor(numberSetting(
    'BABYNOTE_AGENT_HISTORY_TOKEN_BUDGET',
    DEFAULT_HISTORY_TOKEN_BUDGET,
    256,
  ));
}

export function historyBeforeLatestUser(messages, maxMessages = DEFAULT_MAX_HISTORY_MESSAGES) {
  const normalized = historyMessages(messages);
  let lastUserIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index].role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return [];
  return trimHistory(
    normalized.slice(Math.max(0, lastUserIndex - maxMessages), lastUserIndex),
    maxMessages,
    historyTokenBudget(),
  );
}

function numberSetting(name, fallback, minimum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function sessionKey(body, req) {
  const user = String(body?.user || '').trim();
  if (user) return `user:${user}`;
  const header = String(req.headers['x-session-id'] || '').trim();
  return header ? `header:${header}` : 'xiaoai:default';
}

function readConversation(key, now = Date.now()) {
  const entry = conversationStore.get(key);
  if (!entry) return [];
  const ttl = numberSetting('BABYNOTE_AGENT_SESSION_TTL_MS', DEFAULT_HISTORY_TTL_MS, 1000);
  if (now - entry.updatedAt > ttl) {
    conversationStore.delete(key);
    return [];
  }
  entry.updatedAt = now;
  return trimHistory(
    entry.messages,
    Math.floor(numberSetting(
      'BABYNOTE_AGENT_MAX_HISTORY_MESSAGES',
      DEFAULT_MAX_HISTORY_MESSAGES,
      2,
    )),
    historyTokenBudget(),
  );
}

function writeConversation(key, messages, now = Date.now()) {
  const maxMessages = Math.floor(numberSetting(
    'BABYNOTE_AGENT_MAX_HISTORY_MESSAGES',
    DEFAULT_MAX_HISTORY_MESSAGES,
    2,
  ));
  const normalized = trimHistory(messages, maxMessages, historyTokenBudget());
  conversationStore.delete(key);
  conversationStore.set(key, { messages: normalized, updatedAt: now });
  const maxSessions = Math.floor(numberSetting(
    'BABYNOTE_AGENT_MAX_SESSIONS',
    DEFAULT_MAX_SESSIONS,
    1,
  ));
  while (conversationStore.size > maxSessions) {
    const oldest = conversationStore.keys().next().value;
    if (oldest == null) break;
    conversationStore.delete(oldest);
  }
}

export function chunkText(text, maxLength = STREAM_CHUNK_SIZE) {
  const chars = Array.from(String(text || ''));
  if (!chars.length) return [];
  const chunks = [];
  for (let index = 0; index < chars.length; index += maxLength) {
    chunks.push(chars.slice(index, index + maxLength).join(''));
  }
  return chunks;
}

function requestId(req) {
  const incoming = String(req.headers['x-request-id'] || '').trim();
  return incoming || `xiaoai-${randomUUID()}`;
}

function modelName(body) {
  const requested = String(body?.model || '').trim();
  return requested || String(process.env.BABYNOTE_AGENT_API_MODEL || DEFAULT_MODEL);
}

export function requestedThink(body) {
  const requested = body?.reasoning_effort ?? body?.reasoning?.effort;
  if (requested == null || String(requested).trim() === '') return null;
  const effort = String(requested).trim().toLowerCase();
  if (!THINK_LEVELS.has(effort)) {
    const error = new Error(
      `reasoning_effort must be one of: ${[...THINK_LEVELS].join(', ')}.`,
    );
    error.status = 400;
    error.code = 'invalid_request_error';
    throw error;
  }
  return effort;
}

function isAuthorized(req) {
  const expected = String(process.env.BABYNOTE_AGENT_API_TOKEN || '').trim();
  if (!expected) return true;
  const authorization = String(req.headers.authorization || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const apiKey = String(req.headers['x-api-key'] || '');
  return bearer === expected || apiKey === expected;
}

function unauthorized(res) {
  return res.status(401).json({
    error: {
      message: 'Invalid or missing Bearer token.',
      type: 'authentication_error',
    },
  });
}

function openAiUsage(usage = {}) {
  const promptTokens = Number(usage.input_tokens || 0);
  const completionTokens = Number(usage.output_tokens || 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function buildPrompt(body, req, sourceMessageId = requestId(req)) {
  const text = latestUserMessage(body?.messages);
  if (!text) {
    const error = new Error('messages must contain a non-empty user message.');
    error.status = 400;
    error.code = 'invalid_request_error';
    throw error;
  }

  // Keep the existing Agent's safety/tool prompt authoritative. The metadata
  // only gives BabyNote an audit channel and a stable request id when callers
  // retry with x-request-id.
  const user = String(body?.user || '').trim().replace(/[\[\]\r\n]/g, ' ');
  const source = user ? ` chat_id=${user}` : '';
  return `[cc-connect source_channel=xiaoai source_message_id=${sourceMessageId}${source}]\n${text}`;
}

async function runRequest({ body, req, database }) {
  const think = requestedThink(body);
  const localEnvironment = think == null
    ? process.env
    : { ...process.env, BABYNOTE_LOCAL_THINK: think };
  const key = sessionKey(body, req);
  const suppliedHistory = historyBeforeLatestUser(body?.messages);
  const history = suppliedHistory.length ? suppliedHistory : readConversation(key);
  const sourceMessageId = requestId(req);
  const prompt = buildPrompt(body, req, sourceMessageId);
  const primaryModel = String(process.env.BABYNOTE_AGENT_PRIMARY_MODEL || 'gpt-5.6-luna').trim();
  const route = String(process.env.BABYNOTE_AGENT_ROUTE || 'local-first').trim().toLowerCase();
  const cloudEnabled = route !== 'local-only' && primaryModel && primaryModel.toLowerCase() !== 'local';
  const cloudFirst = cloudEnabled && ['cloud-first', 'cloud'].includes(route);
  let result;

  const gateway = gatewaySettings();
  if (gateway) {
    result = await runGatewayTurn({ settings: gateway, prompt, history, reasoningEffort: think ?? undefined,
      environment: localEnvironment, service: createAgentService(database) });
  } else if (cloudFirst) {
    try {
      result = await runCodexTurn({
        prompt,
        history,
        environment: localEnvironment,
        model: primaryModel,
        reasoningEffort: think || process.env.BABYNOTE_CLOUD_REASONING_EFFORT || 'low',
        projectRoot: process.cwd(),
      });
    } catch (error) {
      console.warn(`[Agent] Cloud primary ${primaryModel} failed; falling back to local model: ${error.message}`);
      result = await runLocalTurn({
        prompt,
        service: createAgentService(database),
        environment: localEnvironment,
        history,
      });
    }
  } else {
    try {
      result = await runLocalTurn({
        prompt,
        service: createAgentService(database),
        environment: localEnvironment,
        history,
      });
    } catch (error) {
      if (!cloudEnabled) throw error;
      console.warn(`[Agent] Local primary failed; falling back to cloud model ${primaryModel}: ${error.message}`);
      result = await runCodexTurn({
        prompt,
        history,
        environment: localEnvironment,
        model: primaryModel,
        reasoningEffort: think || process.env.BABYNOTE_CLOUD_REASONING_EFFORT || 'low',
        projectRoot: process.cwd(),
      });
    }
  }
  const reply = String(result.reply || '').trim();
  if (!reply) {
    const error = new Error('BabyNote Agent returned an empty reply.');
    error.status = 502;
    error.code = 'empty_agent_response';
    throw error;
  }
  writeConversation(key, [
    ...history,
    { role: 'user', content: latestUserMessage(body?.messages) },
    { role: 'assistant', content: reply },
  ]);
  return { result, reply };
}

function completionResponse({ id, created, model, reply, usage }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: reply },
      finish_reason: 'stop',
    }],
    usage: openAiUsage(usage),
  };
}

function streamChunk({ id, created, model, delta, finishReason = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  };
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function writeStreamingResponse(res, { id, created, model, reply }) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  writeSse(res, streamChunk({ id, created, model, delta: { role: 'assistant' } }));
  for (const chunk of chunkText(reply)) {
    writeSse(res, streamChunk({ id, created, model, delta: { content: chunk } }));
    // Yield so Node can flush each SSE frame and the gateway can observe it.
    await new Promise((resolve) => setImmediate(resolve));
  }
  writeSse(res, streamChunk({
    id,
    created,
    model,
    delta: {},
    finishReason: 'stop',
  }));
  res.write('data: [DONE]\n\n');
  res.end();
}

export function createAgentOpenAiRouter(database) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!isAuthorized(req)) return unauthorized(res);
    return next();
  });

  router.get('/models', (req, res) => {
    const model = String(process.env.BABYNOTE_AGENT_API_MODEL || DEFAULT_MODEL);
    res.json({
      object: 'list',
      data: [{ object: 'model', id: model, created: 0, owned_by: 'babynote' }],
    });
  });

  router.post('/chat/completions', async (req, res, next) => {
    try {
      const id = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const created = Math.floor(Date.now() / 1000);
      const model = modelName(req.body);
      const { result, reply } = await traceRequest(database, {
        question: latestUserMessage(req.body?.messages), channel: 'xiaoai', babyId: process.env.BABYNOTE_AGENT_BABY_ID,
      }, () => runRequest({ body: req.body, req, database }));

      if (req.body?.stream === true) {
        return await writeStreamingResponse(res, { id, created, model, reply });
      }

      return res.json(completionResponse({
        id,
        created,
        model,
        reply,
        usage: result.usage,
      }));
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number(error?.status) || 502;
    return res.status(status).json({
      error: {
        message: error?.message || 'Agent request failed.',
        type: error?.code || 'agent_error',
      },
    });
  });

  return router;
}
