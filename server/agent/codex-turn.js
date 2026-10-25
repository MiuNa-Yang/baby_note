import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BABY_PROFILE_PROMPT } from './baby-profile.js';
import { traceAttempt } from './telemetry.js';

import {
  buildReadConfirmation,
  buildWriteConfirmation,
  extractIncomingPrompt,
  expectsTool,
  isClarifyingQuestion,
} from './babynote-agent.js';

const DEFAULT_MODEL = 'gpt-5.6-luna';
// XiaoAI is a voice path: a long cloud hang is worse than a quick local fallback.
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const WRITE_TOOLS = new Set([
  'record_milk',
  'start_sleep',
  'end_sleep',
  'record_solid_meal',
  'record_growth',
  'set_food_status',
]);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveCodexCommand(environment = process.env) {
  if (environment.BABYNOTE_CODEX_BIN) {
    return { command: environment.BABYNOTE_CODEX_BIN, prefixArgs: [] };
  }

  if (environment.APPDATA) {
    const npmEntry = path.join(
      environment.APPDATA,
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    );
    if (fs.existsSync(npmEntry)) {
      return { command: process.execPath, prefixArgs: [npmEntry] };
    }
  }

  return { command: 'codex.exe', prefixArgs: [] };
}

function resolveCodexHome(environment = process.env) {
  const configured = String(environment.BABYNOTE_CODEX_HOME || '').trim();
  if (configured) return configured;
  const localAppData = String(environment.LOCALAPPDATA || '').trim();
  if (localAppData) return path.join(localAppData, 'babynote-agent', 'codex-home');
  return '';
}

function normalizeReasoningEffort(value) {
  const requested = String(value || '').trim().toLowerCase();
  if (requested === 'none' || requested === 'minimal' || requested === '') return 'low';
  if (['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(requested)) return requested;
  return 'low';
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) => ['user', 'assistant'].includes(String(message?.role || '').toLowerCase()))
    .map((message) => ({
      role: String(message.role).toLowerCase(),
      content: String(message.content || '').trim(),
    }))
    .filter((message) => message.content)
    .slice(-12);
}

