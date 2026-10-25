#!/usr/bin/env node
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

import { initDb } from '../db.js';
import { createAgentService } from './domain.js';
import { runLocalTurn } from './babynote-agent.js';

const FIXED_NOW = new Date('2026-08-29T12:00:00.000Z');
const model = String(
  process.env.BABYNOTE_LOCAL_MODEL || 'qwen3.5:9b',
);
const baseEnvironment = {
  ...process.env,
  BABYNOTE_AGENT_BABY_ID: '3',
  BABYNOTE_LOCAL_MODEL: model,
  BABYNOTE_LOCAL_BASE_URL: process.env.BABYNOTE_LOCAL_BASE_URL || 'http://127.0.0.1:11434',
  BABYNOTE_LOCAL_TIMEOUT_MS: process.env.BABYNOTE_LOCAL_TIMEOUT_MS || '120000',
  CC_PLATFORM: 'weixin',
  CC_SESSION_KEY: 'weixin:eval-private:eval-parent',
};

const database = new Database(':memory:');
initDb(database);
database.prepare(`INSERT INTO babies (id, name, birthdate) VALUES (3, '测试宝宝', '2025-01-01')`).run();
const insertMilk = database.prepare(`
  INSERT INTO records (baby_id, type, created_at, feeding_type, amount_ml)
  VALUES (3, 'feeding', ?, 'bottle', ?)
`);
insertMilk.run('2026-08-29T01:00:00.000Z', 120);
insertMilk.run('2026-08-29T05:00:00.000Z', 80);
const service = createAgentService(database, { now: () => new Date(FIXED_NOW) });
const report = [];

async function evaluate(name, messageId, prompt, verify) {
  const startedAt = performance.now();
  const result = await runLocalTurn({
    prompt: `[cc-connect sender_id=eval-parent chat_id=eval-private] ${prompt}`,
    service,
    environment: { ...baseEnvironment, CC_MESSAGE_ID: messageId },
    now: FIXED_NOW,
  });
  await verify(result);
  report.push({
    name,
    passed: true,
    duration_ms: Math.round(performance.now() - startedAt),
    tool: result.toolName,
    ignored: result.ignored,
    tool_arguments: result.toolArguments || null,
    input_tokens: result.usage?.input_tokens || 0,
    output_tokens: result.usage?.output_tokens || 0,
  });
}

try {
  await evaluate('today_summary', 'eval-query', '今天宝宝喝了多少奶？', (result) => {
    assert.equal(result.toolName, 'get_summary');
    assert.match(result.reply, /200/);
  });
  await evaluate('recent_range_summary', 'eval-range-query', '最近7天宝宝奶量怎么样？', (result) => {
    assert.equal(result.toolName, 'get_summary');
    assert.deepEqual(result.toolArguments, {
      start_date: '2026-08-23',
      end_date: '2026-08-29',
    });
  });
  await evaluate('milk_write', 'eval-milk', '20分钟前喝了160毫升奶', (result) => {
    assert.equal(result.toolName, 'record_milk');
    assert.equal(result.toolResult.amount_ml, 160);
  });
  await evaluate('historical_voice_milk', 'eval-historical-milk', '宝宝喝奶一百三', (result) => {
    assert.equal(result.toolName, 'record_milk');
    assert.equal(result.toolResult.amount_ml, 130);
  });
  await evaluate('milk_idempotency', 'eval-milk', '20分钟前喝了160毫升奶', (result) => {
    assert.equal(result.toolName, 'record_milk');
    assert.equal(result.toolResult.idempotent_replay, true);
    assert.equal(database.prepare(`SELECT COUNT(*) count FROM records WHERE amount_ml = 160`).get().count, 1);
  });
  await evaluate('missing_solid_amount', 'eval-solid-missing', '吃了南瓜', (result) => {
    assert.equal(result.toolName, null);
    assert.match(result.reply, /多少|用量|几克|几勺/);
  });
  await evaluate('solid_units', 'eval-solid', '刚刚吃了南瓜30克和四分之一个蛋黄', (result) => {
    assert.equal(result.toolName, 'record_solid_meal');
    const items = JSON.parse(database.prepare(`
      SELECT solid_items_json FROM records WHERE type = 'solid_meal' ORDER BY id DESC LIMIT 1
    `).get().solid_items_json);
    assert.equal(items.find((item) => item.name === '南瓜')?.amount, 30);
    assert.equal(items.find((item) => item.name === '蛋黄')?.amount, 0.25);
  });
  await evaluate('historical_solid_phrase', 'eval-historical-solid', '辅食十五克胡萝卜十五颗米的三十克三文鱼', (result) => {
    assert.equal(result.toolName, 'record_solid_meal');
    assert.deepEqual(result.toolArguments.items.map((item) => [item.name, item.amount, item.unit]), [
      ['胡萝卜', 15, '克'],
      ['米', 15, '克'],
      ['三文鱼', 30, '克'],
    ]);
  });
  await evaluate('sleep_start', 'eval-sleep-start', '10分钟前睡着了', (result) => {
    assert.equal(result.toolName, 'start_sleep');
  });
  await evaluate('sleep_end', 'eval-sleep-end', '刚刚醒了', (result) => {
    assert.equal(result.toolName, 'end_sleep');
    assert.equal(result.toolResult.duration_minutes, 10);
  });
  await evaluate('semantic_chatter', 'eval-chatter', '宝宝今天真可爱', (result) => {
    assert.equal(result.ignored, false);
    assert.equal(result.toolName, null);
    assert.notEqual(result.reply, 'IGNORE');
  });
  await evaluate('obvious_chatter', 'eval-chatter-2', '你好呀，辛苦了', (result) => {
    assert.equal(result.ignored, false);
    assert.equal(result.toolName, null);
    assert.notEqual(result.reply, 'IGNORE');
    assert.ok((result.usage?.input_tokens || 0) > 0);
  });
  await evaluate('multiple_write_guard', 'eval-multiple', '喝了120毫升奶然后睡着了', (result) => {
    assert.equal(result.toolName, null);
    assert.match(result.reply, /拆成两条/);
  });
  process.stdout.write(`${JSON.stringify({ ok: true, model, cases: report }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, model, cases: report, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  database.close();
}
