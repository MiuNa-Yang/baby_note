import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initDb } from '../db.js';
import { AgentInputError, createAgentService, parseAgentTime } from './domain.js';

const FIXED_NOW = new Date('2026-08-16T12:00:00.000Z'); // 北京时间 20:00

test('growth records both measurements atomically and replays without duplicates', () => {
  const { database, service } = fixture();
  try {
    const input = { baby_id: 1, weight_kg: 9.9, height_cm: 72.5 };
    const context = { source_channel: 'test', source_message_id: 'growth-1' };
    service.recordGrowth(input, context);
    assert.equal(service.recordGrowth(input, context).idempotent_replay, true);
    const profile = service.getBabyProfile({ baby_id: 1 });
    assert.equal(profile.latest_weight.weight_kg, 9.9);
    assert.equal(profile.latest_height.height_cm, 72.5);
    assert.equal(service.getGrowthHistory({ baby_id: 1 }).records.length, 2);
    assert.equal(database.prepare('SELECT count(*) n FROM record_audit_events').get().n, 2);
    assert.throws(() => service.recordGrowth({ baby_id: 1, weight_kg: 10, height_cm: -1 }));
    assert.throws(() => service.recordGrowth({ baby_id: 1 }));
    assert.throws(() => service.getBabyProfile({ baby_id: 999 }));
    assert.equal(service.getGrowthHistory({ baby_id: 1 }).records.length, 2);
  } finally { database.close(); }
});

test('historical food status does not invent meals or infer related foods', () => {
  const { database, service } = fixture();
  try {
    const input = { baby_id: 1, items: ['西蓝花', '核桃油', '五谷粉'].map(name => ({ name, status: 'confirmed_safe' })) };
    const context = { source_channel: 'test', source_message_id: 'foods-1' };
    service.setFoodStatus(input, context);
    assert.equal(service.setFoodStatus(input, context).idempotent_replay, true);
    service.setFoodStatus({ baby_id: 1, items: [{ name: '西兰花', status: 'confirmed_allergy' }] });
    const foods = service.listSolidFoods({ baby_id: 1 }).foods;
    assert.equal(foods.length, 3);
    assert.equal(foods.find(f => f.name === '西兰花').manual_status, 'confirmed_allergy');
    assert.equal(foods.some(f => f.name === '核桃'), false);
    assert.equal(service.getBabyProfile({ baby_id: 1 }).confirmed_safe_count, 2);
    assert.equal(database.prepare('SELECT count(*) n FROM records').get().n, 0);
    assert.throws(() => service.setFoodStatus({ baby_id: 1, items: [{ name: '鸡肉', status: 'confirmed_safe' }, { name: '牛肉', status: 'bad' }] }));
    assert.equal(service.listSolidFoods({ baby_id: 1 }).foods.length, 3);
  } finally { database.close(); }
});

function fixture() {
  const database = new Database(':memory:');
  initDb(database);
  database.prepare(`INSERT INTO babies (id, name, birthdate) VALUES (1, '宝宝', '2025-01-01')`).run();
  return {
    database,
    service: createAgentService(database, { now: () => new Date(FIXED_NOW) }),
  };
}

test('parseAgentTime parses relative and Chinese clock expressions', () => {
  assert.equal(parseAgentTime('刚刚', FIXED_NOW), FIXED_NOW.toISOString());
  assert.equal(parseAgentTime('20分钟前', FIXED_NOW), '2026-08-16T11:40:00.000Z');
  assert.equal(parseAgentTime('两小时前', FIXED_NOW), '2026-08-16T10:00:00.000Z');
  assert.equal(parseAgentTime('半小时前', FIXED_NOW), '2026-08-16T11:30:00.000Z');
  assert.equal(parseAgentTime('3天前', FIXED_NOW), '2026-08-13T12:00:00.000Z');
  assert.equal(parseAgentTime('下午2点半', FIXED_NOW), '2026-08-16T06:30:00.000Z');
  assert.throws(() => parseAgentTime('晚上10点', FIXED_NOW), error => error instanceof AgentInputError && error.code === 'future_time');
});

