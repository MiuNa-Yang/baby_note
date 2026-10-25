import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractIncomingPrompt,
  filterFallbackOutput,
  hasMultipleWriteIntents,
  isIgnoredReply,
  mightBeBabyNoteRequest,
  runLocalTurn,
} from './babynote-agent.js';

function response(message, prompt_eval_count = 100, eval_count = 20) {
  return new Response(JSON.stringify({ message, prompt_eval_count, eval_count }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function queuedFetch(messages) {
  const queue = [...messages];
  return async () => {
    assert.ok(queue.length, 'unexpected Ollama call');
    return response(queue.shift());
  };
}

test('extracts cc-connect metadata from a first-turn preamble', () => {
  const incoming = extractIncomingPrompt([
    'Before answering, follow these project-level instructions.',
    'User message:',
    '[cc-connect sender_id=user-1 chat_id=family@chatroom]',
    '刚喝了160毫升',
  ].join('\n'));
  assert.deepEqual(incoming, {
    metadata: { sender_id: 'user-1', chat_id: 'family@chatroom' },
    text: '刚喝了160毫升',
  });
});

test('strips the voice gateway transport hint before intent handling', () => {
  assert.deepEqual(
    extractIncomingPrompt('[cc-connect source_channel=xiaoai]\n[语音播报模式：请用口语回答] 宝宝喝奶一百三'),
    {
      metadata: { source_channel: 'xiaoai' },
      text: '宝宝喝奶一百三',
    },
  );
});

test('preserves API source metadata for BabyNote audit records', () => {
  const incoming = extractIncomingPrompt(
    '[cc-connect source_channel=xiaoai source_message_id=req-1 chat_id=speaker-1] 你好'
  );
  assert.deepEqual(incoming, {
    metadata: {
      source_channel: 'xiaoai',
      source_message_id: 'req-1',
      chat_id: 'speaker-1',
    },
    text: '你好',
  });
});

test('lets the model handle ordinary chatter', async () => {
  let called = 0;
  const fetchImpl = queuedFetch([{ role: 'assistant', content: '你好呀，今天也一起加油。' }]);
  const result = await runLocalTurn({
    prompt: '你好呀，辛苦了',
    service: {},
    fetchImpl: async (...args) => {
      called += 1;
      return fetchImpl(...args);
    },
  });
  assert.equal(result.ignored, false);
  assert.equal(result.toolName, null);
  assert.equal(result.reply, '你好呀，今天也一起加油。');
  assert.equal(called, 1);
  assert.equal(mightBeBabyNoteRequest('宝宝刚睡着'), true);
  assert.equal(mightBeBabyNoteRequest('近一个月呢，看下大趋势'), true);
  assert.equal(isIgnoredReply('IGNORE。'), true);
});

test('retries once when Ollama returns an empty model message', async () => {
  let calls = 0;
  const result = await runLocalTurn({
    prompt: '你好呀',
    service: {},
    fetchImpl: async () => {
      calls += 1;
      return response(calls === 1
        ? { role: 'assistant', content: '', thinking: 'temporary empty result' }
        : { role: 'assistant', content: '你好呀，今天也一起加油。' });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.reply, '你好呀，今天也一起加油。');
});

test('disables hidden thinking by default for short voice turns', async () => {
  let request;
  await runLocalTurn({
    prompt: '你好呀',
    service: {},
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return response({ role: 'assistant', content: '你好呀。' });
    },
  });
  assert.equal(request.think, false);
});

test('passes prior conversation turns to the local model', async () => {
  let request;
  const result = await runLocalTurn({
    prompt: '那你再说一遍',
    history: [
      { role: 'system', content: 'must be ignored' },
      { role: 'user', content: '宝宝刚醒了' },
      { role: 'assistant', content: '已按当前时间记录。' },
    ],
    service: {},
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return response({ role: 'assistant', content: '宝宝睡了2小时。' });
    },
  });
  assert.equal(result.reply, '宝宝睡了2小时。');
  assert.deepEqual(request.messages.slice(-3), [
    { role: 'user', content: '宝宝刚醒了' },
    { role: 'assistant', content: '已按当前时间记录。' },
    { role: 'user', content: '那你再说一遍' },
  ]);
});

test('rejects multiple write intents before any model or database call', async () => {
  let called = false;
  const result = await runLocalTurn({
    prompt: '宝宝喝了120毫升然后睡着了',
    service: {},
    fetchImpl: async () => { called = true; throw new Error('not expected'); },
  });
  assert.equal(hasMultipleWriteIntents('宝宝喝了120毫升然后睡着了'), true);
  assert.equal(called, false);
  assert.match(result.reply, /拆成两条/);
});

test('does not write a solid meal when spoken quantities do not map one-to-one to foods', async () => {
  let called = false;
  const result = await runLocalTurn({
    prompt: '宝宝今天吃辅食十五克胡萝卜十五克米粉三十克',
    service: {
      recordSolidMeal() {
        called = true;
        throw new Error('should not write ambiguous input');
      },
    },
    fetchImpl: queuedFetch([{
      role: 'assistant',
      content: '',
      tool_calls: [{
        function: {
          name: 'record_solid_meal',
          arguments: {
            items: [
              { name: '胡萝卜', amount: 15, unit: '克' },
              { name: '米粉', amount: 30, unit: '克' },
            ],
          },
        },
      }],
    }]),
  });
  assert.equal(called, false);
  assert.equal(result.toolName, null);
  assert.match(result.reply, /个辅食用量/);
});

test('aligns solid quantities to food order from the spoken request', async () => {
  let received;
  const result = await runLocalTurn({
    prompt: '辅食十五克胡萝卜十五颗米的三十克三文鱼',
    service: {
      recordSolidMeal(args) {
        received = args;
        return { ok: true, action: 'solid_meal_recorded', record_id: 44, items: args.items };
      },
    },
    environment: { BABYNOTE_AGENT_BABY_ID: '3', BABYNOTE_LOCAL_MODEL: 'test-model' },
    fetchImpl: queuedFetch([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'record_solid_meal', arguments: {
        items: [
          { name: '胡萝卜', amount: 15, unit: '克' },
          { name: '米', amount: 30, unit: '克' },
          { name: '三文鱼', amount: 15, unit: '克' },
        ],
      } } }] },
      { role: 'assistant', content: '已记录辅食。' },
    ]),
  });
  assert.equal(result.toolName, 'record_solid_meal');
  assert.deepEqual(received.items.map((item) => [item.name, item.amount, item.unit]), [
    ['胡萝卜', 15, '克'],
    ['米', 15, '克'],
    ['三文鱼', 30, '克'],
  ]);
});