export function buildCloudPrompt(rawPrompt, history = []) {
  const { text } = extractIncomingPrompt(rawPrompt);
  const needsTool = expectsTool(text);
  const historyBlock = normalizeHistory(history)
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`)
    .join('\n');
  const instructions = needsTool
    ? [
      '当前消息明确涉及 BabyNote 宝宝数据。必须实际调用对应的 babynote MCP 业务工具后再回答。',
      '查询必须使用查询工具，可以按请求连续记录多个动作，也可以先查再写；不要调用 shell、资源发现或其它工具。',
      '工具返回错误时只说明失败并提出简短重试/澄清，不得说“已记录”或编造数据。',
      '写入辅食时 amount 一律使用克，不要填写或推断其它单位；时间播报必须使用工具返回的北京时间字段。',
      '口头回答时间优先说“刚刚”“今天上午/下午”“昨天”等自然说法，不要主动播报完整年月日或 ISO 时间。',
    ]
    : [
      '如果当前消息不涉及 BabyNote 数据，可以直接简短回答，不调用工具。',
    ];
  return [
    '你是 BabyNote 专用家庭带娃记录 Agent。支持宝宝档案、体重身长、食材排敏、奶量、睡眠、辅食、数据汇总、辅食计划和提醒。排敏清单无需克数，不产生进食记录；体重单位不明先询问。',
    '默认宝宝 ID 是 3。所有回答使用简短自然的中文，不展示推理、工具名或 JSON。',
    BABY_PROFILE_PROMPT,
    ...instructions,
    historyBlock ? `此前对话（仅用于理解上下文，不要重复执行历史动作）：\n${historyBlock}` : '',
    `当前用户消息：\n${text}`,
  ].filter(Boolean).join('\n\n');
}

function appendOutput(current, chunk, maxBytes) {
  const next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next, 'utf8') > maxBytes) {
    const error = new Error('Codex output exceeded the capture limit.');
    error.code = 'codex_output_limit';
    throw error;
  }
  return next;
}

function runProcess(command, args, input, timeoutMs, environment, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer;
    let child;

    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: Number.isInteger(code) ? code : 1,
        error,
        stdout,
        stderr,
        timedOut,
      });
    };

    try {
      child = spawnImpl(command, args, {
        cwd: process.cwd(),
        env: environment,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.stdout.on('data', (chunk) => {
      try {
        stdout = appendOutput(stdout, chunk, MAX_STDOUT_BYTES);
      } catch (error) {
        child.kill();
        finish(1, error);
      }
    });
    child.stderr.on('data', (chunk) => {
      try {
        stderr = appendOutput(stderr, chunk, MAX_STDERR_BYTES);
      } catch {
        // Diagnostics are bounded and never affect the route itself.
      }
    });
    child.on('error', (error) => finish(1, error));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
  });
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function toolStructuredResult(item) {
  const result = item?.result;
  const structured = result?.structured_content ?? result?.structuredContent;
  if (structured && typeof structured === 'object') return structured;
  const text = result?.content?.find((block) => block?.type === 'text')?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function parseCodexJsonl(stdout) {
  const businessCalls = [];
  const messages = [];
  let turnCompleted = false;
  let turnFailed = null;
  let usage = {};

  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = parseJsonLine(line);
    if (!event) continue;
    if (event.type === 'turn.failed') turnFailed = event.error || event;
    if (event.type === 'turn.completed') {
      turnCompleted = true;
      usage = event.usage || {};
    }
    if (event.type !== 'item.completed') continue;
    const item = event.item || {};
    if (item.type === 'agent_message' && String(item.text || '').trim()) {
      messages.push(String(item.text).trim());
    }
    if (item.type === 'mcp_tool_call' && item.server === 'babynote' && item.tool) {
      businessCalls.push({
        name: String(item.tool),
        arguments: item.arguments || {},
        result: toolStructuredResult(item),
        error: item.error || null,
      });
    }
  }

  return {
    turnCompleted,
    turnFailed,
    reply: messages.at(-1) || '',
    businessCalls,
    usage: {
      input_tokens: usage.input_tokens == null ? null : Number(usage.input_tokens),
      output_tokens: usage.output_tokens == null ? null : Number(usage.output_tokens),
    },
  };
}

function routeError(message, code = 'cloud_agent_error') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeReply(text) {
  return String(text || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 500);
}

export async function runCodexTurn(options) {
  const environment = options.environment || process.env;
  return traceAttempt({ provider: 'cloud', model: options.model || environment.BABYNOTE_AGENT_PRIMARY_MODEL || DEFAULT_MODEL,
    reasoning: options.reasoningEffort || environment.BABYNOTE_CLOUD_REASONING_EFFORT || 'low' }, () => runCodexTurnImpl(options));
}

async function runCodexTurnImpl({
  prompt,
  history = [],
  environment = process.env,
  model = String(environment.BABYNOTE_AGENT_PRIMARY_MODEL || DEFAULT_MODEL),
  reasoningEffort = environment.BABYNOTE_CLOUD_REASONING_EFFORT || 'low',
  timeoutMs = positiveInteger(environment.BABYNOTE_CLOUD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  projectRoot = process.cwd(),
  spawnImpl,
}) {
  const { text, metadata } = extractIncomingPrompt(prompt);
  const sourceMessageId = String(metadata.source_message_id || '').trim();
  const sourceChatId = String(metadata.chat_id || '').trim();
  const codex = resolveCodexCommand(environment);
  const codexHome = resolveCodexHome(environment);
  if (!codexHome || !fs.existsSync(path.join(codexHome, 'config.toml'))) {
    throw routeError(
      'Dedicated Codex configuration is unavailable.',
      'cloud_agent_not_configured',
    );
  }
  const childEnvironment = {
    ...environment,
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    BABYNOTE_AGENT_BABY_ID: String(environment.BABYNOTE_AGENT_BABY_ID || 3),
    CC_PLATFORM: 'xiaoai',
    CC_MESSAGE_ID: sourceMessageId,
    CC_SESSION_KEY: sourceChatId || 'xiaoai:default',
    CC_SOURCE_TEXT: text,
  };
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--json',
    '--cd',
    projectRoot,
    '-m',
    String(model || DEFAULT_MODEL),
    '-c',
    `model_reasoning_effort=${JSON.stringify(normalizeReasoningEffort(reasoningEffort))}`,
    '-',
  ];
  const result = await runProcess(
    codex.command,
    [...codex.prefixArgs, ...args],
    buildCloudPrompt(prompt, history),
    timeoutMs,
    childEnvironment,
    spawnImpl,
  );
  if (result.error || result.timedOut || result.code !== 0) {
    throw routeError(
      `Cloud Agent failed (${result.timedOut ? 'timeout' : result.error?.message || `exit_${result.code}`}).`,
      result.timedOut ? 'cloud_agent_timeout' : 'cloud_agent_process_error',
    );
  }

  const parsed = parseCodexJsonl(result.stdout);
  if (parsed.turnFailed || !parsed.turnCompleted) {
    throw routeError('Cloud Agent did not complete a turn.', 'cloud_agent_incomplete_turn');
  }
  const needsTool = expectsTool(text);
  if (needsTool && !parsed.businessCalls.length && !isClarifyingQuestion(parsed.reply)) {
    throw routeError(
      'Cloud Agent answered a BabyNote data operation without calling a BabyNote tool.',
      'cloud_agent_missing_tool',
    );
  }
  if (parsed.businessCalls.length > 1) {
    const failed = parsed.businessCalls.filter(call => call.error || call.result?.ok === false);
    const confirmations = parsed.businessCalls.map(call => call.error || call.result?.ok === false
      ? `有一步失败：${call.result?.error || call.error}`
      : buildWriteConfirmation(call.name, call.result, call.arguments) || buildReadConfirmation(call.name, call.result)).filter(Boolean);
    return { ignored: false, reply: failed.length ? confirmations.join('') : normalizeReply(parsed.reply) || confirmations.join(''),
      toolCalls: parsed.businessCalls, toolName: parsed.businessCalls.at(-1).name,
      toolResult: failed[0]?.result || (failed.length ? { ok: false } : parsed.businessCalls.at(-1).result), usage: parsed.usage };

  }
  const toolCall = parsed.businessCalls[0] || null;
  const toolResult = toolCall?.result;
  if (toolCall && (toolCall.error || toolResult?.ok === false)) {
    const failureText = toolResult?.error || toolCall.error || '工具执行失败，请稍后重试。';
    return {
      ignored: false,
      reply: `${WRITE_TOOLS.has(toolCall.name) ? '记录' : '查询'}失败：${failureText}`,
      toolName: toolCall.name,
      toolArguments: toolCall.arguments,
      toolResult,
      usage: parsed.usage,
    };
  }

  const trustedConfirmation = toolCall && WRITE_TOOLS.has(toolCall.name)
    ? buildWriteConfirmation(toolCall.name, toolResult)
    : toolCall
      ? buildReadConfirmation(toolCall.name, toolResult)
      : null;
  const reply = trustedConfirmation || normalizeReply(parsed.reply);
  if (!reply) throw routeError('Cloud Agent returned an empty reply.', 'empty_agent_response');
  return {
    ignored: false,
    reply,
    toolName: toolCall?.name || null,
    toolArguments: toolCall?.arguments,
    toolResult,
    usage: parsed.usage,
  };
}