test('milk writes are durable and idempotent by bridge message id', () => {
  const { database, service } = fixture();
  const context = { source_channel: 'weixin', source_message_id: 'msg-1', source_chat_id: 'group@chatroom' };
  const first = service.recordMilk({ baby_id: 1, amount_ml: 160, time_text: '刚刚', source_text: '刚喝了160' }, context);
  const replay = service.recordMilk({ baby_id: 1, amount_ml: 160, time_text: '刚刚', source_text: '刚喝了160' }, context);
  assert.equal(first.amount_ml, 160);
  assert.equal(first.occurred_at_beijing, '2026-08-16 20:00:00');
  assert.equal(replay.idempotent_replay, true);
  assert.equal(database.prepare(`SELECT COUNT(*) count FROM records WHERE type = 'feeding'`).get().count, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) count FROM record_audit_events`).get().count, 1);
  database.close();
});

test('one source message cannot perform two different mutations', () => {
  const { database, service } = fixture();
  const context = { source_channel: 'weixin', source_message_id: 'msg-2' };
  service.recordMilk({ baby_id: 1, amount_ml: 120 }, context);
  assert.throws(
    () => service.startSleep({ baby_id: 1 }, context),
    error => error instanceof AgentInputError && error.code === 'multiple_mutations',
  );
  database.close();
});

test('sleep start and end update one open record', () => {
  const { database, service } = fixture();
  const started = service.startSleep(
    { baby_id: 1, time_text: '下午2点' },
    { source_channel: 'weixin', source_message_id: 'sleep-start' },
  );
  const ended = service.endSleep(
    { baby_id: 1, time_text: '下午3点' },
    { source_channel: 'weixin', source_message_id: 'sleep-end' },
  );
  assert.equal(started.record_id, ended.record_id);
  assert.equal(ended.duration_minutes, 60);
  assert.equal(database.prepare('SELECT sleep_end FROM records WHERE id = ?').get(started.record_id).sleep_end, '2026-08-16T07:00:00.000Z');
  database.close();
});

test('latest feeding and wake queries return exact times and elapsed durations', () => {
  const { database, service } = fixture();
  database.prepare(`
    INSERT INTO records (baby_id, type, created_at, feeding_type, amount_ml)
    VALUES (1, 'feeding', ?, 'bottle', ?)
  `).run('2026-08-16T10:00:00.000Z', 120);
  database.prepare(`
    INSERT INTO records (baby_id, type, created_at, feeding_type, amount_ml)
    VALUES (1, 'feeding', ?, 'bottle', ?)
  `).run('2026-08-16T11:30:00.000Z', 180);
  database.prepare(`
    INSERT INTO records (baby_id, type, created_at, sleep_start, sleep_end)
    VALUES (1, 'sleep', ?, ?, ?)
  `).run(
    '2026-08-16T08:00:00.000Z',
    '2026-08-16T08:00:00.000Z',
    '2026-08-16T09:00:00.000Z',
  );

  const feeding = service.getLatestFeeding({ baby_id: 1 });
  assert.equal(feeding.found, true);
  assert.equal(feeding.amount_ml, 180);
  assert.equal(feeding.occurred_at, '2026-08-16T11:30:00.000Z');
  assert.equal(feeding.occurred_at_beijing, '2026-08-16 19:30:00');
  assert.equal(feeding.minutes_ago, 30);
  assert.equal(feeding.elapsed_text, '30分钟');

  const wake = service.getLatestWake({ baby_id: 1 });
  assert.equal(wake.found, true);
  assert.equal(wake.woke_at, '2026-08-16T09:00:00.000Z');
  assert.equal(wake.woke_at_beijing, '2026-08-16 17:00:00');
  assert.equal(wake.awake_minutes, 180);
  assert.equal(wake.awake_text, '3小时');
  assert.equal(wake.sleep_duration_minutes, 60);
  assert.equal(wake.currently_sleeping, false);
  database.close();
});

test('solid meals and today summary preserve flexible units', () => {
  const { database, service } = fixture();
  service.recordMilk(
    { baby_id: 1, amount_ml: 150 },
    { source_channel: 'weixin', source_message_id: 'milk-summary' },
  );
  service.recordSolidMeal(
    {
      baby_id: 1,
      items: [
        { name: '南瓜', amount: 30, unit: 'g' },
        { name: '蛋黄', amount: 0.25, unit: '个' },
      ],
    },
    { source_channel: 'weixin', source_message_id: 'solid-summary' },
  );
  const summary = service.getTodaySummary({ baby_id: 1 });
  assert.equal(summary.milk.total_ml, 150);
  assert.equal(summary.solids.meals, 1);
  assert.equal(summary.solids.items[0].grams, 30);
  assert.equal(summary.solids.items[1].quantity_text, '0.25个');
  database.close();
});

test('solid meal input without a unit defaults to grams', () => {
  const { database, service } = fixture();
  const result = service.recordSolidMeal(
    { baby_id: 1, items: [{ name: '米粉', amount: 25 }] },
    { source_channel: 'xiaoai', source_message_id: 'solid-grams' },
  );
  assert.equal(result.occurred_at_beijing, '2026-08-16 20:00:00');
  assert.deepEqual(result.items.map((item) => ({ amount: item.amount, unit: item.unit, grams: item.grams, quantity_text: item.quantity_text })), [
    { amount: 25, unit: '克', grams: 25, quantity_text: '25克' },
  ]);
  database.close();
});

test('period summary defaults to one day and aggregates an inclusive range by Beijing date', () => {
  const { database, service } = fixture();
  const insertMilk = database.prepare(`
    INSERT INTO records (baby_id, type, created_at, feeding_type, amount_ml)
    VALUES (1, 'feeding', ?, 'bottle', ?)
  `);
  insertMilk.run('2026-08-10T02:00:00.000Z', 100);
  insertMilk.run('2026-08-12T03:00:00.000Z', 200);
  insertMilk.run('2026-08-16T05:00:00.000Z', 50);
  database.prepare(`
    INSERT INTO records (baby_id, type, created_at, sleep_start, sleep_end)
    VALUES (1, 'sleep', ?, ?, ?)
  `).run('2026-08-11T15:30:00.000Z', '2026-08-11T15:30:00.000Z', '2026-08-11T17:30:00.000Z');

  const range = service.getPeriodSummary({
    baby_id: 1,
    start_date: '2026-08-10',
    end_date: '2026-08-16',
  });
  assert.equal(range.days, 7);
  assert.equal(range.start_date, '2026-08-10');
  assert.equal(range.end_date, '2026-08-16');
  assert.equal(range.milk.total_ml, 350);
  assert.equal(range.milk.avg_daily_ml, 50);
  assert.equal(range.milk.avg_per_feed_ml, 117);
  assert.equal(range.sleep.total_minutes, 120);
  assert.equal(range.daily.length, 7);
  assert.equal(range.daily.find((day) => day.date === '2026-08-10').milk.total_ml, 100);
  assert.equal(range.daily.find((day) => day.date === '2026-08-11').sleep.total_minutes, 30);
  assert.equal(range.daily.find((day) => day.date === '2026-08-12').sleep.total_minutes, 90);

  const oneDay = service.getPeriodSummary({ baby_id: 1, date: '2026-08-16' });
  assert.equal(oneDay.days, 1);
  assert.equal(oneDay.milk.total_ml, 50);
  assert.throws(
    () => service.getPeriodSummary({ baby_id: 1, start_date: '2026-01-01', end_date: '2026-02-01' }),
    error => error instanceof AgentInputError && error.code === 'date_range_too_large',
  );
  database.close();
});

test('meal plans round-trip and build the daily reminder', () => {
  const { database, service } = fixture();
  service.saveMealPlan({
    baby_id: 1,
    date: '2026-08-16',
    items: [{ name: '南瓜', amount: 20, unit: 'g' }, { name: '蛋黄', amount: 0.25, unit: '个' }],
    note: '蛋黄试敏第 1 天',
  });
  const reminder = service.buildDailyReminder({ baby_id: 1, date: '2026-08-16' });
  assert.equal(reminder.has_plan, true);
  assert.match(reminder.message, /南瓜 20g/);
  assert.match(reminder.message, /蛋黄 0.25个/);
  assert.match(reminder.message, /试敏第 1 天/);
  database.close();
});
