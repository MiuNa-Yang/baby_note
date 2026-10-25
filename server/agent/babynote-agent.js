#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { db, initDb } from '../db.js';
import { BABY_PROFILE_PROMPT } from './baby-profile.js';
import { traceRequest, traceAttempt, recordModelUsage, recordTool } from './telemetry.js';
import { createAgentService, shanghaiDateKey } from './domain.js';

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen3.5:9b';
// For short voice commands, deterministic tool selection is more reliable
// than spending the small local model's budget on hidden reasoning. Callers
// can still opt into low/medium/high/max through BABYNOTE_LOCAL_THINK.
const DEFAULT_THINK = 'none';
const DEFAULT_TIMEOUT_MS = 120_000;
const EMPTY_RESPONSE_RETRIES = 1;
const WRITE_TOOLS = new Set(['record_milk', 'start_sleep', 'end_sleep', 'record_solid_meal', 'record_growth', 'set_food_status']);
const SUMMARY_QUERY_HINT = /(?:最近|近|过去|本|这|上)\s*(?:[一二两三四五六七八九十\d]+\s*(?:天|日|周|星期|个月|月|季度|半年|年)|(?:周|月|季度|半年|年))|趋势|变化|走势|概况|对比/iu;
const SOLID_QUANTITY_PATTERN = /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万点]+)\s*(?:克|g|公斤|千克|毫升|ml|勺|个|颗|块|条|片|根|碗|杯|份|口)/giu;

const TOOL_DEFINITIONS = [
  tool('record_growth', '记录实际测量的体重和/或身长，至少一项。公斤或kg直接记录，斤除以2；单位不明先询问。', {
    weight_kg: numberProperty('体重，公斤', 0.01, 100),
    height_cm: numberProperty('身长或身高，厘米', 0.01, 250),
    time_text: stringProperty('测量时间，省略表示现在'),
    note: stringProperty('备注'),
  }),
  tool('get_baby_profile', '查询宝宝生日、最新体重和身长（含测量日期）、已登记食材及家长确认的排敏状态。'),
  tool('get_growth_history', '查询宝宝历次体重和身长，按时间倒序，用于成长变化或历史测量查询。'),
  tool('list_solid_foods', '查询食材目录及家长确认状态。confirmed_safe 表示家长报告已排敏，不代表永久不会过敏。'),
  tool('set_food_status', '批量补录或更新已尝试食材及排敏状态，不需要克数，不产生进食记录。只将用户明确说已排敏的具体食材标记为confirmed_safe，不扩展到同类或混合食品的组成食材。', {
    items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false,
      properties: { name: stringProperty('食材名称'), category: stringProperty('食材类别'),
        status: { type: ['string', 'null'], enum: ['confirmed_safe', 'confirmed_allergy', null], description: '已排敏、已确认过敏，或清除手动状态' },
        note: stringProperty('家长描述或状态依据') }, required: ['name', 'status'] } },
    note: stringProperty('本批次记录依据'),
  }, ['items']),
  tool('record_milk', '记录一次已经发生的瓶喂奶量。仅在奶量明确时调用。', {
    amount_ml: numberProperty('本次已喝奶量，单位 ml', 1, 1000),
    time_text: stringProperty('用户原话中的时间；省略表示现在'),
    note: stringProperty('可选备注'),
  }, ['amount_ml']),
  tool('start_sleep', '记录宝宝开始睡眠。', {
    time_text: stringProperty('入睡时间；省略表示现在'),
    note: stringProperty('可选备注'),
  }),
  tool('end_sleep', '结束当前进行中的睡眠。用户说“宝宝刚醒了”“刚刚醒了”或“现在醒了”时，time_text 必须省略，按当前北京时间记录，不要追问时间；只有明确提供了过去的具体时间才填写 time_text。', {
    time_text: stringProperty('醒来时间；省略表示现在'),
  }),
  tool('record_solid_meal', '记录宝宝已经吃下的辅食，每种食物必须有明确用量。', {
    time_text: stringProperty('进食时间；省略表示现在'),
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: stringProperty('食物名称'),
          amount: numberProperty('食用量，统一按克填写；不要填写单位'),
        },
        required: ['name', 'amount'],
      },
    },
    note: stringProperty('可选备注'),
  }, ['items']),
  tool('get_latest_feeding', '查询宝宝最近一次喝奶的时间、奶量，以及距今多久。没有记录时返回 found=false。'),
  tool('get_latest_wake', '查询宝宝最近一次醒来的时间，以及已经醒了多久；如果当前正在睡，也返回当前睡眠状态。'),
  tool('get_summary', '查询奶量、睡眠和辅食汇总。不传日期默认今天；传 date 查询单日；传 start_date 和 end_date 查询包含首尾日期的范围，最多31天。', {
    date: stringProperty('北京时间日期 YYYY-MM-DD；省略表示今天'),
    start_date: stringProperty('范围开始日期（含），格式 YYYY-MM-DD'),
    end_date: stringProperty('范围结束日期（含），格式 YYYY-MM-DD'),
  }),
  tool('get_meal_plan', '查询指定日期的辅食计划。', {
    date: stringProperty('北京时间日期 YYYY-MM-DD；省略表示今天'),
  }),
  tool('build_daily_reminder', '生成当天辅食提醒，message 应原样回复。', {
    date: stringProperty('北京时间日期 YYYY-MM-DD；省略表示今天'),
  }),
];

function stringProperty(description) {
  return { type: 'string', description };
}

function numberProperty(description, minimum, maximum) {
  return {
    type: 'number',
    description,
    minimum,
    ...(maximum == null ? {} : { maximum }),
  };
}

