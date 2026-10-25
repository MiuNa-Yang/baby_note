import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_LOCAL_TIMEOUT_MS = 180_000;
const DEFAULT_FALLBACK_TIMEOUT_MS = 180_000;
const DEFAULT_COOLDOWN_MS = 300_000;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

export function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeModelName(value) {
  return String(value || '').trim().toLowerCase();
}

export function isRequestedModelAvailable(payload, requestedModel) {
  const wanted = normalizeModelName(requestedModel);
  if (!wanted || !payload || !Array.isArray(payload.models)) return false;

  return payload.models.some((entry) => {
    const candidates = [entry && entry.name, entry && entry.model]
      .map(normalizeModelName)
      .filter(Boolean);
    return candidates.some((candidate) => (
      candidate === wanted
      || (!wanted.includes(':') && candidate === `${wanted}:latest`)
    ));
  });
}

export function stripRouteArguments(args) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--oss') continue;
    if (arg === '--local-provider' || arg === '--model' || arg === '-m') {
      index += 1;
      continue;
    }
    if ((arg === '-c' || arg === '--config') && index + 1 < args.length) {
      const value = String(args[index + 1]).trim();
      if (/^(model_provider|oss_provider)\s*=/.test(value)) {
        index += 1;
        continue;
      }
    }
    output.push(arg);
  }
  return output;
}

export function buildRoutedArguments(args, provider, model) {
  const output = stripRouteArguments(args);
  if (output[0] !== 'exec') {
    throw new Error('BabyNote model router only supports `codex exec`.');
  }

  const insertAt = output[1] === 'resume' ? 2 : 1;
  output.splice(
    insertAt,
    0,
    '-c',
    `model_provider=${JSON.stringify(provider)}`,
    '--model',
    model,
  );
  return output;
}

export function containsCompletedTurn(stdout) {
  let completed = false;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.failed') return false;
      if (event.type === 'turn.completed') completed = true;
    } catch {
      // Codex can emit a non-JSON warning before JSONL starts. Ignore it.
    }
  }
  return completed;
}

export function isSuccessfulRun(result) {
  return Boolean(
    result
    && result.code === 0
    && !result.timedOut
    && !result.overflowed
    && containsCompletedTurn(result.stdout),
  );
}

async function fetchModelTags(baseUrl, timeoutMs = 1_500) {
  const endpoint = new URL('/api/tags', `${String(baseUrl).replace(/\/$/, '')}/`);
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Ollama tags returned HTTP ${response.status}`);
  return response.json();
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

function runProcess(command, args, input, timeoutMs, environment = process.env) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflowed = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: Number.isInteger(code) ? code : 1,
        error,
        stdout,
        stderr,
        timedOut,
        overflowed,
        durationMs: Date.now() - startedAt,
      });
    };

    const capture = (target, chunk) => {
      const next = target + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
        overflowed = true;
        child.kill();
        return target;
      }
      return next;
    };

    child.stdout.on('data', (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = capture(stderr, chunk); });
    child.on('error', (error) => finish(1, error));
    child.on('close', (code) => finish(code));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function readCooldown(statePath, now = Date.now()) {
  if (!statePath || !fs.existsSync(statePath)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return Number(state.unhealthyUntil) > now ? state : null;
  } catch {
    return null;
  }
}

function writeCooldown(statePath, reason, cooldownMs) {
  if (!statePath) return;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    unhealthyUntil: Date.now() + cooldownMs,
    reason,
  }), 'utf8');
}

function clearCooldown(statePath) {
  if (!statePath) return;
  try { fs.unlinkSync(statePath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function appendRouteLog(logPath, entry) {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    })}\n`, 'utf8');
  } catch {
    // Routing must keep working even when its diagnostic log is unavailable.
  }
}

