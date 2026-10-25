import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCloudPrompt, parseCodexJsonl } from './codex-turn.js';

test('buildCloudPrompt makes BabyNote data requests require business tools', () => {
  const prompt = buildCloudPrompt(
    '[cc-connect source_channel=xiaoai source_message_id=test-1]\n宝宝最近一次喝奶是什么时候？',
    [{ role: 'user', content: '宝宝刚醒了' }, { role: 'assistant', content: '已按当前时间记录。' }],
  );
  assert.match(prompt, /必须实际调用对应的 babynote MCP 业务工具/);
  assert.match(prompt, /此前对话/);
  assert.match(prompt, /宝宝最近一次喝奶/);
});

test('parseCodexJsonl keeps only BabyNote MCP calls and the final answer', () => {
  const output = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '我来查询。' } }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'babynote',
        tool: 'get_latest_feeding',
        arguments: { baby_id: 3 },
        result: { structured_content: { ok: true, found: true, amount_ml: 130 } },
      },
    }),
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'codex', tool: 'list_mcp_resources' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '最近一次喝奶是 130 毫升。' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }),
  ].join('\n');
  const parsed = parseCodexJsonl(output);
  assert.equal(parsed.turnCompleted, true);
  assert.equal(parsed.reply, '最近一次喝奶是 130 毫升。');
  assert.deepEqual(parsed.businessCalls, [{
    name: 'get_latest_feeding',
    arguments: { baby_id: 3 },
    result: { ok: true, found: true, amount_ml: 130 },
    error: null,
  }]);
  assert.deepEqual(parsed.usage, { input_tokens: 100, output_tokens: 20 });
});
