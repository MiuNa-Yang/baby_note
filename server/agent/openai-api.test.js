import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chunkText,
  historyBeforeLatestUser,
  latestUserMessage,
  requestedThink,
} from './openai-api.js';

test('latestUserMessage selects the last OpenAI user message', () => {
  assert.equal(latestUserMessage([
    { role: 'system', content: 'system' },
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '回答' },
    { role: 'user', content: [{ type: 'text', text: '最后一句' }] },
  ]), '最后一句');
});

test('historyBeforeLatestUser keeps prior turns and excludes the current question', () => {
  assert.deepEqual(historyBeforeLatestUser([
    { role: 'system', content: 'system' },
    { role: 'user', content: '宝宝刚醒了' },
    { role: 'assistant', content: '已按当前时间记录。' },
    { role: 'user', content: '睡了多久？' },
  ]), [
    { role: 'user', content: '宝宝刚醒了' },
    { role: 'assistant', content: '已按当前时间记录。' },
  ]);
});

test('historyBeforeLatestUser applies a token-aware bound before the message bound', () => {
  const messages = [];
  for (let index = 0; index < 6; index += 1) {
    messages.push({ role: 'user', content: `用户问题${index}${'宝宝最近喝奶情况'.repeat(100)}` });
    messages.push({ role: 'assistant', content: `模型回答${index}${'最近一次记录已经查到'.repeat(100)}` });
  }
  messages.push({ role: 'user', content: '当前追问' });

  const history = historyBeforeLatestUser(messages);
  assert.ok(history.length < 12);
  assert.equal(history.at(-1)?.role, 'assistant');
  assert.equal(history.some((message) => message.content === '当前追问'), false);
});

test('chunkText splits by Unicode code points', () => {
  assert.deepEqual(chunkText('你好世界ABC', 3), ['你好世', '界AB', 'C']);
});

test('requestedThink accepts Ollama-supported reasoning levels', () => {
  assert.equal(requestedThink({ reasoning_effort: 'medium' }), 'medium');
  assert.equal(requestedThink({ reasoning: { effort: 'none' } }), 'none');
  assert.equal(requestedThink({}), null);
  assert.throws(() => requestedThink({ reasoning_effort: 'minimal' }), /reasoning_effort/);
});