export function summarizeFailure(result) {
  if (result.timedOut) return 'timeout';
  if (result.overflowed) return 'output_limit';
  if (result.error) return `spawn_error:${result.error.code || result.error.message}`;
  if (result.code !== 0) return `exit_${result.code}`;
  return 'incomplete_turn';
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const originalArgs = process.argv.slice(2);
  const prompt = await readStandardInput();
  const localModel = String(process.env.BABYNOTE_LOCAL_MODEL || '').trim();
  const localBaseUrl = String(
    process.env.BABYNOTE_LOCAL_BASE_URL || DEFAULT_LOCAL_BASE_URL,
  ).trim();
  const fallbackModel = String(process.env.BABYNOTE_FALLBACK_MODEL || 'gpt-5.6-luna').trim();
  const localTimeoutMs = positiveInteger(
    process.env.BABYNOTE_LOCAL_TIMEOUT_MS,
    DEFAULT_LOCAL_TIMEOUT_MS,
  );
  const fallbackTimeoutMs = positiveInteger(
    process.env.BABYNOTE_FALLBACK_TIMEOUT_MS,
    DEFAULT_FALLBACK_TIMEOUT_MS,
  );
  const cooldownMs = positiveInteger(
    process.env.BABYNOTE_LOCAL_COOLDOWN_MS,
    DEFAULT_COOLDOWN_MS,
  );
  const logPath = String(process.env.BABYNOTE_MODEL_ROUTER_LOG || '').trim();
  const statePath = String(
    process.env.BABYNOTE_MODEL_ROUTER_STATE
      || (logPath ? path.join(path.dirname(logPath), 'model-router-state.json') : ''),
  ).trim();
  const codex = resolveCodexCommand();

  let fallbackReason = 'local_model_not_configured';
  let localResult = null;
  const cooldown = readCooldown(statePath);

  if (localModel && !cooldown) {
    try {
      const tags = await fetchModelTags(localBaseUrl);
      if (isRequestedModelAvailable(tags, localModel)) {
        const localArgs = buildRoutedArguments(originalArgs, 'ollama', localModel);
        localResult = await runProcess(
          codex.command,
          [...codex.prefixArgs, ...localArgs],
          prompt,
          localTimeoutMs,
        );
        if (isSuccessfulRun(localResult)) {
          clearCooldown(statePath);
          appendRouteLog(logPath, {
            route: 'local',
            model: localModel,
            durationMs: localResult.durationMs,
          });
          process.stdout.write(localResult.stdout);
          return;
        }
        fallbackReason = summarizeFailure(localResult);
        writeCooldown(statePath, fallbackReason, cooldownMs);
      } else {
        fallbackReason = 'local_model_unavailable';
      }
    } catch (error) {
      fallbackReason = `local_health_error:${error.name || 'error'}`;
    }
  } else if (cooldown) {
    fallbackReason = `local_cooldown:${cooldown.reason || 'previous_failure'}`;
  }

  const fallbackArgs = buildRoutedArguments(originalArgs, 'openai', fallbackModel);
  const fallbackResult = await runProcess(
    codex.command,
    [...codex.prefixArgs, ...fallbackArgs],
    prompt,
    fallbackTimeoutMs,
  );
  appendRouteLog(logPath, {
    route: 'fallback',
    model: fallbackModel,
    reason: fallbackReason,
    localDurationMs: localResult ? localResult.durationMs : 0,
    durationMs: fallbackResult.durationMs,
    success: isSuccessfulRun(fallbackResult),
  });
  process.stdout.write(fallbackResult.stdout);
  if (!isSuccessfulRun(fallbackResult)) {
    const details = [
      `BabyNote local route failed (${fallbackReason}).`,
      `Fallback failed (${summarizeFailure(fallbackResult)}).`,
      localResult && localResult.stderr,
      fallbackResult.stderr,
    ].filter(Boolean).join('\n');
    process.stderr.write(`${details}\n`);
    process.exitCode = fallbackResult.code || 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`BabyNote model router failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
