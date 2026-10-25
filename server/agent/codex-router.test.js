import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRoutedArguments,
  containsCompletedTurn,
  isRequestedModelAvailable,
  isSuccessfulRun,
  stripRouteArguments,
} from './codex-router.js';

test('detects the configured Ollama model without accepting a different tag', () => {
  const payload = {
    models: [
      { name: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M' },
      { model: 'qwen3:latest' },
    ],
  };

  assert.equal(
    isRequestedModelAvailable(payload, 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M'),
    true,
  );
  assert.equal(isRequestedModelAvailable(payload, 'qwen3'), true);
  assert.equal(isRequestedModelAvailable(payload, 'qwen3:8b'), false);
});

test('routes both new and resumed Codex turns through a selected provider', () => {
  assert.deepEqual(
    buildRoutedArguments(
      ['exec', '--sandbox', 'read-only', '--model', 'old', '--json', '-'],
      'ollama',
      'local-model',
    ),
    [
      'exec', '-c', 'model_provider="ollama"', '--model', 'local-model',
      '--sandbox', 'read-only', '--json', '-',
    ],
  );

  assert.deepEqual(
    buildRoutedArguments(
      ['exec', 'resume', '-c', 'model_provider="openai"', 'thread-id', '--json', '-'],
      'ollama',
      'local-model',
    ),
    [
      'exec', 'resume', '-c', 'model_provider="ollama"', '--model', 'local-model',
      'thread-id', '--json', '-',
    ],
  );
});

test('removes local routing flags before constructing fallback arguments', () => {
  assert.deepEqual(
    stripRouteArguments([
      'exec', '--oss', '--local-provider', 'ollama', '-m', 'local',
      '-c', 'oss_provider="ollama"', '--json', '-',
    ]),
    ['exec', '--json', '-'],
  );
});

test('requires a completed Codex turn before accepting the local route', () => {
  const completed = [
    JSON.stringify({ type: 'thread.started', thread_id: 'x' }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
  const failed = [
    JSON.stringify({ type: 'turn.completed' }),
    JSON.stringify({ type: 'turn.failed' }),
  ].join('\n');

  assert.equal(containsCompletedTurn(completed), true);
  assert.equal(containsCompletedTurn(failed), false);
  assert.equal(isSuccessfulRun({ code: 0, stdout: completed }), true);
  assert.equal(isSuccessfulRun({ code: 0, stdout: completed, timedOut: true }), false);
});
