import { createHash, randomUUID } from 'node:crypto';
import { BABY_PROFILE_PROMPT } from './baby-profile.js';
import { TOOL_DEFINITIONS, WRITE_TOOLS, executeTool, extractIncomingPrompt, buildWriteConfirmation, buildReadConfirmation, expectsTool } from './babynote-agent.js';
import { recordModelUsage, recordTool } from './telemetry.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

export async function runMultiToolTurn({ prompt, service, environment = process.env, history = [], modelCall, now = new Date() }) {
  const { metadata, text } = extractIncomingPrompt(prompt);
  const messageId = metadata.source_message_id || environment.CC_MESSAGE_ID || randomUUID();
  const tools = [];
  const writes = new Map();
  const messages = [
    { role: 'system', content: [
      '你是家庭育儿助手 BabyNote。根据问题自主规划，可以连续调用多个工具，也可以先记录再查询，完成所有子任务后统一回答。',
      BABY_PROFILE_PROMPT,
      '可以查询宝宝档案、成长历史和食材目录，记录体重身长，批量维护排敏状态。用户提供存量排敏清单时使用食材状态工具，无需克数，不虚构进食记录。状态只适用于列出的具体食材，不扩展到混合食品的成分或其他同类食材。体重单位不明先询问；明确的斤除以2转公斤；身长按厘米。已有信息先查数据库。',
      '排敏食材数量必须使用工具返回的 confirmed_safe_count，分类名单使用 confirmed_safe_by_category，不自行目测计数。',
      '涉及宝宝记录和统计必须实际调用工具，不得编造。普通聊天无需工具。只执行用户明确要求的记录动作，不要把查询或历史对话当成新的写入指令。',
      '工具结果足够回答时立即回答，不要重复查询。同一记录不要重复写入。缺少数量或时间含糊时先问清楚。每个动作使用其对应的时间和数量，不能混用。',
      '辅食 amount 一律为克，不推断其它单位。时间以工具结果的北京时间为准，优先使用 spoken_confirmation；最近喝奶和醒来同时说明时间及已过多久。',
      '某一步失败必须说明哪些已完成、哪些失败，不要将整条任务说成全部成功。',
      '回复简短口语化，不展示工具名、JSON、推理或Markdown，不主动播报完整年月日。不能给出医疗诊断。',
      `当前北京时间：${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}。未明确指定的汇总日期默认今天，回答中说清查询范围。`,
    ].join('\n') },
    ...history.filter(m => ['user', 'assistant'].includes(m.role)).slice(-12),
    { role: 'user', content: text },
  ];
  let dataReminder = false;
  for (let round = 0; round < 13; round++) {
    let payload;
    try { payload = await modelCall(messages, round < 12 && tools.length < 24 ? TOOL_DEFINITIONS : []); }
    catch (error) {
      if (!tools.length) throw error;
      return { ignored: false, toolCalls: tools, toolResult: { ok: false, error: error.message },
        reply: tools.map(t => t.result?.spoken_confirmation).filter(Boolean).join('') + '后续处理出错，整项任务尚未完成，以上已经成功的记录已保存。' };
    }
    recordModelUsage(payload);
    const message = payload.message;
    const calls = message?.tool_calls || [];
    if (!calls.length) {
      const reply = String(message?.content || '').trim();
      if (!reply) throw new Error('GPT returned an empty reply.');
      if (!tools.length && expectsTool(text) && !dataReminder && !/[？?]|请问|请提供|需要.*(?:时间|数量)|多少|什么时候/.test(reply)) {
        dataReminder = true;
        messages.push({ role: 'system', content: '当前用户请求涉及宝宝数据。请实际调用相应工具，不能凭空回答或声称已记录。信息不足时提出澄清问题。' });
        continue;
      }
      if (!tools.length && dataReminder && !/[？?]|请问|请提供|需要.*(?:时间|数量)|多少|什么时候/.test(reply)) {
        throw new Error('模型没有实际查询或记录宝宝数据，无法确认结果。');
      }
      return { ignored: false, reply, toolCalls: tools,
        toolName: tools.at(-1)?.name, toolArguments: tools.at(-1)?.arguments,
        toolResult: tools.find(t => t.result?.ok === false)?.result || tools.at(-1)?.result };
    }
    if (round >= 12 || tools.length + calls.length > 24) break;
    messages.push(message);
    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      let result;
      try {
        if (!call.id || !TOOL_DEFINITIONS.some(t => t.function.name === name)) throw new Error('模型请求了不支持的工具');
        args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments || {};
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
        delete args.baby_id;
        const signature = createHash('sha256').update(JSON.stringify([name, canonical(args)])).digest('hex');
        if (WRITE_TOOLS.has(name) && writes.has(signature)) {
          result = { ...writes.get(signature), idempotent_replay: true };
        } else {
          result = executeTool(service, name, args, environment,
            { ...metadata, source_message_id: `${messageId}:${signature}` }, text);
          if (WRITE_TOOLS.has(name) && result?.ok !== false) writes.set(signature, result);
        }
        const spoken = WRITE_TOOLS.has(name)
          ? buildWriteConfirmation(name, result, args, new Date())
          : buildReadConfirmation(name, result, new Date());
        if (spoken) result = { ...result, spoken_confirmation: spoken };
      } catch (error) { result = { ok: false, error: error.message, code: error.code || 'tool_error' }; }
      tools.push({ name, arguments: args, result });
      recordTool(name, args, result);
      messages.push({ role: 'tool', tool_call_id: call.id || 'invalid', tool_name: name, content: JSON.stringify(result) });
    }
  }
  return { ignored: false, reply: '这次处理步骤较多，已停止继续调用。' + tools.map(t => t.result?.spoken_confirmation || (t.result?.ok === false ? '有一步失败：' + t.result.error : '')).filter(Boolean).join(''),
    toolCalls: tools, toolResult: { ok: false, error: '已达到本次工具调用上限，请缩小问题范围。' } };
}