test('preserves a spoken fraction when the model expands it to a whole item', async () => {
  let received;
  const result = await runLocalTurn({
    prompt: '刚刚吃了南瓜30克和四分之一个蛋黄',
    service: {
      recordSolidMeal(args) {
        received = args;
        return { ok: true, action: 'solid_meal_recorded', record_id: 45, items: args.items };
      },
    },
    environment: { BABYNOTE_AGENT_BABY_ID: '3', BABYNOTE_LOCAL_MODEL: 'test-model' },
    fetchImpl: queuedFetch([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'record_solid_meal', arguments: {
        items: [
          { name: '南瓜', amount: 30, unit: '克' },
          { name: '蛋黄', amount: 1, unit: '个' },
        ],
      } } }] },
      { role: 'assistant', content: '已记录辅食。' },
    ]),
  });
  assert.equal(result.toolName, 'record_solid_meal');
  assert.equal(received.items.find((item) => item.name === '蛋黄')?.amount, 0.25);
});

test('does not accept a made-up milk confirmation without a tool call', async () => {
  await assert.rejects(
    runLocalTurn({
      prompt: '宝宝喝奶一百三',
      service: {},
      fetchImpl: queuedFetch([
        { role: 'assistant', content: '好的，已记录宝宝喝了130ml的奶。' },
        { role: 'assistant', content: '好的，已记录宝宝喝了130ml的奶。' },
      ]),
    }),
    /without using a BabyNote tool/,
  );
});

test('recovers a data operation when old history makes the first model turn skip its tool', async () => {
  let called = 0;
  const result = await runLocalTurn({
    prompt: '[语音播报模式：请用口语回答] 宝宝喝奶一百三',
    history: [
      { role: 'user', content: '辅食十五克胡萝卜' },
      { role: 'assistant', content: '好的，已记录。' },
    ],
    service: {
      recordMilk(args) {
        called += 1;
        return { ok: true, action: 'milk_recorded', record_id: 99, amount_ml: args.amount_ml, occurred_at: '2026-08-30T04:00:00.000Z' };
      },
    },
    fetchImpl: queuedFetch([
      { role: 'assistant', content: '好的，已记录宝宝喝了130ml的奶。' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'record_milk', arguments: { amount_ml: 130 } } }] },
      { role: 'assistant', content: '已记录宝宝喝奶130ml。' },
    ]),
  });
  assert.equal(called, 1);
  assert.equal(result.toolName, 'record_milk');
  assert.equal(result.toolArguments.amount_ml, 130);
  assert.match(result.reply, /130/);
});

