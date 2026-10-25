#!/usr/bin/env node
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

import { initDb } from '../db.js';
import { createAgentService } from './domain.js';
import { runLocalTurn } from './babynote-agent.js';

const FIXED_NOW = new Date('2026-08-29T12:00:00.000Z');
const MODEL = String(process.env.BABYNOTE_LOCAL_MODEL || 'qwen3.5:9b');
const THINK = String(process.env.BABYNOTE_LOCAL_THINK || 'none');
const REPEATS = Math.max(1, Number.parseInt(process.env.BABYNOTE_EVAL_REPEATS || '1', 10) || 1);
const BASE_ENVIRONMENT = {
  ...process.env,
  BABYNOTE_AGENT_BABY_ID: '3',
  BABYNOTE_LOCAL_MODEL: MODEL,
  BABYNOTE_LOCAL_THINK: THINK,
  BABYNOTE_LOCAL_BASE_URL: process.env.BABYNOTE_LOCAL_BASE_URL || 'http://127.0.0.1:11434',
  BABYNOTE_LOCAL_TIMEOUT_MS: process.env.BABYNOTE_LOCAL_TIMEOUT_MS || '120000',
  CC_PLATFORM: 'xiaoai',
  CC_SESSION_KEY: 'xiaoai:harness:speaker-3',
};

function seedBaby(database) {
  database.prepare(`INSERT INTO babies (id, name, birthdate) VALUES (3, '测试宝宝', '2025-01-01')`).run();
}

function seedMilk(database) {
  database.prepare(`
    INSERT INTO records (baby_id, type, created_at, feeding_type, amount_ml)
    VALUES (3, 'feeding', '2026-08-29T01:00:00.000Z', 'bottle', 120),
           (3, 'feeding', '2026-08-29T05:00:00.000Z', 'bottle', 80)
  `).run();
}

function seedCompletedSleep(database) {
  database.prepare(`
    INSERT INTO records (baby_id, type, created_at, sleep_start, sleep_end)
    VALUES (3, 'sleep', '2026-08-29T02:00:00.000Z', '2026-08-29T02:00:00.000Z', '2026-08-29T04:00:00.000Z')
  `).run();
}

function seedOpenSleep(database) {
  database.prepare(`
    INSERT INTO records (baby_id, type, created_at, sleep_start, sleep_end)
    VALUES (3, 'sleep', '2026-08-29T11:50:00.000Z', '2026-08-29T11:50:00.000Z', NULL)
  `).run();
}

function seedMealPlan(database) {
  database.prepare(`
    INSERT INTO meal_plans (baby_id, plan_date, items_json, note)
    VALUES (3, '2026-08-29', '[{"name":"南瓜泥","amount":"两勺"}]', '午餐')
  `).run();
}

function expectTool(name, args = {}) {
  return ({ result }) => {
    assert.equal(result.toolName, name);
    for (const [key, value] of Object.entries(args)) assert.deepEqual(result.toolArguments?.[key], value);
  };
}

function expectSuccessfulTool(name, args = {}) {
  return compose(expectTool(name, args), ({ result }) => {
    assert.notEqual(result.toolResult?.ok, false, `tool ${name} returned an error`);
  });
}

function expectReply(pattern) {
  return ({ result }) => assert.match(result.reply, pattern);
}

function compose(...checks) {
  return (context) => checks.forEach((check) => check(context));
}

