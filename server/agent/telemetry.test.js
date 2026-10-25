import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { traceRequest, traceAttempt, recordModelUsage, readDashboard } from './telemetry.js';
import { runLocalTurn } from './babynote-agent.js';

test('captures actual retry usage and persists question and reply', async () => {
  const db = new Database(':memory:');
  try {
    let calls = 0;
    await traceRequest(db, { babyId: 3, channel: 'xiaoai', question: '你好' }, () => runLocalTurn({
      prompt: '你好', service: {}, environment: {}, fetchImpl: async () => new Response(JSON.stringify({
        message: { content: ++calls === 1 ? '' : '你好呀' }, prompt_eval_count: 100, eval_count: 20,
      })),
    }));
    const result = readDashboard(db);
    assert.equal(result.summary.input_tokens, 200);
    assert.equal(result.summary.output_tokens, 40);
    assert.equal(result.items[0].reply, '你好呀');
    assert.equal(result.items[0].attempts[0].calls.length, 2);
  } finally { db.close(); }
});
test('captures fallback, errors, filters and concurrent request isolation', async () => {
  const db = new Database(':memory:');
  try {
    await Promise.all([traceRequest(db, { babyId: 3, channel: 'weixin', question: '奶量' }, async () => {
      try { await traceAttempt({ provider: 'local', model: 'qwen' }, async () => { throw new Error('offline'); }); } catch {}
      return traceAttempt({ provider: 'cloud', model: 'cloud' }, async () => ({ reply: '已查询', usage: { input_tokens: 12, output_tokens: 3 } }));
    }), traceRequest(db, { babyId: 4, channel: 'xiaoai', question: '其他宝宝' }, () => traceAttempt({ provider: 'local', model: 'qwen' }, async () => {
      await new Promise(resolve => setImmediate(resolve));
      recordModelUsage({ prompt_eval_count: 99, eval_count: 9 });
      return { reply: '独立回复' };
    }))]);
    const result = readDashboard(db, { channel: 'weixin', q: '奶量' });
    assert.equal(result.total, 1);
    assert.equal(result.summary.input_tokens, 12);
    assert.equal(result.summary.fallbacks, 1);
    assert.equal(result.summary.incomplete_usage, 1);
    assert.equal(result.items[0].attempts[0].error, 'offline');
    await assert.rejects(traceRequest(db, { channel: 'xiaoai', question: '失败' }, async () => { throw new Error('timeout'); }));
    assert.equal(readDashboard(db, { status: 'error' }).items[0].error, 'timeout');
    assert.equal(readDashboard(db, { baby_id: 4 }).summary.input_tokens, 99);
  } finally { db.close(); }
});