function tool(name, description, properties, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties,
        required,
      },
    },
  };
}

function shanghaiClock(now = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);
}

function expectedToolForText(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (/体重|身高|身长|排敏|过敏|食材|基础情况|档案/u.test(value)) return null;
  if (/(?:宝宝|孩子)?.*(?:喝奶|喂奶).*(?:\d|[零〇一二两三四五六七八九十百千万点]).*(?:毫升|ml|毫升奶)?/iu.test(value)
    || /(?:喝了|喂了).*(?:\d|[零〇一二两三四五六七八九十百千万点])/u.test(value)) {
    return 'record_milk';
  }
  if (/(?:最近一次|上次|最后一次|最近).*(?:喝奶|喂奶).*(?:什么时候|啥时候|几点|多久|多少)/u.test(value)
    || /(?:什么时候|啥时候|几点|多久前).*(?:喝奶|喂奶)/u.test(value)) {
    return 'get_latest_feeding';
  }
  if (/(?:最近一次|上次|最后一次|最近).*(?:醒|睡醒).*(?:什么时候|啥时候|几点|多久)/u.test(value)
    || /(?:什么时候|啥时候|几点|多久前).*(?:醒|睡醒)/u.test(value)) {
    return 'get_latest_wake';
  }
  if (/(?:醒了|睡醒了).*(?:多久|多长时间)/u.test(value)) return 'get_latest_wake';
  if (/(?:最近|过去|近)\s*(?:[一二两三四五六七八九十\d]+\s*)?(?:天|日|周|星期|个月|月)|趋势|变化|走势|概况|对比/u.test(value)) {
    return 'get_summary';
  }
  if (/(?:今天|本日).*(?:多少奶|奶量|喝了多少|一共喝|总共喝|总奶量)|今天怎么样|今日汇总/u.test(value)) {
    return 'get_summary';
  }
  if (/(?:睡了(?:多久|多长时间)|睡眠(?:多久|时长)|今天睡了多少)/u.test(value)) return 'get_summary';
  if (/(?:刚醒|刚刚醒|现在醒|睡醒了|醒了)/u.test(value)) return 'end_sleep';
  if (/(?:睡着了|开始睡|睡了|午睡)/u.test(value)) return 'start_sleep';
  if (/(?:辅食|吃了).*(?:克|g|公斤|千克|毫升|ml|勺|个|颗|块|条|片|根|碗|杯|份|口)/iu.test(value)) {
    return 'record_solid_meal';
  }
  if (extractSolidQuantities(value).length && !/(?:奶|睡|醒)/u.test(value)) return 'record_solid_meal';
  return null;
}

export function buildSystemPrompt(now = new Date(), requestText = '') {
  const expectedTool = expectedToolForText(requestText);
  return [
    '你是 BabyNote 专用家庭带娃记录 Agent，不是通用聊天助手。',
    BABY_PROFILE_PROMPT,
    '支持宝宝档案查询、体重身长记录和历史查询、食材目录和排敏状态管理，以及奶量、睡眠、辅食、汇总、辅食计划和提醒。排敏清单不需要进食克数；不要将清单记成一餐。体重单位不明先询问，斤换算为公斤；已有数据先查询。',
    '涉及宝宝数据的查询或记录必须调用提供的工具；禁止凭空回答数据库中的数值。普通闲聊、问候和无关问题可以直接简短回答，不调用工具。',
    '回答最近一次喝奶或醒来问题时，严格使用查询工具返回的北京时间和 elapsed_text/awake_text；currently_sleeping 为 true 时不要说宝宝正在醒着。',
    '辅食工具的 amount 一律表示克数；不要输出或推断 unit，所有新辅食记录统一按克保存。',
    '口头回答时间优先说“刚刚”“今天上午/下午”“昨天”等自然说法；不要主动播报完整年月日、ISO 时间或带冒号的机器式时间。',
    '“宝宝刚醒了”“刚刚醒了”“现在醒了”表示正在记录一个刚发生的事件，默认按当前北京时间调用 end_sleep，省略 time_text，不要追问睡醒时间，也不需要用户二次唤醒。',
    '一条消息最多调用一个工具。缺少奶量、时间有歧义、辅食缺少任一用量时，不猜测，只问一个简短问题；辅食中的每个数量都必须和食物一一对应，不能丢弃孤立数量。',
    '无法确定是否涉及宝宝数据时，先简短澄清，不要猜测。不要进行医疗诊断。',
    '若用户描述呼吸困难、昏迷、抽搐或严重过敏等紧急症状，只建议立即联系急救或医生。',
    '工具成功后只用一条简短中文确认关键数值和时间，不展示推理或工具名称。',
    '工具选择硬规则：包含“今天/本日喝了多少奶、今天奶量、今天怎么样、今日汇总”时调用 get_summary；包含“最近一次/上次喝奶什么时候、啥时候、几点、多久”时调用 get_latest_feeding；包含“最近一次醒来、什么时候醒、醒了多久”时调用 get_latest_wake。不要把今日汇总问题当成最近一次喝奶问题。',
    expectedTool ? `本条消息的高置信工具约束：只能调用 ${expectedTool}；如果信息不足，再提出澄清问题。` : '',
    `当前北京时间：${shanghaiClock(now)}。`,
  ].join('\n');
}