const CASES = [
  { id: 'milk_digits', text: '刚喂了150毫升奶', expect: expectTool('record_milk', { amount_ml: 150 }) },
  { id: 'milk_chinese', text: '宝宝喝奶一百三', expect: expectTool('record_milk', { amount_ml: 130 }) },
  { id: 'milk_voice_hint', text: '[语音播报模式：请用口语回答] 宝宝喝奶130ml', expect: expectTool('record_milk', { amount_ml: 130 }) },
  { id: 'milk_relative_time', text: '大概15分钟前喂了90ml', expect: expectTool('record_milk', { amount_ml: 90 }) },
  { id: 'milk_missing_amount', text: '宝宝喝奶了', expect: compose(expectTool(null), expectReply(/多少|毫升|奶量/)) },
  {
    id: 'latest_feeding',
    text: '上顿奶是几点喝的？',
    seed: seedMilk,
    expect: compose(expectTool('get_latest_feeding'), expectReply(/13:00|80/)),
  },
  {
    id: 'today_total',
    text: '今天总共喝了多少奶？',
    seed: seedMilk,
    expect: compose(expectTool('get_summary'), expectReply(/200/)),
  },
  {
    id: 'today_feed_count',
    text: '宝宝今天喂奶几次？',
    seed: seedMilk,
    expect: compose(expectTool('get_summary'), expectReply(/2|两|次/)),
  },
  {
    id: 'today_mixed_summary',
    text: '帮我看下今天奶量、睡眠和辅食情况',
    seed: (database) => { seedMilk(database); seedCompletedSleep(database); },
    expect: expectTool('get_summary'),
  },
  {
    id: 'recent_days_total',
    text: '过去3天奶量汇总一下',
    seed: seedMilk,
    expect: compose(
      expectTool('get_summary', { start_date: '2026-08-27', end_date: '2026-08-29' }),
      expectReply(/200/),
    ),
  },
  {
    id: 'latest_wake',
    text: '宝宝上次醒来是几点？现在醒了多久？',
    seed: seedCompletedSleep,
    expect: compose(expectTool('get_latest_wake'), expectReply(/12:00|4小时/)),
  },
  {
    id: 'awake_duration_variant',
    text: '宝宝现在醒了多长时间？',
    seed: seedCompletedSleep,
    expect: compose(expectTool('get_latest_wake'), expectReply(/醒|小时|分钟/)),
  },
  {
    id: 'sleep_duration',
    text: '今天宝宝睡了多长时间？',
    seed: seedCompletedSleep,
    expect: compose(expectTool('get_summary'), expectReply(/2小时|120/)),
  },
  { id: 'sleep_start_now', text: '宝宝刚睡着啦', expect: expectTool('start_sleep') },
  { id: 'sleep_start_relative', text: '大约10分钟前睡着了', expect: expectTool('start_sleep', { time_text: '10分钟前' }) },
  { id: 'sleep_start_hours', text: '宝宝两小时前睡着了', expect: expectSuccessfulTool('start_sleep') },
  {
    id: 'wake_now',
    text: '宝宝醒啦',
    seed: seedOpenSleep,
    expect: compose(expectTool('end_sleep', { time_text: undefined }), expectReply(/醒|记录/)),
  },
  {
    id: 'wake_relative',
    text: '宝宝大概5分钟前醒的',
    seed: seedOpenSleep,
    expect: expectTool('end_sleep', { time_text: '5分钟前' }),
  },
  {
    id: 'solid_basic',
    text: '吃了苹果20克和蛋黄半个',
    expect: ({ result }) => {
      assert.equal(result.toolName, 'record_solid_meal');
      assert.deepEqual(result.toolArguments.items.map((item) => [item.name, item.amount, item.unit]), [
        ['苹果', 20, '克'],
        ['蛋黄', 0.5, '克'],
      ]);
    },
  },
  {
    id: 'solid_fraction',
    text: '刚刚吃了南瓜30克和四分之一个蛋黄',
    expect: ({ result }) => {
      assert.equal(result.toolName, 'record_solid_meal');
      assert.equal(result.toolArguments.items.find((item) => item.name === '蛋黄')?.amount, 0.25);
    },
  },
  {
    id: 'solid_three_items',
    text: '辅食十五克胡萝卜十五颗米的三十克三文鱼',
    expect: ({ result }) => {
      assert.equal(result.toolName, 'record_solid_meal');
      assert.deepEqual(result.toolArguments.items.map((item) => [item.name, item.amount, item.unit]), [
        ['胡萝卜', 15, '克'],
        ['米', 15, '克'],
        ['三文鱼', 30, '克'],
      ]);
    },
  },
  {
    id: 'solid_natural_units',
    text: '香蕉半根和米粉两勺',
    expect: expectSuccessfulTool('record_solid_meal'),
  },
  {
    id: 'solid_decimal_units',
    text: '苹果1.5克和蛋黄0.5个',
    expect: expectSuccessfulTool('record_solid_meal'),
  },
  { id: 'solid_missing_amount', text: '吃了西兰花和鸡肉', expect: compose(expectTool(null), expectReply(/多少|用量|几克|几勺/)) },
  { id: 'solid_ambiguous_amount', text: '辅食10克胡萝卜和米粉', expect: compose(expectTool(null), expectReply(/对应|用量|说清楚|多少/)) },
  {
    id: 'meal_plan',
    text: '今天的辅食计划是什么？',
    seed: seedMealPlan,
    expect: compose(expectTool('get_meal_plan'), expectReply(/南瓜/)),
  },
  {
    id: 'daily_reminder',
    text: '给我生成今天的辅食提醒',
    seed: seedMealPlan,
    expect: expectSuccessfulTool('build_daily_reminder'),
  },
  {
    id: 'today_solid_summary',
    text: '今天宝宝吃了哪些辅食？',
    seed: seedMealPlan,
    expect: expectTool('get_summary'),
  },
  { id: 'ordinary_chatter', text: '宝宝今天真可爱呀', expect: compose(expectTool(null), expectReply(/宝宝|可爱|呀/)) },
  {
    id: 'unrelated_chatter',
    text: '你好，辛苦啦',
    expect: ({ result }) => {
      assert.equal(result.toolName, null);
      assert.doesNotMatch(result.reply, /已记录|查询到|总共喝|睡了\d/);
    },
  },
  {
    id: 'safety_no_tool',
    text: '宝宝呼吸有点困难',
    expect: ({ result }) => {
      assert.equal(result.toolName, null);
      assert.match(result.reply, /急救|医生|医院|呼吸/);
    },
  },
  { id: 'multiple_actions', text: '喝了120毫升奶然后睡着了', expect: compose(expectTool(null), expectReply(/拆成两条/)) },
  {
    id: 'context_followup',
    text: '那上次是什么时候？',
    history: [
      { role: 'user', content: '宝宝喝奶一百三' },
      { role: 'assistant', content: '已记录宝宝喝奶130毫升。' },
    ],
    seed: seedMilk,
    expect: compose(expectTool('get_latest_feeding'), expectReply(/13:00|80/)),
  },
];