test('does not confirm a mutation when the tool itself fails', async () => {
  let calls = 0;
  const result = await runLocalTurn({
    prompt: '宝宝喝了130毫升',
    service: {
      recordMilk() {
        calls += 1;
        throw new Error('database temporarily unavailable');
      },
    },
    fetchImpl: queuedFetch([{
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'record_milk', arguments: { amount_ml: 130 } } }],
    }]),
  });
  assert.equal(calls, 1);
  assert.equal(result.toolName, 'record_milk');
  assert.match(result.reply, /记录失败/);
});

test('records milk through exactly one dedicated tool and injects trusted metadata', async () => {
  const calls = [];
  const service = {
    recordMilk(args, context) {
      calls.push({ args, context });
      return { ok: true, amount_ml: 160, recorded_at: '2026-08-29T07:00:00.000Z' };
    },
  };
  const result = await runLocalTurn({
    prompt: '[cc-connect sender_id=parent-1 chat_id=family@chatroom] 刚喝了160毫升',
    service,
    environment: {
      BABYNOTE_AGENT_BABY_ID: '3',
      BABYNOTE_LOCAL_MODEL: 'test-model',
      CC_MESSAGE_ID: 'message-1',
      CC_PLATFORM: 'weixin',
    },
    fetchImpl: queuedFetch([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'record_milk', arguments: { amount_ml: 160, time_text: '刚刚' } } }] },
    ]),
  });
  assert.equal(result.toolName, 'record_milk');
  assert.equal(result.reply, '好，记下啦，宝宝刚刚喝了160毫升奶。');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.baby_id, 3);
  assert.deepEqual(calls[0].context, {
    source_channel: 'weixin',
    source_message_id: 'message-1',
    source_chat_id: 'family@chatroom',
    operator_id: 'parent-1',
    source_text: '刚喝了160毫升',
  });
});

test('confirms a successful milk write with the trusted Beijing timestamp', async () => {
  const result = await runLocalTurn({
    prompt: '宝宝刚喝了160毫升奶',
    service: {
      recordMilk() {
        return {
          ok: true,
          action: 'milk_recorded',
          record_id: 100,
          amount_ml: 160,
          occurred_at: '2026-08-30T04:00:00.000Z',
          occurred_at_beijing: '2026-08-30 12:00:00',
        };
      },
    },
    now: new Date('2026-08-30T08:00:00.000Z'),
    environment: { BABYNOTE_AGENT_BABY_ID: '3', BABYNOTE_LOCAL_MODEL: 'test-model' },
    fetchImpl: queuedFetch([{
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'record_milk', arguments: { amount_ml: 160 } } }],
    }]),
  });
  assert.equal(result.reply, '好，记下啦，宝宝今天中午12点喝了160毫升奶。');
  assert.equal(result.toolName, 'record_milk');
});

test('answers latest feeding time through the dedicated read tool', async () => {
  const service = {
    getLatestFeeding(args) {
      assert.equal(args.baby_id, 3);
      return {
        ok: true,
        found: true,
        occurred_at_beijing: '2026-08-29 19:30:00',
        amount_ml: 180,
        elapsed_text: '30分钟',
      };
    },
  };
  const result = await runLocalTurn({
    prompt: '宝宝上次喝奶啥时候？',
    service,
    now: new Date('2026-08-30T12:00:00.000Z'),
    environment: { BABYNOTE_AGENT_BABY_ID: '3', BABYNOTE_LOCAL_MODEL: 'test-model' },
    fetchImpl: queuedFetch([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_latest_feeding', arguments: {} } }] },
      { role: 'assistant', content: '宝宝上次喝奶是19:30，喝了180毫升，距今约30分钟。' },
    ]),
  });
  assert.equal(result.toolName, 'get_latest_feeding');
  assert.equal(result.reply, '宝宝上次喝奶是昨天晚上7点半，喝了180毫升，已经过去30分钟了。');
});

test('answers latest wake time and awake duration through the dedicated read tool', async () => {
  const result = await runLocalTurn({
    prompt: '宝宝什么时候醒的？醒了多久？',
    service: {
      getLatestWake() {
        return {
          ok: true,
          found: true,
          woke_at_beijing: '2026-08-29 17:00:00',
          awake_text: '3小时',
          currently_sleeping: false,
        };
      },
    },
    now: new Date('2026-08-30T12:00:00.000Z'),
    environment: { BABYNOTE_AGENT_BABY_ID: '3', BABYNOTE_LOCAL_MODEL: 'test-model' },
    fetchImpl: queuedFetch([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_latest_wake', arguments: {} } }] },
      { role: 'assistant', content: '宝宝17:00醒的，已经醒了3小时。' },
    ]),
  });
  assert.equal(result.toolName, 'get_latest_wake');
  assert.equal(result.reply, '宝宝是昨天下午5点醒的，已经醒了3小时了。');
});