function parseMetadata(text) {
  const metadata = {};
  const match = String(text).match(/^\s*\[cc-connect\s+([^\]]+)\]\s*/i);
  if (!match) return { metadata, text: String(text).trim() };
  const pairPattern = /(\w+)=((?:"[^"]*")|(?:'[^']*')|[^\s\]]+)/g;
  for (const pair of match[1].matchAll(pairPattern)) {
    metadata[pair[1]] = pair[2].replace(/^['"]|['"]$/g, '');
  }
  return { metadata, text: String(text).slice(match[0].length).trim() };
}

export function extractIncomingPrompt(rawPrompt) {
  let text = String(rawPrompt || '').trim();
  const marker = '\nUser message:\n';
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) text = text.slice(markerIndex + marker.length).trim();
  const parsed = parseMetadata(text);
  return {
    metadata: parsed.metadata,
    // mi-voice-agent adds this transport hint to every voice query. It is
    // useful to the gateway but can confuse intent detection and the model.
    text: parsed.text.replace(/^\[语音播报模式[：:][^\]]*\]\s*/u, '').trim(),
  };
}

export function mightBeBabyNoteRequest(text) {
  const input = String(text || '').trim();
  if (!input) return false;
  if (/体重|身高|身长|排敏|过敏|食材|档案/u.test(input)) return true;
  return /(宝宝|孩子|奶|喂|母乳|瓶喂|毫升|\bml\b|睡|醒|午觉|辅食|米粉|蛋黄|记录|汇总|计划|提醒|今天怎么样)/iu.test(input)
    || /^(?:宝宝|孩子)?\s*(?:刚刚|刚才|今天|中午|晚上|早上|上午|下午)?\s*吃了/iu.test(input)
    || /(?:喝|吃).{0,8}\d+(?:\.\d+)?\s*(?:ml|毫升|克|g|勺|个)/iu.test(input)
    || SUMMARY_QUERY_HINT.test(input);
}

export function isIgnoredReply(text) {
  return /^\s*IGNORE[。.!！]?\s*$/i.test(String(text || ''));
}

export function hasMultipleWriteIntents(text) {
  const input = String(text || '');
  const intents = [
    /(?:喝|喂).{0,12}(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万点]+)\s*(?:ml|毫升)/iu.test(input),
    /(?:睡着|开始睡|刚睡|睡了|午睡)(?!\s*(?:多久|多长时间))/u.test(input),
    /(?:刚醒|刚刚醒|现在醒|醒了|睡醒)(?!\s*(?:多久|多长时间))/u.test(input),
    /(?:辅食|吃了).*(?:克|g|公斤|千克|毫升|ml|勺|个|颗|块|条|片|根|碗|杯|份|口)/iu.test(input),
  ].filter(Boolean);
  return intents.length > 1;
}

export function expectsTool(text) {
  const value = String(text);
  if (/体重|身高|身长|排敏|食材|档案/u.test(value)) return true;
  return /(?:喝奶|喂奶|奶量)/u.test(value)
    || /(?:宝宝|孩子).{0,8}(?:喝|喂).{0,8}(?:\d|[零〇一二两三四五六七八九十百千万点])/u.test(value)
    || /(喝了|喂了|睡着|开始睡|醒了|吃了|记录|辅食|汇总|多少奶|睡了多久|辅食计划|今天怎么样|趋势|变化|走势|概况|对比|上次|最近一次|什么时候.*(?:喝奶|喂奶|醒)|醒了多久|喝奶多久)/u.test(value)
    || SUMMARY_QUERY_HINT.test(value)
    || (extractSolidQuantities(value).length > 0 && !/(?:奶|睡|醒)/u.test(value));
}

export function isClarifyingQuestion(text) {
  const value = String(text || '').trim();
  return value.length <= 120 && (/\?|？$/u.test(value) || /(请补充|请问|多少|几点|什么时候|用量|确认)/u.test(value));
}

function normalizeToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Ollama returned invalid tool arguments.');
  }
  return parsed;
}

function trustedRelativeTime(text) {
  return String(text || '').match(
    /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+|半)\s*(?:分钟?|小时|钟头|天|周|日)\s*前/iu,
  )?.[0] || null;
}

function simpleChineseNumber(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let total = 0;
  let section = 0;
  for (const char of text) {
    if (digits[char] != null) {
      section += digits[char];
    } else if (units[char]) {
      total += (section || 1) * units[char];
      section = 0;
    } else {
      return null;
    }
  }
  const result = total + section;
  return result > 0 ? result : null;
}

function addDateKey(dateKey, delta) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateKey;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta));
  return date.toISOString().slice(0, 10);
}

function normalizeTrustedSummaryArguments(text, toolName, args, now) {
  if (toolName !== 'get_summary') return args;
  const value = String(text || '');
  const normalized = { ...args };
  const range = value.match(/(?:最近|过去|近)\s*([零〇一二两三四五六七八九十百千万\d]+)?\s*(天|日|周|星期)/u);
  const today = shanghaiDateKey(now);
  if (range) {
    const count = simpleChineseNumber(range[1] || '一');
    const days = count * (/(?:周|星期)/u.test(range[2]) ? 7 : 1);
    if (count && days <= 31) {
      delete normalized.date;
      normalized.start_date = addDateKey(today, -(days - 1));
      normalized.end_date = today;
      return normalized;
    }
  }
  if (/(?:今天|本日|今日)/u.test(value) && !range) {
    delete normalized.start_date;
    delete normalized.end_date;
    normalized.date = today;
  }
  return normalized;
}

