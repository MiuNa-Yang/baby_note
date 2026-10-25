#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { TOOL_DEFINITIONS } from './babynote-agent.js';
import { db, initDb } from '../db.js';
import { AgentInputError, createAgentService } from './domain.js';

initDb();
const service = createAgentService(db);
const defaultBabyId = Number(process.env.BABYNOTE_AGENT_BABY_ID || 3);

const server = new McpServer(
  { name: 'babynote-parenting-agent', version: '1.0.0' },
  {
    instructions: [
      '这是 BabyNote 的业务工具入口。可按用户请求连续查询和写入多个动作，完成后统一回答；不得重复写入。',
      '不要猜测时间、奶量或辅食用量。工具返回错误时，向用户提出一个简短澄清问题。',
      '每次回复只确认结果，不提供医疗诊断，不调用 Shell 修改数据。',
    ].join(''),
  },
);

function contextFrom(args, operation) {
  const sessionKey = String(process.env.CC_SESSION_KEY || '');
  const messageId = String(process.env.CC_MESSAGE_ID || '').trim();
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const signature = createHash('sha256').update(JSON.stringify([operation, canonical(args)])).digest('hex');
  return {
    source_channel: String(process.env.CC_PLATFORM || sessionKey.split(':')[0] || 'cc-connect'),
    source_message_id: messageId ? `${messageId}:${signature}` : null,
    source_chat_id: args.source_chat_id || sessionKey || null,
    operator_id: args.operator_id || null,
    source_text: args.source_text || process.env.CC_SOURCE_TEXT || null,
  };
}

function withDefaults(args) {
  return { ...args, baby_id: Number(args.baby_id || defaultBabyId) };
}

function response(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function failure(error) {
  const result = {
    ok: false,
    code: error.code || 'agent_tool_error',
    error: error.message || '工具执行失败',
    details: error.details || undefined,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: true,
  };
}

function registerTool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return response(handler(args));
    } catch (error) {
      if (!(error instanceof AgentInputError)) console.error(`${name}:`, error);
      return failure(error);
    }
  });
}

const metadataSchema = {
  baby_id: z.number().int().positive().optional().describe('宝宝 ID；通常省略并使用绑定宝宝'),
  source_text: z.string().max(2000).optional().describe('用户本次原始消息，去掉群聊触发字符 0'),
  operator_id: z.string().max(200).optional().describe('cc-connect 注入的发送者 ID；不得从用户正文猜测'),
  source_chat_id: z.string().max(300).optional().describe('cc-connect 注入的群或私聊标识'),
};

for (const [name, method, write] of [
  ['record_growth', 'recordGrowth', true], ['get_baby_profile', 'getBabyProfile'],
  ['get_growth_history', 'getGrowthHistory'], ['list_solid_foods', 'listSolidFoods'],
  ['set_food_status', 'setFoodStatus', true],
]) {
  const definition = TOOL_DEFINITIONS.find(tool => tool.function.name === name).function;
  const schema = z.fromJSONSchema(definition.parameters);
  registerTool(name, { description: definition.description, inputSchema: { ...schema.shape, ...metadataSchema } },
    args => service[method](withDefaults(args), write ? contextFrom(args, name) : undefined));
}

registerTool('record_milk', {
  description: '记录一次瓶喂奶量。只有用户明确表达已经喝了多少毫升时调用。',
  inputSchema: {
    ...metadataSchema,
    amount_ml: z.number().positive().max(1000).describe('本次已喝奶量，单位 ml'),
    time_text: z.string().optional().describe('用户原话中的时间，如“刚刚”“20分钟前”“下午2点半”'),
    note: z.string().max(500).optional(),
  },
}, (args) => service.recordMilk(withDefaults(args), contextFrom(args, 'record_milk')));

registerTool('start_sleep', {
  description: '记录宝宝开始睡眠。用户明确说睡了、睡着了或开始午睡时调用。',
  inputSchema: {
    ...metadataSchema,
    time_text: z.string().optional().describe('入睡时间；省略表示现在'),
    note: z.string().max(500).optional(),
  },
}, (args) => service.startSleep(withDefaults(args), contextFrom(args, 'start_sleep')));

registerTool('end_sleep', {
  description: '结束当前进行中的睡眠。用户明确说醒了时调用。',
  inputSchema: {
    ...metadataSchema,
    time_text: z.string().optional().describe('醒来时间；省略表示现在'),
  },
}, (args) => service.endSleep(withDefaults(args), contextFrom(args, 'end_sleep')));

registerTool('record_solid_meal', {
  description: '记录宝宝已经吃下的辅食。每种食物都必须有明确用量。',
  inputSchema: {
    ...metadataSchema,
    time_text: z.string().optional().describe('进食时间；省略表示现在'),
    items: z.array(z.object({
      food_id: z.number().int().positive().optional(),
      name: z.string().min(1).max(100),
      amount: z.number().positive().describe('食用量，统一按克填写'),
    })).min(1),
    note: z.string().max(500).optional(),
  },
}, (args) => service.recordSolidMeal(withDefaults(args), contextFrom(args, 'record_solid_meal')));

registerTool('get_latest_feeding', {
  description: '查询宝宝最近一次喝奶的时间、奶量，以及距今多久。没有记录时返回 found=false。',
  inputSchema: {
    baby_id: metadataSchema.baby_id,
  },
}, (args) => service.getLatestFeeding(withDefaults(args)));

registerTool('get_latest_wake', {
  description: '查询宝宝最近一次醒来的时间，以及已经醒了多久；如果当前正在睡，也返回当前睡眠状态。',
  inputSchema: {
    baby_id: metadataSchema.baby_id,
  },
}, (args) => service.getLatestWake(withDefaults(args)));

registerTool('get_summary', {
  description: '查询奶量、睡眠和辅食汇总。不传日期默认今天；传 date 查询单日；传 start_date 和 end_date 查询包含首尾日期的范围，最多 31 天。',
  inputSchema: {
    baby_id: metadataSchema.baby_id,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('北京时间日期，默认今天'),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('范围开始日期（含）'),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('范围结束日期（含）'),
  },
}, (args) => service.getPeriodSummary(withDefaults(args)));

registerTool('get_today_summary', {
  description: '兼容旧客户端：查询某天奶量、睡眠和辅食汇总。新请求请使用 get_summary。',
  inputSchema: {
    baby_id: metadataSchema.baby_id,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('北京时间日期，默认今天'),
  },
}, (args) => service.getTodaySummary(withDefaults(args)));

registerTool('get_meal_plan', {
  description: '查询指定日期的辅食计划。',
  inputSchema: {
    baby_id: metadataSchema.baby_id,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('北京时间日期，默认今天'),
  },
}, (args) => ({ ok: true, plan: service.getMealPlan(withDefaults(args)) }));

registerTool('build_daily_reminder', {
  description: '生成每日辅食提醒。只供 cc-connect 定时任务调用，返回的 message 应原样发送。',
  inputSchema: {
    baby_id: metadataSchema.baby_id,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  },
}, (args) => service.buildDailyReminder(withDefaults(args)));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('BabyNote MCP server failed:', error);
  process.exit(1);
});