async function runCase(testCase, index) {
  const database = new Database(':memory:');
  initDb(database);
  seedBaby(database);
  testCase.seed?.(database);
  const service = createAgentService(database, { now: () => new Date(FIXED_NOW) });
  const calls = [];
  const startedAt = performance.now();
  try {
    const result = await runLocalTurn({
      prompt: `[cc-connect source_channel=xiaoai source_message_id=harness-${index}] ${testCase.text}`,
      service,
      history: testCase.history || [],
      environment: BASE_ENVIRONMENT,
      now: FIXED_NOW,
      fetchImpl: async (url, init) => {
        const request = JSON.parse(init.body);
        calls.push({ message: request.messages.at(-1)?.content, think: request.think });
        return fetch(url, init);
      },
    });
    await testCase.expect({ result, database });
    return {
      id: testCase.id,
      ok: true,
      tool: result.toolName,
      calls: calls.length,
      duration_ms: Math.round(performance.now() - startedAt),
      reply: result.reply,
    };
  } catch (error) {
    return {
      id: testCase.id,
      ok: false,
      calls: calls.length,
      duration_ms: Math.round(performance.now() - startedAt),
      error: error.message,
    };
  } finally {
    database.close();
  }
}

const report = [];
for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
  for (let index = 0; index < CASES.length; index += 1) {
    const result = await runCase(CASES[index], `${repeat}-${index}`);
    report.push({ repeat, ...result });
    if (!result.ok) process.stderr.write(`[harness] FAIL repeat=${repeat} ${result.id}: ${result.error}\n`);
  }
}

const passed = report.filter((result) => result.ok).length;
const failures = report.filter((result) => !result.ok);
const repaired = report.filter((result) => result.ok && result.calls > 2).length;
process.stdout.write(`${JSON.stringify({
  ok: passed === report.length,
  model: MODEL,
  think: THINK,
  repeats: REPEATS,
  total: report.length,
  passed,
  failed: report.length - passed,
  pass_rate: report.length ? Number((passed / report.length).toFixed(4)) : 0,
  repaired_turns: repaired,
  average_duration_ms: report.length
    ? Math.round(report.reduce((sum, result) => sum + result.duration_ms, 0) / report.length)
    : 0,
  failures,
}, null, 2)}\n`);
if (passed !== report.length) process.exitCode = 1;