function normalizeTrustedArguments(text, toolName, args) {
  const normalized = { ...args };
  const relativeTime = trustedRelativeTime(text);
  if (relativeTime && WRITE_TOOLS.has(toolName)) normalized.time_text = relativeTime;
  if (toolName === 'end_sleep' && /(?:刚刚|刚才|现在|刚)\s*(?:醒了|睡醒了)/u.test(String(text || ''))) {
    delete normalized.time_text;
  }
  return normalized;
}

function canonicalSolidUnit(unit) {
  const value = String(unit || '').trim();
  if (/^(?:克|g)$/iu.test(value)) return 'g';
  if (/^(?:毫升|ml)$/iu.test(value)) return 'ml';
  return value;
}

function extractSolidQuantities(text) {
  const pattern = /(?:(?<den>[零〇一二两三四五六七八九十百千万]+)\s*分之\s*(?<num>[零〇一二两三四五六七八九十百千万]+)\s*(?<fractionUnit>克|g|公斤|千克|毫升|ml|勺|个|颗|块|条|片|根|碗|杯|份|口))|(?<half>半)\s*(?<halfUnit>克|g|公斤|千克|毫升|ml|勺|个|颗|块|条|片|根|碗|杯|份|口)|(?<number>\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万点]+)\s*(?<unit>克|g|公斤|千克|毫升|ml|勺|个|颗|块|条|片|根|碗|杯|份|口)/giu;
  return [...String(text || '').matchAll(pattern)].map((match) => {
    const groups = match.groups || {};
    let amount;
    let unit;
    if (groups.den && groups.num) {
      amount = simpleChineseNumber(groups.num) / simpleChineseNumber(groups.den);
      unit = groups.fractionUnit;
    } else if (groups.half) {
      amount = 0.5;
      unit = groups.halfUnit;
    } else {
      const numberText = groups.number;
      amount = /^\d+(?:\.\d+)?$/.test(numberText || '')
        ? Number(numberText)
        : simpleChineseNumber(numberText);
      unit = groups.unit;
    }
    return { amount, unit: canonicalSolidUnit(unit) };
  }).filter((item) => Number.isFinite(item.amount) && item.amount > 0);
}

function normalizeSolidArguments(text, args) {
  if (!Array.isArray(args?.items) || !args.items.length) return args;
  const quantities = extractSolidQuantities(text);
  if (quantities.length !== args.items.length) return args;

  const positions = args.items.map((item) => String(text || '').indexOf(String(item?.name || '').trim()));
  if (positions.some((position) => position < 0) || positions.some((position, index) => index && position < positions[index - 1])) {
    return args;
  }
  return {
    ...args,
    items: args.items.map((item, index) => ({
      ...item,
      amount: quantities[index].amount,
      // The voice path intentionally discards spoken/model-selected units.
      // The data contract for new agent records is grams only.
      unit: '克',
    })),
  };
}

function validateSolidToolInput(text, args) {
  const quantityCount = extractSolidQuantities(text).length;
  const itemCount = Array.isArray(args?.items) ? args.items.length : 0;
  if (!quantityCount || quantityCount === itemCount) return null;
  return `我听到了${quantityCount}个辅食用量，但只确认了${itemCount}种食物，请重新说清楚每个用量对应的食物。`;
}

function normalizeReply(text) {
  return String(text || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 500);
}

function parseBeijingDateValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  const date = local
    ? new Date(Date.UTC(
      Number(local[1]), Number(local[2]) - 1, Number(local[3]),
      Number(local[4]), Number(local[5]), Number(local[6] || 0),
    ) - (8 * 60 * 60 * 1000))
    : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function beijingParts(value) {
  const date = value instanceof Date ? value : parseBeijingDateValue(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
}

function formatBeijingDateTime(value) {
  const parts = beijingParts(value);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`;
}

function clockPhrase(parts) {
  const period = parts.hour < 6
    ? '凌晨'
    : parts.hour < 12
      ? '上午'
      : parts.hour < 13
        ? '中午'
        : parts.hour < 18
          ? '下午'
          : '晚上';
  const hour = parts.hour % 12 || 12;
  if (parts.minute === 0) return `${period}${hour}点`;
  if (parts.minute === 30) return `${period}${hour}点半`;
  return `${period}${hour}点${parts.minute}分`;
}

function datePhrase(parts, nowParts) {
  const eventDay = Date.UTC(parts.year, parts.month - 1, parts.day);
  const currentDay = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  const dayDelta = Math.round((eventDay - currentDay) / (24 * 60 * 60 * 1000));
  if (dayDelta === 0) return '今天';
  if (dayDelta === -1) return '昨天';
  if (dayDelta === -2) return '前天';
  if (parts.year === nowParts.year) return `${parts.month}月${parts.day}号`;
  return `${parts.year}年${parts.month}月${parts.day}号`;
}

function friendlyDateTime(value, now = new Date()) {
  const parts = beijingParts(value);
  const nowParts = beijingParts(now);
  if (!parts || !nowParts) return formatBeijingDateTime(value);
  return `${datePhrase(parts, nowParts)}${clockPhrase(parts)}`;
}

function friendlyEventTime(result, localKey, isoKey, originalTimeText, now) {
  const spokenTime = String(originalTimeText || '').trim();
  if (/(?:刚刚|刚才|现在)/u.test(spokenTime)) return '刚刚';
  const relative = spokenTime.match(/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+|半)\s*(?:分钟?|小时|钟头|天|周|日)\s*前/iu);
  if (relative) return relative[0].replace(/钟头/gu, '小时');
  const value = result?.[isoKey] || result?.[localKey];
  const parts = beijingParts(value);
  const nowParts = beijingParts(now);
  if (parts && nowParts) {
    const deltaMinutes = Math.round((now.getTime() - parseBeijingDateValue(value).getTime()) / 60000);
    if (deltaMinutes >= 0 && deltaMinutes <= 2) return '刚刚';
  }
  return friendlyDateTime(value, now);
}
function durationText(minutes) {
  const value = Math.max(0, Number(minutes) || 0);
  if (value < 60) return `${value}分钟`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours}小时${rest}分钟` : `${hours}小时`;
}

export function buildWriteConfirmation(toolName, result, args = {}, now = new Date()) {
  if (!result?.ok) return null;
  if (toolName === 'record_growth') {
    const when = friendlyEventTime(result, 'occurred_at_beijing', 'occurred_at', args.time_text, now);
    return `已记录${when || ''}的${[result.weight_kg != null ? `体重${result.weight_kg}公斤` : '', result.height_cm != null ? `身长${result.height_cm}厘米` : ''].filter(Boolean).join('、')}。`;
  }
  if (toolName === 'set_food_status') return `已更新${result.count}种食材的排敏状态。`;
  if (toolName === 'record_milk') {
    const when = friendlyEventTime(result, 'occurred_at_beijing', 'occurred_at', args.time_text, now);
    if (when && result.amount_ml != null) return `好，记下啦，宝宝${when}喝了${result.amount_ml}毫升奶。`;
  }
  if (toolName === 'start_sleep') {
    const when = friendlyEventTime(result, 'sleep_start_beijing', 'sleep_start', args.time_text, now);
    if (when) return `好，记下啦，宝宝${when}睡着了。`;
  }
  if (toolName === 'end_sleep') {
    const when = friendlyEventTime(result, 'sleep_end_beijing', 'sleep_end', args.time_text, now);
    if (when && result.duration_minutes != null) {
      return `好，记下啦，宝宝${when}醒了，睡了${durationText(result.duration_minutes)}。`;
    }
  }
  if (toolName === 'record_solid_meal') {
    const when = friendlyEventTime(result, 'occurred_at_beijing', 'occurred_at', args.time_text, now);
    const items = Array.isArray(result.items) ? result.items : [];
    if (when && items.length) {
      const itemText = items.map((item) => {
        const amount = item?.amount ?? item?.grams;
        return `${item?.name || '辅食'}${item?.quantity_text || `${amount}克`}`;
      }).join('、');
      return `好，记下啦，宝宝${when}吃了${itemText}。`;
    }
  }
  return null;
}

export function buildReadConfirmation(toolName, result, now = new Date()) {
  if (!result?.ok) return null;
  if (toolName === 'get_latest_feeding') {
    if (!result.found) return '还没有找到宝宝的喝奶记录。';
    const when = friendlyDateTime(result.occurred_at || result.occurred_at_beijing, now);
    if (!when || result.amount_ml == null) return null;
    if (result.elapsed_text === '刚刚') return `宝宝刚刚喝了${result.amount_ml}毫升奶。`;
    const elapsed = result.elapsed_text ? `，已经过去${result.elapsed_text}了` : '';
    return `宝宝上次喝奶是${when}，喝了${result.amount_ml}毫升${elapsed}。`;
  }
  if (toolName === 'get_latest_wake') {
    if (!result.found) {
      return result.currently_sleeping
        ? '宝宝现在还在睡，暂时没有最近一次醒来的记录。'
        : '还没有找到宝宝的醒来记录。';
    }
    const when = friendlyDateTime(result.woke_at || result.woke_at_beijing, now);
    if (!when) return null;
    if (result.currently_sleeping) return `宝宝上次是${when}醒的，后来又睡着了。`;
    if (result.awake_text === '刚刚') return '宝宝刚刚醒了。';
    const awake = result.awake_text ? `，已经醒了${result.awake_text}了` : '';
    return `宝宝是${when}醒的${awake}。`;
  }
  return null;
}

function normalizeConversationHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) => ['user', 'assistant'].includes(String(message?.role || '').toLowerCase()))
    .map((message) => ({
      role: String(message.role).toLowerCase(),
      content: String(message.content || '').trim(),
    }))
    .filter((message) => message.content);
}

function normalizeThink(value) {
  const normalized = String(value || DEFAULT_THINK).trim().toLowerCase();
  if (normalized === 'none') return false;
  if (['low', 'medium', 'high', 'max'].includes(normalized)) return normalized;
  return DEFAULT_THINK;
}

async function callOllama({ fetchImpl, baseUrl, model, messages, timeoutMs, think, keepAlive }) {
  const endpoint = new URL('/api/chat', `${String(baseUrl).replace(/\/$/, '')}/`);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      ...(messages.at(-1)?.role === 'tool' ? {} : { tools: TOOL_DEFINITIONS }),
      stream: false,
      think,
      keep_alive: keepAlive,
      options: {
        temperature: 0.1,
        num_ctx: 32768,
        num_predict: 512,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`Ollama returned HTTP ${response.status}: ${detail}`);
  }
  const payload = await response.json();
  recordModelUsage(payload);
  if (!payload?.message) throw new Error('Ollama response is missing message.');
  return payload;
}

function hasUsableModelMessage(payload) {
  const message = payload?.message;
  return Boolean(String(message?.content || '').trim())
    || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0);
}

