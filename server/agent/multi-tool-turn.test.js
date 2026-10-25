import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initDb } from '../db.js';
import { createAgentService } from './domain.js';
import { runMultiToolTurn } from './multi-tool-turn.js';
const tool = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const model = (...calls) => ({ message: { role: 'assistant', content: null, tool_calls: calls }, prompt_eval_count: 1, eval_count: 1 });

test('growth and historical foods can be recorded together then read back', async () => {
  const db = new Database(':memory:');
  initDb(db);
  db.prepare('INSERT INTO babies (id,name,birthdate) VALUES (3,?,?)').run('测试', '2026-02-04');
  let round = 0;
  try {
    const result = await runMultiToolTurn({ prompt: '身长72.5厘米，鸡肉已排敏，保存再查询档案', service: createAgentService(db),
      modelCall: async () => {
        if (++round === 1) return model(tool('growth', 'record_growth', { height_cm: 72.5 }),
          tool('foods', 'set_food_status', { items: [{ name: '鸡肉', status: 'confirmed_safe' }] }));
        if (round === 2) return model(tool('profile', 'get_baby_profile'));
        return { message: { content: '身长和排敏状态已保存。' } };
      } });
    assert.equal(result.toolCalls.length, 3);
    assert.ok(result.toolCalls.every(call => call.result.ok));
    assert.equal(result.toolResult.latest_height.height_cm, 72.5);
    assert.equal(result.toolResult.foods[0].manual_status, 'confirmed_safe');
  } finally { db.close(); }
});

test('multiple writes and subsequent reads share a request without duplicate writes on replay', async () => {
  const db = new Database(':memory:');
  initDb(db);
  db.prepare('INSERT INTO babies (id,name,birthdate) VALUES (3,?,?)').run('测试', '2026-02-04');
  const service = createAgentService(db);
  const run = async () => {
    let round = 0;
    return runMultiToolTurn({ prompt: '[cc-connect source_message_id=multi-test source_channel=weixin] 刚喝了130毫升奶，刚睡着了，再查下今天汇总', service,
      modelCall: async messages => {
        round++;
        if (round === 1) return model(tool('milk', 'record_milk', { amount_ml: 130 }), tool('sleep', 'start_sleep'));
        if (round === 2) {
          assert.equal(messages.at(-1).tool_call_id, 'sleep');
          return model(tool('duplicate', 'record_milk', { amount_ml: 130 }), tool('summary', 'get_summary'));
        }
        return { message: { role: 'assistant', content: '已记录喝奶和入睡，今天喝了130毫升奶。' } };
      },
    });
  };
  try {
    const result = await run();
    assert.equal(result.toolCalls.length, 4);
    assert.ok(result.toolCalls.every(t => t.result.ok));
    assert.equal(result.toolCalls[2].result.idempotent_replay, true);
    await run();
    assert.equal(db.prepare('SELECT count(*) count FROM records').get().count, 2);
  } finally { db.close(); }
});

test('a failing tool returns its error to the model and later reads can complete', async () => {
  let round = 0;
  const result = await runMultiToolTurn({ prompt: '记录奶量并查睡醒时间', service: {
    recordMilk: () => { throw new Error('缺少奶量'); }, getLatestWake: () => ({ ok: true, found: false }),
  }, modelCall: async messages => {
    if (++round === 1) return model(tool('milk', 'record_milk'), tool('wake', 'get_latest_wake'));
    assert.match(messages.at(-2).content, /缺少奶量/);
    return { message: { content: '奶量记录失败：缺少奶量。没有找到睡醒记录。' } };
  } });
  assert.equal(result.toolResult.ok, false);
  assert.equal(result.toolCalls.length, 2);
});
