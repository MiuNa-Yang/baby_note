import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runGatewayTurn } from './gateway-turn.js';
import { traceRequest, readDashboard } from './telemetry.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'babynote-gateway-test-'));
  const keyFile = path.join(directory, '.env');
  fs.writeFileSync(keyFile, 'TEST_KEY=test-only-key\n');
  t.after(() => { fs.unlinkSync(keyFile); fs.rmdirSync(directory); });
  return { provider: 'gateway', baseUrl: 'http://127.0.0.1:8787/v1', model: 'gpt-5.6-luna',
    reasoningEffort: 'low', keyFile, keyName: 'TEST_KEY' };
}
const response = message => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20 } }));

test('gateway dispatches writes once, preserving trusted time and source context', async t => {
  const settings = fixture(t);
  let writes = 0;
  const result = await runGatewayTurn({ settings, reasoningEffort: 'xhigh',
    environment: { BABYNOTE_AGENT_BABY_ID: '3' },
    prompt: '[cc-connect source_channel=weixin source_message_id=gateway-test] 宝宝刚喝了130毫升奶',
    service: { recordMilk(args, context) {
      writes++;
      assert.equal(args.amount_ml, 130);
      assert.equal(context.source_channel, 'weixin');
      assert.ok(context.source_message_id.startsWith('gateway-test:'));
      return { ok: true, amount_ml: 130, occurred_at: new Date().toISOString() };
    } },
    fetchImpl: async (url, request) => {
      const body = JSON.parse(request.body);
      if (body.messages.at(-1).role === 'tool') return response({ role: 'assistant', content: '已记录130毫升奶。' });
      assert.equal(url, 'http://127.0.0.1:8787/v1/chat/completions');
      assert.equal(request.headers.Authorization, 'Bearer test-only-key');
      assert.equal(body.reasoning_effort, 'xhigh');
      assert.equal(body.model, 'gpt-5.6-luna');
      assert.equal(body.parallel_tool_calls, false);
      assert.ok(body.tools.length > 1);
      assert.equal(body.temperature, undefined);
      return response({ role: 'assistant', content: null, tool_calls: [{
        id: 'call_milk', type: 'function', function: { name: 'record_milk', arguments: '{"amount_ml":130}' },
      }] });
    },
  });
  assert.equal(writes, 1);
  assert.match(result.reply, /130毫升/);
});

test('gateway sends tool results with call IDs and counts both calls exactly once', async t => {
  const settings = fixture(t);
  const database = new Database(':memory:');
  t.after(() => database.close());
  let calls = 0;
  const result = await traceRequest(database, { channel: 'weixin', question: '今天喝了多少奶' }, () => runGatewayTurn({
    settings, prompt: '今天喝了多少奶', service: { getPeriodSummary: () => ({ ok: true, total_ml: 260 }) },
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.reasoning_effort, 'low');
      if (++calls === 1) return response({ role: 'assistant', content: null, tool_calls: [{
        id: 'call_summary', type: 'function', function: { name: 'get_summary', arguments: '{}' },
      }] });
      assert.equal(body.messages.at(-1).tool_call_id, 'call_summary');
      assert.equal(body.messages.at(-1).role, 'tool');
      assert.ok(body.tools.length > 1);
      assert.equal(body.tool_choice, 'auto');
      assert.equal(body.parallel_tool_calls, false);
      return response({ role: 'assistant', content: '今天喝了260毫升奶。' });
    },
  }));
  assert.equal(calls, 2);
  assert.equal(result.usage.input_tokens, 200);
  const dashboard = readDashboard(database);
  assert.equal(dashboard.items[0].attempts[0].provider, 'gateway');
  assert.equal(dashboard.summary.input_tokens, 200);
  assert.equal(dashboard.summary.output_tokens, 40);
});

test('gateway failure does not execute tools or leak upstream body', async t => {
  const settings = fixture(t);
  await assert.rejects(runGatewayTurn({ settings, prompt: '你好', service: {},
    fetchImpl: async () => new Response('private-upstream-diagnostics', { status: 401 }),
  }), error => error.message === 'GPT gateway returned HTTP 401.');
});