async function callOllamaWithRetry(options, stage) {
  let lastPayload;
  for (let attempt = 0; attempt <= EMPTY_RESPONSE_RETRIES; attempt += 1) {
    lastPayload = await callOllama(options);
    if (hasUsableModelMessage(lastPayload)) return lastPayload;
    if (attempt < EMPTY_RESPONSE_RETRIES) {
      console.warn(`[Agent] Ollama returned an empty ${stage} message; retrying (${attempt + 1}/${EMPTY_RESPONSE_RETRIES}).`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  const error = new Error(`Local model returned neither a reply nor a tool call during ${stage}.`);
  error.code = 'empty_model_response';
  error.details = {
    stage,
    retries: EMPTY_RESPONSE_RETRIES,
    has_thinking: Boolean(String(lastPayload?.message?.thinking || '').trim()),
  };
  throw error;
}

function contextFrom(environment, metadata, sourceText) {
  const sessionKey = String(environment.CC_SESSION_KEY || '');
  return {
    source_channel: String(metadata.source_channel || environment.CC_PLATFORM || sessionKey.split(':')[0] || 'weixin'),
    source_message_id: String(metadata.source_message_id || environment.CC_MESSAGE_ID || '').trim() || null,
    source_chat_id: metadata.chat_id || sessionKey || null,
    operator_id: metadata.sender_id || null,
    source_text: sourceText,
  };
}

export function executeTool(service, name, rawArgs, environment, metadata, sourceText) {
  const babyId = Number(environment.BABYNOTE_AGENT_BABY_ID || 3);
  const args = { ...rawArgs, baby_id: babyId };
  const context = contextFrom(environment, metadata, sourceText);
  switch (name) {
    case 'record_growth': return service.recordGrowth(args, context);
    case 'get_baby_profile': return service.getBabyProfile(args);
    case 'get_growth_history': return service.getGrowthHistory(args);
    case 'list_solid_foods': return service.listSolidFoods(args);
    case 'set_food_status': return service.setFoodStatus(args, context);
    case 'record_milk': return service.recordMilk(args, context);
    case 'start_sleep': return service.startSleep(args, context);
    case 'end_sleep': return service.endSleep(args, context);
    case 'record_solid_meal': return service.recordSolidMeal(args, context);
    case 'get_latest_feeding': return service.getLatestFeeding(args);
    case 'get_latest_wake': return service.getLatestWake(args);
    case 'get_summary': return service.getPeriodSummary(args);
    case 'get_meal_plan': return { ok: true, plan: service.getMealPlan(args) };
    case 'build_daily_reminder': return service.buildDailyReminder(args);
    default: throw new Error(`Unsupported BabyNote tool: ${name}`);
  }
}

function toolError(error) {
  return {
    ok: false,
    code: error.code || 'agent_tool_error',
    error: error.message || '工具执行失败',
    ...(error.details ? { details: error.details } : {}),
  };
}

export async function runLocalTurn(options) {
  const environment = options.environment || process.env;
  return traceAttempt({ provider: 'local', model: environment.BABYNOTE_LOCAL_MODEL || DEFAULT_MODEL,
    reasoning: environment.BABYNOTE_LOCAL_THINK || DEFAULT_THINK }, () => runToolTurn(options));
}

export async function runToolTurn({
  prompt,
  service,
  environment = process.env,
  fetchImpl = fetch,
  now = new Date(),
  history = [],
}) {
  const { metadata, text } = extractIncomingPrompt(prompt);
  if (hasMultipleWriteIntents(text)) {
    return {
      ignored: false,
      reply: '一条消息只能记录一个动作，请拆成两条发送。',
      toolName: null,
      usage: {},
    };
  }

  const baseUrl = String(environment.BABYNOTE_LOCAL_BASE_URL || DEFAULT_OLLAMA_URL);
  const model = String(environment.BABYNOTE_LOCAL_MODEL || DEFAULT_MODEL);
  const think = normalizeThink(environment.BABYNOTE_LOCAL_THINK);
  const keepAlive = String(environment.BABYNOTE_LOCAL_KEEP_ALIVE || '24h').trim() || '24h';
  const timeoutMs = Number(environment.BABYNOTE_LOCAL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  let messages = [
    { role: 'system', content: buildSystemPrompt(now, text) },
    ...normalizeConversationHistory(history),
    { role: 'user', content: text },
  ];
  let first = await callOllamaWithRetry(
    { fetchImpl, baseUrl, model, messages, timeoutMs, think, keepAlive },
    'initial',
  );
  let calls = Array.isArray(first.message.tool_calls) ? first.message.tool_calls : [];

  const expectedTool = expectedToolForText(text);

  // A short local model can copy an earlier confirmation from conversation
  // history instead of selecting a tool. Retry data operations without old
  // turns and with an explicit tool-selection instruction before failing.
  if (!calls.length && expectsTool(text) && !isClarifyingQuestion(first.message.content)) {
    messages = [
      {
        role: 'system',
        content: `${buildSystemPrompt(now, text)}\n当前请求涉及 BabyNote 数据操作。必须先调用对应工具并等待工具结果，绝不能直接说“已记录”或编造数据库结果。信息不足时只提出一个澄清问题。`,
      },
      { role: 'user', content: text },
    ];
    first = await callOllamaWithRetry(
      { fetchImpl, baseUrl, model, messages, timeoutMs, think, keepAlive },
      'tool-selection recovery',
    );
    calls = Array.isArray(first.message.tool_calls) ? first.message.tool_calls : [];
  }

  // For unambiguous voice phrases, do not let a small model execute a nearby
  // but wrong read/write tool (for example today's total vs. latest feeding).
  // One focused retry is cheaper and safer than writing or answering from the
  // wrong operation.
  if (calls.length === 1 && expectedTool) {
    const selectedTool = String(calls[0]?.function?.name || '');
    if (selectedTool !== expectedTool) {
      messages = [
        {
          role: 'system',
          content: `${buildSystemPrompt(now, text)}\n工具选择错误。当前消息只能调用 ${expectedTool}，禁止调用 ${selectedTool}；必须重新选择正确工具。`,
        },
        { role: 'user', content: text },
      ];
      first = await callOllamaWithRetry(
        { fetchImpl, baseUrl, model, messages, timeoutMs, think, keepAlive },
        'tool-selection correction',
      );
      calls = Array.isArray(first.message.tool_calls) ? first.message.tool_calls : [];
    }
  }

  if (!calls.length) {
    const reply = normalizeReply(first.message.content);
    if (!reply) throw new Error('Local model returned neither a reply nor a tool call.');
    if (expectsTool(text) && !isClarifyingQuestion(reply)) {
      throw new Error('Local model answered a data operation without using a BabyNote tool.');
    }
    return { ignored: false, reply, toolName: null, usage: usageFrom(first) };
  }
  if (calls.length !== 1) throw new Error('Local model attempted more than one tool call.');

  const functionCall = calls[0]?.function || {};
  const toolName = String(functionCall.name || '');
  if (expectedTool && toolName !== expectedTool) {
    throw new Error(`Local model selected ${toolName || '(empty)'}; expected ${expectedTool}.`);
  }
  if (!TOOL_DEFINITIONS.some((definition) => definition.function.name === toolName)) {
    throw new Error(`Local model attempted unsupported tool ${toolName || '(empty)'}.`);
  }
  const args = normalizeTrustedSummaryArguments(
    text,
    toolName,
    toolName === 'record_solid_meal'
      ? normalizeSolidArguments(
        text,
        normalizeTrustedArguments(text, toolName, normalizeToolArguments(functionCall.arguments)),
      )
      : normalizeTrustedArguments(text, toolName, normalizeToolArguments(functionCall.arguments)),
    now,
  );
  if (toolName === 'record_solid_meal') {
    const validationReply = validateSolidToolInput(text, args);
    if (validationReply) {
      return {
        ignored: false,
        reply: validationReply,
        toolName: null,
        usage: usageFrom(first),
      };
    }
  }
  let result;
  try {
    result = executeTool(service, toolName, args, environment, metadata, text);
  } catch (error) {
    result = toolError(error);
  }

  if (result?.ok === false) {
    recordTool(toolName, args, result);
    console.warn(`[Agent] Tool ${toolName} failed: ${result.error || result.code || 'unknown error'}`);
    return {
      ignored: false,
      reply: `记录失败：${result.error || '工具执行失败，请稍后重试。'}`,
      toolName,
      toolArguments: args,
      toolResult: result,
      usage: usageFrom(first),
    };
  }

  recordTool(toolName, args, result);
  const readConfirmation = buildReadConfirmation(toolName, result, now);
  if (readConfirmation) {
    return {
      ignored: false,
      reply: readConfirmation,
      toolName,
      toolArguments: args,
      toolResult: result,
      usage: usageFrom(first),
    };
  }

  // Mutation results contain a trusted Beijing-local timestamp from the
  // domain layer. Generate confirmations from it directly instead of asking
  // the small model to reinterpret an ISO timestamp and risking a timezone
  // shift (or changing a grams unit while paraphrasing).
  if (WRITE_TOOLS.has(toolName)) {
    const confirmation = buildWriteConfirmation(toolName, result, args, now);
    if (confirmation) {
      return {
        ignored: false,
        reply: confirmation,
        toolName,
        toolArguments: args,
        toolResult: result,
        usage: usageFrom(first),
      };
    }
  }

  messages.push(first.message);
  messages.push({ role: 'tool', tool_name: toolName, content: JSON.stringify(result) });
  const second = await callOllamaWithRetry(
    { fetchImpl, baseUrl, model, messages, timeoutMs, think, keepAlive },
    'tool confirmation',
  );
  const followupCalls = Array.isArray(second.message.tool_calls) ? second.message.tool_calls : [];
  if (followupCalls.length) throw new Error('Local model attempted a second tool call in one message.');
  const reply = normalizeReply(second.message.content);
  if (!reply) throw new Error('Local model did not confirm the tool result.');

  return {
    ignored: false,
    reply,
    toolName,
    toolArguments: args,
    toolResult: result,
    usage: mergeUsage(first, second),
  };
}

function usageFrom(payload) {
  return {
    input_tokens: Number(payload?.prompt_eval_count || 0),
    output_tokens: Number(payload?.eval_count || 0),
  };
}

function mergeUsage(...payloads) {
  return payloads.reduce((usage, payload) => {
    const next = usageFrom(payload);
    usage.input_tokens += next.input_tokens;
    usage.output_tokens += next.output_tokens;
    return usage;
  }, { input_tokens: 0, output_tokens: 0 });
}

function resumeThreadId(args) {
  const resumeAt = args.indexOf('resume');
  if (resumeAt < 0) return randomUUID();
  const flagsWithValues = new Set([
    '-c', '--config', '--image', '--model', '-m', '--sandbox', '--cd', '-C',
    '--local-provider', '--profile', '-p', '--output-last-message', '-o',
  ]);
  for (let index = resumeAt + 1; index < args.length; index += 1) {
    const value = args[index];
    if (flagsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) continue;
    return value;
  }
  return randomUUID();
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function appendRouteLog(logPath, entry) {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    // Diagnostics must not prevent a reply.
  }
}

export function buildFallbackPrompt(rawPrompt) {
  const { metadata, text } = extractIncomingPrompt(rawPrompt);
  const sender = [
    metadata.sender_id ? `sender_id=${metadata.sender_id}` : '',
    metadata.chat_id ? `chat_id=${metadata.chat_id}` : '',
  ].filter(Boolean).join(' ');
  return [
    '你是 BabyNote 专用家庭带娃记录 Agent。支持宝宝档案、体重身长、食材排敏、奶量、睡眠、辅食、汇总、计划和提醒。',
    BABY_PROFILE_PROMPT,
    '涉及宝宝数据的查询和记录必须调用 babynote MCP；普通闲聊、问候和无关问题可以直接简短回答，不调用工具。可以连续调用多个工具完成用户所有动作，避免重复写入；排敏清单无需克数。信息不足时只问一个简短问题。',
    '不要提供医疗诊断。回复保持一条简短中文。',
    sender ? `[cc-connect ${sender}]` : '',
    text,
  ].filter(Boolean).join('\n\n');
}

export function filterFallbackOutput(stdout) {
  const kept = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    kept.push(line);
  }
  return kept.length ? `${kept.join('\n')}\n` : '';
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function runFallback(args, prompt, environment) {
  return new Promise((resolve) => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    // A dedicated local thread ID is not a Codex thread ID. Always start a
    // fresh, minimal Codex fallback turn instead of trying to resume it.
    const fallbackArgs = [
      'exec', '--skip-git-repo-check', '--json', '--cd', process.cwd(), '-',
    ];
    const child = spawn(process.execPath, [path.join(scriptDir, 'codex-router.js'), ...fallbackArgs], {
      cwd: process.cwd(),
      env: { ...environment, BABYNOTE_LOCAL_MODEL: '' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => resolve({ code: 1, stderr: error.message }));
    child.on('close', (code) => {
      process.stdout.write(filterFallbackOutput(stdout));
      resolve({ code: Number.isInteger(code) ? code : 1, stderr, stdout });
    });
    child.stdin.end(buildFallbackPrompt(prompt));
  });
}

async function main() {
  initDb();
  const args = process.argv.slice(2);
  const prompt = await readStandardInput();
  const { text, metadata } = extractIncomingPrompt(prompt);
  return traceRequest(db, { question: text, channel: metadata.source_channel || process.env.CC_PLATFORM || 'weixin',
    babyId: process.env.BABYNOTE_AGENT_BABY_ID }, () => runCli(args, prompt));
}

async function runCli(args, prompt) {
  const { gatewaySettings, runGatewayTurn } = await import('./gateway-turn.js');
  const gateway = gatewaySettings();
  const startedAt = Date.now();
  const logPath = String(process.env.BABYNOTE_MODEL_ROUTER_LOG || '').trim();
  const model = gateway?.model || String(process.env.BABYNOTE_LOCAL_MODEL || DEFAULT_MODEL);
  try {
    const result = gateway
      ? await runGatewayTurn({ settings: gateway, prompt, service: createAgentService(db) })
      : await runLocalTurn({ prompt, service: createAgentService(db) });
    const threadId = resumeThreadId(args);
    emit({ type: 'thread.started', thread_id: threadId });
    emit({ type: 'turn.started' });
    for (const turnTool of result.toolCalls || (result.toolName ? [{ name: result.toolName, arguments: result.toolArguments, result: result.toolResult }] : [])) {
      const itemId = `tool_${randomUUID()}`;
      emit({ type: 'item.started', item: {
        id: itemId,
        type: 'function_call',
        name: turnTool.name,
        arguments: JSON.stringify(turnTool.arguments),
        status: 'in_progress',
      } });
      emit({ type: 'item.completed', item: {
        id: itemId,
        type: 'function_call',
        name: turnTool.name,
        output: JSON.stringify(turnTool.result),
        status: 'completed',
      } });
    }
    if (!result.ignored) {
      emit({ type: 'item.completed', item: {
        id: `message_${randomUUID()}`,
        type: 'agent_message',
        text: result.reply,
      } });
    }
    emit({ type: 'turn.completed', usage: result.usage });
    appendRouteLog(logPath, {
      route: gateway ? 'gateway' : 'local-dedicated',
      model,
      durationMs: Date.now() - startedAt,
      tool: result.toolName,
      ignored: result.ignored,
      ...result.usage,
    });
    return result;
  } catch (error) {
    appendRouteLog(logPath, {
      route: gateway ? 'gateway-failed' : 'local-dedicated-failed',
      model,
      durationMs: Date.now() - startedAt,
      reason: error.name || 'Error',
      message: String(error.message || error).slice(0, 500),
    });
    if (gateway || process.env.BABYNOTE_DISABLE_FALLBACK === '1') throw error;
    return traceAttempt({ provider: 'cloud', model: process.env.BABYNOTE_FALLBACK_MODEL || 'gpt-5.6-luna', reasoning: 'configured' }, async () => {
      const fallback = await runFallback(args, prompt, process.env);
      if (fallback.code !== 0) throw new Error(fallback.stderr || 'Cloud fallback failed');
      const { parseCodexJsonl } = await import('./codex-turn.js');
      const parsed = parseCodexJsonl(fallback.stdout);
      if (!parsed.turnCompleted || parsed.turnFailed) throw new Error('Cloud fallback did not complete');
      const tool = parsed.businessCalls[0];
      return { reply: parsed.reply, usage: parsed.usage, toolName: tool?.name, toolArguments: tool?.arguments, toolResult: tool?.result };
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`BabyNote dedicated agent failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

export { TOOL_DEFINITIONS, WRITE_TOOLS };