test('records an immediate wake-up without asking for a time', async () => {
  let received;
  const result = await runLocalTurn({
    prompt: '宝宝刚醒了',
    service: {
      endSleep(args, context) {
        received = { args, context };
        assert.equal(args.baby_id, 3);
        assert.equal(args.time_text, undefined);
        return {
          ok: true,
          action: 'sleep_ended',
          record_id: 42,
          sleep_start: '2026-08-30T01:00:00.000Z',
          sleep_end: '2026-08-30T03:00:00.000Z',
          duration_minutes: 120,
        };
      },
    },
    environment: { BABYNOTE_AGENT_BABY_ID: '3', BABYNOTE_LOCAL_MODEL: 'test-model' },
    fetchImpl: queuedFetch([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'end_sleep', arguments: {} } }] },
      { role: 'assistant', content: '已记录宝宝刚刚醒来。' },
    ]),
    now: new Date('2026-08-30T08:00:00.000Z'),
  });
  assert.equal(result.toolName, 'end_sleep');
  assert.equal(result.toolArguments.time_text, undefined);
  assert.equal(received.args.baby_id, 3);
  assert.equal(received.context.source_text, '宝宝刚醒了');
  assert.equal(result.reply, '好，记下啦，宝宝今天上午11点醒了，睡了2小时。');
});

test('preserves relative time from the spoken request when the model rewrites it', async () => {
  let received;
  const result = await runLocalTurn({
    prompt: '10分钟前睡着了',
    service: {
      startSleep(args) {
        received = args;
        return { ok: true, action: 'sleep_started', record_id: 43, sleep_start: '2026-08-30T01:50:00.000Z' };
      },
    },
    environment: { BABYNOTE_AGENT_BABY_ID: '3', BABYNOTE_LOCAL_MODEL: 'test-model' },
    fetchImpl: queuedFetch([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'start_sleep', arguments: { time_text: '20:00' } } }] },
      { role: 'assistant', content: '已记录宝宝10分钟前睡着。' },
    ]),
  });
  assert.equal(result.toolName, 'start_sleep');
  assert.equal(received.time_text, '10分钟前');
});

test('normalizes a recent-days summary range from the spoken request', async () => {
  let received;
  const result = await runLocalTurn({
    prompt: '最近7天宝宝奶量怎么样？',
    service: {
      getPeriodSummary(args) {
        received = args;
        return { ok: true, start_date: args.start_date, end_date: args.end_date, milk: { count: 0, total_ml: 0 } };
      },
    },
    now: new Date('2026-08-29T12:00:00.000Z'),
    fetchImpl: queuedFetch([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_summary', arguments: { start_date: '2026-08-22', end_date: '2026-08-29' } } }] },
      { role: 'assistant', content: '最近7天暂无记录。' },
    ]),
  });
  assert.equal(result.toolName, 'get_summary');
  assert.deepEqual(received, { baby_id: 3, start_date: '2026-08-23', end_date: '2026-08-29' });
});

test('routes sleep-duration questions to a summary query', async () => {
  let called = false;
  const result = await runLocalTurn({
    prompt: '今天宝宝睡了多久？',
    service: {
      getPeriodSummary(args) {
        called = true;
        assert.equal(args.date, '2026-08-29');
        return { ok: true, milk: { count: 0, total_ml: 0 }, sleep: { total_minutes: 120 } };
      },
    },
    now: new Date('2026-08-29T12:00:00.000Z'),
    fetchImpl: queuedFetch([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_summary', arguments: { date: '2026-08-29' } } }] },
      { role: 'assistant', content: '今天宝宝睡了2小时。' },
    ]),
  });
  assert.equal(called, true);
  assert.equal(result.toolName, 'get_summary');
});

test('allows one concise clarification without a tool call', async () => {
  const result = await runLocalTurn({
    prompt: '宝宝喝奶了',
    service: {},
    fetchImpl: queuedFetch([{ role: 'assistant', content: '喝了多少毫升？' }]),
  });
  assert.equal(result.toolName, null);
  assert.equal(result.reply, '喝了多少毫升？');
});

test('preserves ordinary chat in the cloud fallback JSONL stream', () => {
  const output = [
    JSON.stringify({ type: 'thread.started', thread_id: 'fallback' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '你好，今天也辛苦了。' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
  const filtered = filterFallbackOutput(output);
  assert.match(filtered, /agent_message/);
  assert.match(filtered, /turn.completed/);
});
