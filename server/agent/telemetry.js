import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const context = new AsyncLocalStorage();
export function initTelemetry(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_requests (
    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
    baby_id INTEGER NOT NULL, channel TEXT NOT NULL, question TEXT NOT NULL,
    status TEXT NOT NULL, reply TEXT, error TEXT, duration_ms INTEGER,
    attempts_json TEXT NOT NULL DEFAULT '[]'
  ); CREATE INDEX IF NOT EXISTS agent_requests_started ON agent_requests(baby_id, started_at DESC);`);
}
function persist(trace) {
  try {
    trace.db.prepare(`INSERT INTO agent_requests VALUES (@id,@started_at,@finished_at,@baby_id,@channel,@question,@status,@reply,@error,@duration_ms,@attempts_json)
      ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at,status=excluded.status,reply=excluded.reply,error=excluded.error,duration_ms=excluded.duration_ms,attempts_json=excluded.attempts_json`)
      .run({ ...trace.row, attempts_json: JSON.stringify(trace.attempts) });
  } catch (error) { console.error('[Agent telemetry]', error.message); }
}
export async function traceRequest(db, metadata, action) {
  initTelemetry(db);
  const trace = { db, attempts: [], row: {
    id: randomUUID(), started_at: new Date().toISOString(), finished_at: null,
    baby_id: Number(metadata.babyId || 3), channel: metadata.channel,
    question: metadata.question, status: 'running', reply: null, error: null, duration_ms: null,
  } };
  persist(trace);
  return context.run({ trace }, async () => {
    try {
      const result = await action();
      const turn = result?.result || result;
      trace.row.reply = turn?.reply || '';
      trace.row.status = turn?.toolResult?.ok === false ? 'error' : 'success';
      trace.row.error = turn?.toolResult?.ok === false ? String(turn.toolResult.error || '工具执行失败') : null;
      return result;
    } catch (error) {
      trace.row.status = 'error'; trace.row.error = String(error.message || error); throw error;
    } finally {
      trace.row.finished_at = new Date().toISOString();
      trace.row.duration_ms = Date.now() - Date.parse(trace.row.started_at);
      persist(trace);
    }
  });
}
export function recordModelUsage(payload) {
  const state = context.getStore();
  if (!state?.attempt) return;
  state.attempt.calls.push({
    input_tokens: Number.isFinite(payload.prompt_eval_count) ? payload.prompt_eval_count : null,
    output_tokens: Number.isFinite(payload.eval_count) ? payload.eval_count : null,
  });
  persist(state.trace);
}
export function recordTool(name, args, result) {
  const state = context.getStore();
  if (!state?.attempt) return;
  Object.assign(state.attempt, { tool: name, arguments: args, result });
  (state.attempt.tools ||= []).push({ name, arguments: args, result });
  persist(state.trace);
}
export async function traceAttempt(metadata, action) {
  const state = context.getStore();
  if (!state) return action();
  const attempt = { ...metadata, status: 'running', calls: [], started_at: new Date().toISOString() };
  state.trace.attempts.push(attempt); persist(state.trace);
  return context.run({ ...state, attempt }, async () => {
    try {
      const result = await action();
      Object.assign(attempt, { status: 'success', tool: result.toolName || null,
        arguments: result.toolArguments, result: result.toolResult });
      if (metadata.provider === 'cloud') attempt.calls.push({
        input_tokens: result.usage?.input_tokens ?? null, output_tokens: result.usage?.output_tokens ?? null,
      });
      return result;
    } catch (error) {
      attempt.status = 'error'; attempt.error = String(error.message || error); throw error;
    } finally {
      attempt.duration_ms = Date.now() - Date.parse(attempt.started_at); persist(state.trace);
    }
  });
}
export function readDashboard(db, query = {}) {
  initTelemetry(db);
  const days = Math.min(90, Math.max(1, Number.parseInt(query.days, 10) || 7));
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const babyId = Number(query.baby_id || 3);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare('SELECT * FROM agent_requests WHERE baby_id=? AND started_at>=? ORDER BY started_at DESC').all(babyId, since)
    .map(({ attempts_json, ...row }) => {
      const attempts = JSON.parse(attempts_json);
      const calls = attempts.flatMap(a => a.calls);
      return { ...row, attempts, model: attempts.at(-1)?.model || null,
        input_tokens: calls.reduce((n,c) => n + (c.input_tokens || 0), 0),
        output_tokens: calls.reduce((n,c) => n + (c.output_tokens || 0), 0),
        usage_complete: calls.every(c => c.input_tokens != null && c.output_tokens != null) && !attempts.some(a => a.status !== 'success'),
        fallback: attempts.some(a => a.provider !== attempts[0].provider),
      };
    }).filter(row => (!query.channel || row.channel === query.channel)
      && (!query.status || row.status === query.status)
      && (!query.q || `${row.question}\n${row.reply || ''}`.toLowerCase().includes(String(query.q).toLowerCase())));
  const summary = rows.reduce((s,r) => ({ requests: s.requests + 1,
    input_tokens: s.input_tokens + r.input_tokens, output_tokens: s.output_tokens + r.output_tokens,
    errors: s.errors + Number(r.status === 'error'), fallbacks: s.fallbacks + Number(r.fallback),
    incomplete_usage: s.incomplete_usage + Number(!r.usage_complete),
  }), { requests: 0, input_tokens: 0, output_tokens: 0, errors: 0, fallbacks: 0, incomplete_usage: 0 });
  return { summary, page, page_size: 20, total: rows.length, items: rows.slice((page - 1) * 20, page * 20) };
}
