import fs from 'node:fs';
import { runMultiToolTurn } from './multi-tool-turn.js';
import { traceAttempt } from './telemetry.js';

const configFile = new URL('../../infra/agent-model.json', import.meta.url);
const efforts = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
export function gatewaySettings() {
  if (!fs.existsSync(configFile)) return null;
  const settings = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  return settings.provider === 'gateway' ? settings : null;
}

export function gatewayKey(settings) {
  const line = fs.readFileSync(settings.keyFile, 'utf8').split(/\r?\n/)
    .find(line => line.trimStart().startsWith(`${settings.keyName}=`));
  const key = line?.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!key) throw new Error(`Gateway key ${settings.keyName} is not configured.`);
  return key;
}

export function chatMessages(messages) {
  let pending = [];
  return messages.map(message => {
    if (message.role === 'tool') {
      if (message.tool_call_id) return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
      const call = pending.find(call => call.function.name === message.tool_name);
      if (!call?.id) throw new Error('Tool result is missing its gateway call ID.');
      return { role: 'tool', tool_call_id: call.id, content: message.content };
    }
    if (message.tool_calls?.length) {
      pending = message.tool_calls;
      return { role: 'assistant', content: message.content || null, tool_calls: pending.map(call => ({
        id: call.id, type: 'function', function: { name: call.function.name,
          arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments) },
      })) };
    }
    return { role: message.role, content: message.content };
  });
}

export async function runGatewayTurn({ settings = gatewaySettings(), reasoningEffort, fetchImpl = fetch, ...options }) {
  if (!settings) throw new Error('Gateway provider is not enabled.');
  const effort = reasoningEffort ?? settings.reasoningEffort ?? 'low';
  if (!efforts.has(effort)) throw new Error(`Unsupported gateway reasoning effort: ${effort}`);
  return traceAttempt({ provider: 'gateway', model: settings.model, reasoning: effort }, async () => {
    const key = gatewayKey(settings);
    const endpoint = `${settings.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const usage = { input_tokens: 0, output_tokens: 0 };
    const transport = async (_url, request) => {
      const body = JSON.parse(request.body);
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: request.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: settings.model, messages: chatMessages(body.messages),
          ...(body.tools?.length ? { tools: body.tools, tool_choice: 'auto', parallel_tool_calls: false } : { tool_choice: 'none' }),
          reasoning_effort: effort, stream: false }),
      });
      if (!response.ok) throw new Error(`GPT gateway returned HTTP ${response.status}.`);
      const payload = await response.json();
      const choice = payload.choices?.[0];
      if (!choice?.message || choice.finish_reason === 'length') throw new Error('GPT gateway returned an incomplete response.');
      const input = payload.usage?.prompt_tokens;
      const output = payload.usage?.completion_tokens;
      usage.input_tokens = usage.input_tokens == null || input == null ? null : usage.input_tokens + input;
      usage.output_tokens = usage.output_tokens == null || output == null ? null : usage.output_tokens + output;
      return new Response(JSON.stringify({ message: choice.message, prompt_eval_count: input, eval_count: output }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const signal = AbortSignal.timeout(settings.timeoutMs || 120000);
    const result = await runMultiToolTurn({ ...options, modelCall: async (messages, tools) => {
      const response = await transport(endpoint, { body: JSON.stringify({ messages, tools }), signal });
      return response.json();
    } });
    return { ...result, usage };
  });
}
