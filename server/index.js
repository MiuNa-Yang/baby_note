process.env.TZ = 'Asia/Shanghai';
import express from 'express';
import { getBeijingDate, getBeijingDateDaysAgo } from './date-utils.js';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb, db } from './db.js';
import { createAgentRouter } from './agent/routes.js';
import { createAgentOpenAiRouter } from './agent/openai-api.js';
import { takeoverSound } from './agent/takeover-sound.js';
import {
  askGuideAi,
  askGuideAiStream,
  createGuideAiSession,
  deleteGuideAiSession,
  getGuideAiSession,
  getGuideAiStatus,
  listGuideAiSessions,
  RagflowError,
} from './ragflow.js';
import { appendFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 确保 data 目录存在
import { mkdirSync, existsSync } from 'fs';
import { networkInterfaces } from 'os';
const dataDir = join(__dirname, '../data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}
const guidesDir = join(dataDir, 'guides');
if (!existsSync(guidesDir)) {
  mkdirSync(guidesDir, { recursive: true });
}

initDb();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/guides', express.static(guidesDir));

// 请求日志中间件（放在路由前，确保每个请求都能记录）
app.use((req, res, next) => {
  log(`${req.method} ${req.url}`);
  next();
});

app.use('/v1', createAgentOpenAiRouter(db));
const takeoverWav = takeoverSound();
app.get('/agent-takeover.wav', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').type('audio/wav').send(takeoverWav);
});
app.use('/api', createAgentRouter(db));

function parseDbDateTime(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return new Date(s.replace(' ', 'T') + 'Z');
  return new Date(s);
}

function parseRecordDateFlexible(value, now = new Date()) {
  const s = String(value || '').trim();
  if (!s) return null;

  const parsed = parseDbDateTime(s);
  if (!parsed || Number.isNaN(parsed.getTime())) return null;

  // 历史数据可能混有“本地时间字符串(无时区)”与“UTC字符串”。
  // 若按 UTC 解析后落在未来明显偏移（常见 +8h），回退为本地时间解析。
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) {
    const localParsed = new Date(s.replace(' ', 'T'));
    if (!Number.isNaN(localParsed.getTime())) {
      const futureToleranceMs = 5 * 60 * 1000;
      if (parsed.getTime() > now.getTime() + futureToleranceMs) return localParsed;
    }
  }
  return parsed;
}

function computeRecent24hFeedingStats(babyId, now = new Date()) {
  const id = Number(babyId);
  if (!Number.isFinite(id) || id <= 0) {
    return { count: 0, totalMl: 0 };
  }

  const feedingCandidates = db.prepare(`
    SELECT created_at, amount_ml
    FROM records
    WHERE baby_id = ? AND type = 'feeding' AND amount_ml IS NOT NULL
    ORDER BY id DESC
    LIMIT 2000
  `).all(id);

  const cutoffMs = now.getTime() - 24 * 60 * 60 * 1000;
  let count = 0;
  let totalMl = 0;
  for (const row of feedingCandidates) {
    const t = parseRecordDateFlexible(row?.created_at, now);
    if (!t || Number.isNaN(t.getTime())) continue;
    const ts = t.getTime();
    if (ts >= cutoffMs && ts <= now.getTime()) {
      count += 1;
      totalMl += Number(row?.amount_ml || 0);
    }
  }
  return { count, totalMl: Math.round(totalMl) };
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function getBeijingParts(date) {
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function atBeijingTime(base, hour, minute = 0) {
  const p = getBeijingParts(base);
  return new Date(Date.UTC(p.year, p.month, p.date, hour, minute, 0, 0) - BEIJING_OFFSET_MS);
}

function normalizeClientDateTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const localMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (localMatch) {
    const [, year, month, day, hour, minute, second = '0'] = localMatch;
    return new Date(Date.UTC(
      Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)
    ) - BEIJING_OFFSET_MS).toISOString();
  }
  const parsed = parseRecordDateFlexible(text);
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function sameBeijingDate(a, b) {
  const ap = getBeijingParts(a);
  const bp = getBeijingParts(b);
  return ap.year === bp.year && ap.month === bp.month && ap.date === bp.date;
}

function computeFeedingReminder({ lastFeedingAt, now }) {
  const intervalMinutes = 180;
  const { hour } = getBeijingParts(now);
  let nextFeedingAt = null;

  if (hour >= 18) {
    nextFeedingAt = atBeijingTime(now, 24);
  } else if (hour < 5) {
    nextFeedingAt = atBeijingTime(now, 5);
  } else {
    const dayStart = atBeijingTime(now, 5);
    const dayEnd = atBeijingTime(now, 18);
    const hasDaytimeFeeding = lastFeedingAt
      && sameBeijingDate(lastFeedingAt, now)
      && lastFeedingAt >= dayStart
      && lastFeedingAt < dayEnd;
    const baseTime = hasDaytimeFeeding ? lastFeedingAt : now;
    const candidate = new Date(baseTime.getTime() + intervalMinutes * 60000);
    nextFeedingAt = candidate < dayEnd ? candidate : atBeijingTime(now, 24);
  }

  const diffMs = nextFeedingAt.getTime() - now.getTime();
  const remainingMinutes = diffMs >= 0 ? Math.ceil(diffMs / 60000) : Math.floor(diffMs / 60000);

  return {
    intervalMinutes,
    nextFeedingAt: nextFeedingAt.toISOString(),
    remainingMinutes,
    overdueMinutes: diffMs < 0 ? Math.abs(Math.floor(diffMs / 60000)) : 0,
    isFeedingDue: diffMs <= 0,
  };
}

const SOLID_REACTIONS = [
  { key: 'vomiting', label: '呕吐' },
  { key: 'diarrhea', label: '腹泻' },
  { key: 'constipation', label: '便秘' },
  { key: 'perioral_rash', label: '嘴周红疹' },
  { key: 'generalized_rash', label: '全身红疹' },
  { key: 'bloating_abdominal_pain', label: '腹胀/腹痛' },
  { key: 'other', label: '其他' },
];

const DEFAULT_SOLID_FOODS = [
  ['大米', '谷物', null], ['小米', '谷物', null], ['燕麦', '谷物', null], ['小麦', '谷物', '小麦'],
  ['玉米', '谷物', null], ['红薯', '谷物', null], ['土豆', '谷物', null],
  ['南瓜', '蔬菜', null], ['胡萝卜', '蔬菜', null], ['西兰花', '蔬菜', null], ['菠菜', '蔬菜', null],
  ['菜花', '蔬菜', null], ['豌豆', '蔬菜', null], ['番茄', '蔬菜', null],
  ['香蕉', '水果', null], ['苹果', '水果', null], ['梨', '水果', null], ['牛油果', '水果', null],
  ['桃', '水果', null], ['草莓', '水果', null],
  ['鸡肉', '肉禽', null], ['猪肉', '肉禽', null], ['牛肉', '肉禽', null], ['羊肉', '肉禽', null],
  ['鸡蛋', '蛋奶', '鸡蛋'], ['牛奶', '蛋奶', '牛奶'], ['酸奶', '蛋奶', '牛奶'],
  ['豆腐', '豆类', '大豆'], ['黄豆', '豆类', '大豆'],
  ['鳕鱼', '鱼虾', '鱼类'], ['三文鱼', '鱼虾', '鱼类'], ['虾', '鱼虾', '甲壳类'],
  ['花生', '坚果/种子', '花生'], ['芝麻', '坚果/种子', '芝麻'], ['核桃', '坚果/种子', '树坚果'],
];

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensureSolidFoodCatalog(babyId) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO solid_foods (baby_id, name, category, allergen_group)
    VALUES (?, ?, ?, ?)
  `);
  const transaction = db.transaction(() => {
    for (const [name, category, allergenGroup] of DEFAULT_SOLID_FOODS) {
      insert.run(babyId, name, category, allergenGroup);
    }
  });
  transaction();
}

function normalizeSolidReactionKeys(value) {
  const allowed = new Set(SOLID_REACTIONS.map((item) => item.key));
  const keys = [...new Set(parseJsonArray(value).map((item) => String(item)).filter((item) => allowed.has(item)))];
  return keys;
}

function supplementKey(record) {
  const text = [record?.medicine_name || '', record?.medicine_amount || '', record?.note || '']
    .join(' ')
    .toLowerCase()
    .replaceAll(' ', '');
  if (text.includes('dha')) return 'dha';
  if (text.includes('维生素d3') || text.includes('维生素d') || /(^|[^a-z])d3([^a-z]|$)/.test(text)) return 'd3';
  if (text.includes('维生素ad') || text.includes('ad补给') || text.includes('adsupplement') || /(^|[^a-z])ad([^a-z]|$)/.test(text)) return 'ad';
  return null;
}

function getSupplementPlan(now = new Date()) {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const weekday = shifted.getUTCDay();
  const plan = weekday === 0
    ? [{ key: 'ad', label: 'AD' }, { key: 'dha', label: 'DHA' }]
    : [{ key: 'd3', label: 'D3' }];
  return { weekday, plan };
}

function getSupplementReminder(babyId, now = new Date()) {
  const { weekday, plan } = getSupplementPlan(now);
  const today = getBeijingDate(now);
  const records = db.prepare(`
    SELECT id, created_at, medicine_name, medicine_amount, note
    FROM records
    WHERE baby_id = ? AND type = 'medication'
      AND date(created_at, '+8 hours') = date(?)
    ORDER BY created_at DESC, id DESC
  `).all(babyId, today);
  const takenKeys = [...new Set(records.map(supplementKey).filter(Boolean))];
  const taken = plan.filter((item) => takenKeys.includes(item.key));
  const pending = plan.filter((item) => !takenKeys.includes(item.key));
  return {
    date: today,
    weekday,
    plan,
    taken,
    pending,
    isComplete: pending.length === 0,
  };
}

function formatSolidMeal(row) {
  return {
    ...row,
    solid_items: parseJsonArray(row.solid_items_json),
    reaction_types: normalizeSolidReactionKeys(row.reaction_types_json),
    suspected_food_ids: parseJsonArray(row.suspected_food_ids_json).map(Number).filter(Number.isFinite),
  };
}

function getSolidMeals(babyId, dateFrom, dateTo) {
  let sql = `SELECT * FROM records WHERE baby_id = ? AND type = 'solid_meal'`;
  const params = [babyId];
  if (dateFrom) { sql += ` AND date(created_at, '+8 hours') >= date(?)`; params.push(dateFrom); }
  if (dateTo) { sql += ` AND date(created_at, '+8 hours') <= date(?)`; params.push(dateTo); }
  sql += ' ORDER BY created_at DESC, id DESC';
  return db.prepare(sql).all(...params).map(formatSolidMeal);
}

function solidDateKey(value) {
  const date = parseRecordDateFlexible(value);
  return date ? getBeijingDate(date) : '';
}

function deriveSolidFoodSummary(babyId) {
  ensureSolidFoodCatalog(babyId);
  const foods = db.prepare('SELECT * FROM solid_foods WHERE baby_id = ? ORDER BY category, name').all(babyId);
  const stats = new Map(foods.map((food) => [Number(food.id), {
    attempts: 0,
    totalGrams: 0,
    lastTriedAt: null,
    latestReactions: [],
    linkedReaction: false,
    unattributedReaction: false,
  }]));

  for (const meal of getSolidMeals(babyId)) {
    const reactions = meal.reaction_types || [];
    const suspected = new Set(meal.suspected_food_ids || []);
    for (const item of meal.solid_items || []) {
      const foodId = Number(item.food_id);
      const stat = stats.get(foodId);
      if (!stat) continue;
      stat.attempts += 1;
      stat.totalGrams += Number(item.grams || 0);
      if (!stat.lastTriedAt || new Date(meal.created_at).getTime() > new Date(stat.lastTriedAt).getTime()) {
        stat.lastTriedAt = meal.created_at;
      }
      if (reactions.length && suspected.has(foodId)) {
        stat.linkedReaction = true;
        stat.latestReactions = reactions;
      } else if (reactions.length) {
        stat.unattributedReaction = true;
      }
    }
  }

  return foods.map((food) => {
    const stat = stats.get(Number(food.id));
    let status = 'unknown';
    let statusLabel = '未尝试 / 待判断';
    let statusSource = 'derived';
    if (food.manual_status === 'confirmed_allergy') {
      status = 'confirmed_allergy';
      statusLabel = '已确认过敏';
      statusSource = 'manual';
    } else if (food.manual_status === 'confirmed_safe') {
      status = 'confirmed_safe';
      statusLabel = '已确认无异常';
      statusSource = 'manual';
    } else if (stat.linkedReaction) {
      status = 'suspected';
      statusLabel = '疑似异常';
    } else if (stat.attempts > 0 && !stat.unattributedReaction) {
      status = 'no_reaction';
      statusLabel = '暂无异常记录';
    }
    return {
      ...food,
      attempts: stat.attempts,
      total_grams: Math.round(stat.totalGrams * 10) / 10,
      last_tried_at: stat.lastTriedAt,
      latest_reactions: stat.latestReactions,
      status,
      status_label: statusLabel,
      status_source: statusSource,
      has_unattributed_reaction: stat.unattributedReaction,
    };
  });
}

function normalizeSolidMealPayload(babyId, body) {
  ensureSolidFoodCatalog(babyId);
  const inputItems = Array.isArray(body?.items)
    ? body.items
    : Array.isArray(body?.solid_items)
      ? body.solid_items
      : [];
  if (!inputItems.length) throw new Error('至少添加一种辅食');

  const findFoodStmt = db.prepare('SELECT * FROM solid_foods WHERE id = ? AND baby_id = ?');
  const findFood = (foodId, ownerBabyId) => findFoodStmt.get(foodId, ownerBabyId);
  const findByName = db.prepare('SELECT * FROM solid_foods WHERE baby_id = ? AND name = ?');
  const insertFood = db.prepare(`
    INSERT INTO solid_foods (baby_id, name, category, allergen_group)
    VALUES (?, ?, ?, ?)
  `);
  const items = [];
  for (const raw of inputItems) {
    const name = String(raw?.name || '').trim();
    const grams = Number(raw?.grams);
    if (!name) throw new Error('辅食名称不能为空');
    if (!Number.isFinite(grams) || grams <= 0) throw new Error('辅食克数必须大于 0');
    let food = raw?.food_id ? findFood(Number(raw.food_id), babyId) : null;
    if (!food) food = findByName.get(babyId, name);
    if (!food) {
      const result = insertFood.run(babyId, name, String(raw?.category || '其他'), raw?.allergen_group || null);
      food = db.prepare('SELECT * FROM solid_foods WHERE id = ?').get(result.lastInsertRowid);
    }
    items.push({
      food_id: Number(food.id),
      name: food.name,
      category: food.category,
      grams: Math.round(grams * 10) / 10,
    });
  }

  const reactionTypes = normalizeSolidReactionKeys(body?.reaction_types);
  const itemFoodIds = new Set(items.map((item) => item.food_id));
  const suspectedFoodIds = [...new Set(parseJsonArray(body?.suspected_food_ids)
    .map(Number)
    .filter((id) => itemFoodIds.has(id)))];
  return {
    createdAt: normalizeClientDateTime(body?.eaten_at || body?.created_at),
    items,
    reactionTypes,
    reactionNote: String(body?.reaction_note || '').trim() || null,
    suspectedFoodIds,
    note: String(body?.note || '').trim() || null,
  };
}

function getRecorderInfo(req) {
  return {
    recorder_id: req.body?.recorder_id || req.headers['x-recorder-id'] || null,
    recorder_name: req.body?.recorder_name || req.headers['x-recorder-name'] || null,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    user_agent: req.headers['user-agent'] || null,
  };
}

function formatNowInShanghai(date = new Date()) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function formatShanghaiDate(date) {
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function splitSleepRecordByLocalDay(record) {
  const start = new Date(record.sleep_start);
  const end = new Date(record.sleep_end);
  if (
    !record.sleep_start ||
    !record.sleep_end ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end <= start
  ) {
    return [];
  }

  const segments = [];
  let cursor = start;
  while (cursor < end) {
    const nextMidnight = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + 1,
      0,
      0,
      0,
      0
    );
    const segmentEnd = end < nextMidnight ? end : nextMidnight;
    const duration = Math.round((segmentEnd - cursor) / 60000);
    if (duration > 0) {
      segments.push({
        source_id: record.id,
        date: formatShanghaiDate(cursor),
        start: cursor.toISOString(),
        end: segmentEnd.toISOString(),
        duration_minutes: duration,
      });
    }
    cursor = segmentEnd;
  }
  return segments;
}

async function fetchShanghaiPudongWeather() {
  const format = '%l:+%c+%t+%h+%w';
  const url = `https://wttr.in/Shanghai+Pudong?format=${encodeURIComponent(format)}&m`;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 5000);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'babynote-server/1.0',
      },
      signal: abortController.signal,
    });
    if (!resp.ok) throw new Error(`weather http ${resp.status}`);
    const text = String(await resp.text() || '').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('weather empty response');
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function mapOpenMeteoWeatherCode(code) {
  const n = Number(code);
  if (n === 0) return '晴';
  if ([1, 2].includes(n)) return '少云';
  if (n === 3) return '多云';
  if ([45, 48].includes(n)) return '雾';
  if ([51, 53, 55, 56, 57].includes(n)) return '毛毛雨';
  if ([61, 63, 65, 66, 67].includes(n)) return '雨';
  if ([71, 73, 75, 77].includes(n)) return '雪';
  if ([80, 81, 82].includes(n)) return '阵雨';
  if ([85, 86].includes(n)) return '阵雪';
  if ([95, 96, 99].includes(n)) return '雷雨';
  return `天气码${Number.isFinite(n) ? n : '未知'}`;
}

async function fetchShanghaiPudongWeatherOpenMeteo() {
  // 上海浦东近似坐标
  const lat = 31.2304;
  const lon = 121.5444;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current_weather=true&timezone=Asia%2FShanghai';
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 5000);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'babynote-server/1.0',
      },
      signal: abortController.signal,
    });
    if (!resp.ok) throw new Error(`open-meteo http ${resp.status}`);
    const data = await resp.json();
    const current = data?.current_weather;
    if (!current) throw new Error('open-meteo current_weather missing');
    const condition = mapOpenMeteoWeatherCode(current.weathercode);
    const temp = Number(current.temperature);
    const wind = Number(current.windspeed);
    const windPart = Number.isFinite(wind) ? `${wind}km/h` : '未知风速';
    const tempPart = Number.isFinite(temp) ? `${temp}°C` : '未知温度';
    return `Shanghai+Pudong(Open-Meteo): ${condition} ${tempPart} ${windPart}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildRealtimeContextText() {
  const now = formatNowInShanghai(new Date());
  let weatherLine = '上海浦东: 天气暂时不可用';
  try {
    weatherLine = await fetchShanghaiPudongWeather();
  } catch (wttrError) {
    log(JSON.stringify({
      event: 'weather_fetch_error',
      source: 'wttr.in',
      message: wttrError?.message || String(wttrError),
    }));
    try {
      weatherLine = await fetchShanghaiPudongWeatherOpenMeteo();
    } catch (meteoError) {
      log(JSON.stringify({
        event: 'weather_fetch_error',
        source: 'open-meteo',
        message: meteoError?.message || String(meteoError),
      }));
    }
  }
  return [
    `当前日期时间(Asia/Shanghai): ${now}`,
    `上海浦东天气: ${weatherLine}`,
  ].join('\n');
}

function buildBabyInfoText(babyId) {
  const id = Number(babyId);
  if (!Number.isFinite(id) || id <= 0) {
    return '未选择宝宝。';
  }

  const baby = db.prepare('SELECT id, name, birthdate, created_at FROM babies WHERE id = ?').get(id);
  if (!baby) return `未找到 id=${id} 的宝宝信息。`;

  const birth = baby.birthdate ? new Date(baby.birthdate) : null;
  const now = new Date();
  const ageDays = birth && !Number.isNaN(birth.getTime())
    ? Math.max(0, Math.floor((now.getTime() - birth.getTime()) / (1000 * 60 * 60 * 24)))
    : null;
  const ageMonths = ageDays === null ? null : Math.floor(ageDays / 30.4375);
  const latestFeedings = db.prepare(`
    SELECT created_at, amount_ml, feeding_type
    FROM records
    WHERE baby_id = ? AND type = 'feeding' AND amount_ml IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 3
  `).all(id);
  // 注意：created_at 在历史数据中可能混有 UTC 与本地时间格式。
  // 为避免 SQL 字符串/时区比较误差，统一在 JS 侧按 parseDbDateTime 计算最近24小时。
  const recent24hStats = computeRecent24hFeedingStats(id, now);
  const feedingCount24h = recent24hStats.count;
  const feedingTotalMl24h = recent24hStats.totalMl;

  const segments = [
    `宝宝ID: ${baby.id}`,
    `宝宝姓名: ${baby.name || '未知'}`,
    `生日: ${baby.birthdate || '未知'}`,
    '宝宝性别: 男宝',
    '喂养方式: 纯奶粉喂养',
  ];
  if (ageDays !== null) segments.push(`当前月龄约: ${ageMonths}个月（${ageDays}天）`);
  segments.push(`最近24小时喂奶统计: 总量 ${feedingTotalMl24h}ml，次数 ${feedingCount24h}次`);
  if (Array.isArray(latestFeedings) && latestFeedings.length > 0) {
    const feedingLines = latestFeedings
      .map((item, index) => `${index + 1}. ${item.amount_ml}ml（喂奶时间: ${item.created_at || '未知'}）`)
      .join('\n');
    segments.push(`最近三次奶量与喂奶时间:\n${feedingLines}`);
  } else {
    segments.push('最近三次奶量与喂奶时间: 暂无记录');
  }

  return segments.join('\n');
}

// Guide AI (RAGFlow)
app.get('/api/guide-ai/status', async (req, res) => {
  try {
    const status = await getGuideAiStatus(dataDir);
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/guide-ai/session', async (req, res) => {
  try {
    const session = await createGuideAiSession(dataDir, {
      name: req.body?.name,
      userId: req.body?.user_id,
    });
    res.json(session);
  } catch (e) {
    if (e instanceof RagflowError) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/guide-ai/sessions', async (req, res) => {
  try {
    const sessions = await listGuideAiSessions(dataDir, {
      page: req.query?.page ? Number(req.query.page) : 1,
      pageSize: req.query?.page_size ? Number(req.query.page_size) : 50,
    });
    res.json({ sessions });
  } catch (e) {
    if (e instanceof RagflowError) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/guide-ai/sessions/:id', async (req, res) => {
  try {
    const session = await getGuideAiSession(dataDir, { sessionId: req.params.id });
    res.json(session);
  } catch (e) {
    if (e instanceof RagflowError) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/guide-ai/sessions/:id', async (req, res) => {
  try {
    const result = await deleteGuideAiSession(dataDir, { sessionId: req.params.id });
    res.json(result);
  } catch (e) {
    if (e instanceof RagflowError) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/guide-ai/chat', async (req, res) => {
  try {
    const babyInfo = buildBabyInfoText(req.body?.baby_id);
    const realtimeContext = await buildRealtimeContextText();
    const traceId = `guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    log(JSON.stringify({
      event: 'guide_ai_request',
      trace_id: traceId,
      stream: false,
      baby_id: req.body?.baby_id ?? null,
      session_id: req.body?.session_id ?? null,
      question_preview: String(req.body?.question || '').slice(0, 120),
      has_baby_info: Boolean(String(babyInfo || '').trim()),
      baby_info_preview: String(babyInfo || '').slice(0, 160),
      has_realtime_context: Boolean(String(realtimeContext || '').trim()),
      realtime_context_preview: String(realtimeContext || '').slice(0, 160),
    }));

    const answer = await askGuideAi(dataDir, {
      question: req.body?.question,
      sessionId: req.body?.session_id,
      messages: req.body?.messages,
      variables: {
        babyInfo,
        realtimeContext,
      },
    });
    log(JSON.stringify({
      event: 'guide_ai_model_output',
      trace_id: traceId,
      stream: false,
      session_id: answer?.session_id || req.body?.session_id || null,
      message_id: answer?.message_id || null,
      answer: String(answer?.answer || ''),
      thinking: String(answer?.thinking || ''),
      usage: answer?.usage || null,
      references: Array.isArray(answer?.references)
        ? answer.references.map((r) => ({
          citation_id: r?.citation_id ?? null,
          document_name: r?.document_name || null,
          dataset_id: r?.dataset_id || null,
        }))
        : [],
      frontend_payload: answer,
    }));
    log(JSON.stringify({
      event: 'guide_ai_success',
      trace_id: traceId,
      stream: false,
      session_id: answer?.session_id || req.body?.session_id || null,
      answer_len: String(answer?.answer || '').length,
      references_count: Array.isArray(answer?.references) ? answer.references.length : 0,
    }));
    res.json(answer);
  } catch (e) {
    log(JSON.stringify({
      event: 'guide_ai_error',
      stream: false,
      message: e?.message || String(e),
    }));
    if (e instanceof RagflowError) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/guide-ai/chat/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const abortController = new AbortController();
  req.on('aborted', () => abortController.abort());
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  const sendEvent = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const babyInfo = buildBabyInfoText(req.body?.baby_id);
    const realtimeContext = await buildRealtimeContextText();
    const traceId = `guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let deltaChunks = 0;
    let referencesCount = 0;
    let doneSessionId = req.body?.session_id || null;
    let finalAnswer = '';
    let finalThinking = '';
    let finalMessageId = null;
    let finalUsage = null;
    let finalReferences = [];
    let finalDonePayload = null;

    log(JSON.stringify({
      event: 'guide_ai_request',
      trace_id: traceId,
      stream: true,
      baby_id: req.body?.baby_id ?? null,
      session_id: req.body?.session_id ?? null,
      question_preview: String(req.body?.question || '').slice(0, 120),
      has_baby_info: Boolean(String(babyInfo || '').trim()),
      baby_info_preview: String(babyInfo || '').slice(0, 160),
      has_realtime_context: Boolean(String(realtimeContext || '').trim()),
      realtime_context_preview: String(realtimeContext || '').slice(0, 160),
    }));

    for await (const chunk of askGuideAiStream(dataDir, {
      question: req.body?.question,
      sessionId: req.body?.session_id,
      messages: req.body?.messages,
      signal: abortController.signal,
      variables: {
        babyInfo,
        realtimeContext,
      },
    })) {
      if (chunk.type === 'delta') {
        deltaChunks += 1;
        if (chunk?.session_id) doneSessionId = chunk.session_id;
        sendEvent('delta', chunk);
      } else if (chunk.type === 'thinking') {
        if (chunk?.session_id) doneSessionId = chunk.session_id;
        sendEvent('thinking', chunk);
      } else if (chunk.type === 'references') {
        referencesCount = Array.isArray(chunk?.references) ? chunk.references.length : 0;
        finalReferences = Array.isArray(chunk?.references) ? chunk.references : finalReferences;
        sendEvent('references', chunk);
      } else if (chunk.type === 'done') {
        if (chunk?.session_id) doneSessionId = chunk.session_id;
        finalAnswer = String(chunk?.answer || finalAnswer || '');
        finalThinking = String(chunk?.thinking || finalThinking || '');
        finalMessageId = chunk?.message_id || finalMessageId;
        finalUsage = chunk?.usage || finalUsage;
        if (Array.isArray(chunk?.references)) finalReferences = chunk.references;
        finalDonePayload = chunk;
        sendEvent('done', chunk);
      }
    }

    log(JSON.stringify({
      event: 'guide_ai_model_output',
      trace_id: traceId,
      stream: true,
      session_id: doneSessionId,
      message_id: finalMessageId,
      answer: finalAnswer,
      thinking: finalThinking,
      usage: finalUsage,
      references: Array.isArray(finalReferences)
        ? finalReferences.map((r) => ({
          citation_id: r?.citation_id ?? null,
          document_name: r?.document_name || null,
          dataset_id: r?.dataset_id || null,
        }))
        : [],
      frontend_done_payload: finalDonePayload,
      frontend_response: {
        answer: finalAnswer,
        thinking: finalThinking,
        session_id: doneSessionId,
        message_id: finalMessageId,
        references: finalReferences,
        usage: finalUsage,
      },
    }));
    log(JSON.stringify({
      event: 'guide_ai_success',
      trace_id: traceId,
      stream: true,
      session_id: doneSessionId,
      delta_chunks: deltaChunks,
      references_count: referencesCount,
    }));
  } catch (e) {
    log(JSON.stringify({
      event: 'guide_ai_error',
      stream: true,
      message: e?.message || String(e),
    }));
    const status = e instanceof RagflowError ? e.status || 500 : 500;
    sendEvent('error', { error: e?.message || String(e), status });
  } finally {
    res.end();
  }
});

// 宝宝相关 API
app.get('/api/babies', (req, res) => {
  try {
    const babies = db.prepare('SELECT * FROM babies ORDER BY created_at DESC').all();
    res.json(babies);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/babies', (req, res) => {
  try {
    const { name, birthdate } = req.body;
    const result = db.prepare('INSERT INTO babies (name, birthdate) VALUES (?, ?)').run(name, birthdate);
    res.json({ id: result.lastInsertRowid, name, birthdate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/babies/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, birthdate } = req.body;
    db.prepare('UPDATE babies SET name = ?, birthdate = ? WHERE id = ?').run(name, birthdate, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/babies/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM records WHERE baby_id = ?').run(id);
    db.prepare('DELETE FROM solid_foods WHERE baby_id = ?').run(id);
    db.prepare('DELETE FROM babies WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 记录相关 API
app.get('/api/records', (req, res) => {
  try {
    const { baby_id, type, date_from, date_to, paged, page = 1, page_size = 20 } = req.query;
    let sql = 'SELECT * FROM records WHERE 1=1';
    const params = [];
    if (baby_id) { sql += ' AND baby_id = ?'; params.push(baby_id); }
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (date_from) { sql += ' AND date(created_at, \'+8 hours\') >= date(?)'; params.push(date_from); }
    if (date_to) { sql += ' AND date(created_at, \'+8 hours\') <= date(?)'; params.push(date_to); }
    const getRecordTimeline = (record) => {
      if (record?.type === 'sleep') {
        return record.sleep_end || record.sleep_start || record.created_at;
      }
      return record?.created_at;
    };
    const sortRecordsByTimeline = (rows) => rows.sort((a, b) => {
      const at = parseRecordDateFlexible(getRecordTimeline(a))?.getTime() || 0;
      const bt = parseRecordDateFlexible(getRecordTimeline(b))?.getTime() || 0;
      if (bt !== at) return bt - at;
      return Number(b.id || 0) - Number(a.id || 0);
    });
    const usePaged = String(paged || '') === '1';
    const allRecords = sortRecordsByTimeline(db.prepare(sql).all(...params));
    if (!usePaged) {
      return res.json(allRecords);
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, Number(page_size) || 20));
    const offset = (pageNum - 1) * pageSizeNum;

    const total = allRecords.length;
    const records = allRecords.slice(offset, offset + pageSizeNum);
    return res.json({
      records,
      page: pageNum,
      page_size: pageSizeNum,
      total,
      has_more: offset + records.length < total,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/records', (req, res) => {
  try {
    const r = req.body;
    const stmt = db.prepare(`
      INSERT INTO records (baby_id, type, created_at, note, feeding_type, left_minutes, right_minutes, amount_ml, sleep_start, sleep_end, stool, medicine_name, medicine_amount, solid_items_json, reaction_types_json, reaction_note, suspected_food_ids_json, weight_kg, height_cm)
      VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      r.baby_id,
      r.type,
      r.created_at || null,
      r.note || null,
      r.feeding_type || null,
      r.left_minutes ?? null,
      r.right_minutes ?? null,
      r.amount_ml ?? null,
      r.sleep_start || null,
      r.sleep_end || null,
      r.stool ?? null,
      r.medicine_name || null,
      r.medicine_amount || null,
      r.solid_items_json || (Array.isArray(r.solid_items) ? JSON.stringify(r.solid_items) : null),
      r.reaction_types_json || (Array.isArray(r.reaction_types) ? JSON.stringify(r.reaction_types) : null),
      r.reaction_note || null,
      r.suspected_food_ids_json || (Array.isArray(r.suspected_food_ids) ? JSON.stringify(r.suspected_food_ids) : null),
      r.weight_kg ?? null,
      r.height_cm ?? null
    );
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(result.lastInsertRowid);
    const baby = db.prepare('SELECT id, name FROM babies WHERE id = ?').get(r.baby_id) || null;
    log(JSON.stringify({
      event: 'record_created',
      record_id: row.id,
      type: row.type,
      created_at: row.created_at,
      baby_id: row.baby_id,
      baby_name: baby?.name || null,
      ...getRecorderInfo(req),
    }));
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/records/:id', (req, res) => {
  try {
    const { id } = req.params;
    const r = req.body;
    const before = db.prepare('SELECT id, baby_id, type, created_at, sleep_start, sleep_end FROM records WHERE id = ?').get(id);
    const fields = [];
    const values = [];

    const patchable = [
      { key: 'created_at', col: 'created_at', normalize: (v) => v || null },
      { key: 'note', col: 'note', normalize: (v) => v === '' ? null : v },
      { key: 'feeding_type', col: 'feeding_type', normalize: (v) => v || null },
      { key: 'left_minutes', col: 'left_minutes', normalize: (v) => v === '' || v === null ? null : Number(v) },
      { key: 'right_minutes', col: 'right_minutes', normalize: (v) => v === '' || v === null ? null : Number(v) },
      { key: 'amount_ml', col: 'amount_ml', normalize: (v) => v === '' || v === null ? null : Number(v) },
      { key: 'sleep_start', col: 'sleep_start', normalize: (v) => v || null },
      { key: 'sleep_end', col: 'sleep_end', normalize: (v) => v || null },
      { key: 'stool', col: 'stool', normalize: (v) => (v === '' || v === null ? null : Number(v) ? 1 : 0) },
      { key: 'medicine_name', col: 'medicine_name', normalize: (v) => v === '' ? null : v },
      { key: 'medicine_amount', col: 'medicine_amount', normalize: (v) => v === '' ? null : v },
      { key: 'solid_items_json', col: 'solid_items_json', normalize: (v) => v || null },
      { key: 'reaction_types_json', col: 'reaction_types_json', normalize: (v) => v || null },
      { key: 'reaction_note', col: 'reaction_note', normalize: (v) => v === '' ? null : v },
      { key: 'suspected_food_ids_json', col: 'suspected_food_ids_json', normalize: (v) => v || null },
      { key: 'weight_kg', col: 'weight_kg', normalize: (v) => v === '' || v === null ? null : Number(v) },
      { key: 'height_cm', col: 'height_cm', normalize: (v) => v === '' || v === null ? null : Number(v) },
    ];

    patchable.forEach(({ key, col, normalize }) => {
      if (r[key] !== undefined) {
        fields.push(`${col} = ?`);
        values.push(normalize(r[key]));
      }
    });

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(id);
    db.prepare(`UPDATE records SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
    const baby = row?.baby_id ? db.prepare('SELECT id, name FROM babies WHERE id = ?').get(row.baby_id) : null;
    log(JSON.stringify({
      event: 'record_updated',
      record_id: row?.id || Number(id),
      type: row?.type || before?.type || null,
      baby_id: row?.baby_id || before?.baby_id || null,
      baby_name: baby?.name || null,
      changes: Object.fromEntries(
        Object.keys(r)
          .filter((k) => patchable.find((p) => p.key === k))
          .map((k) => [k, r[k]])
      ),
      ...getRecorderInfo(req),
    }));
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/records/:id', (req, res) => {
  try {
    const before = db.prepare('SELECT id, baby_id, type, created_at FROM records WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM records WHERE id = ?').run(req.params.id);
    const baby = before?.baby_id ? db.prepare('SELECT id, name FROM babies WHERE id = ?').get(before.baby_id) : null;
    log(JSON.stringify({
      event: 'record_deleted',
      record_id: before?.id || Number(req.params.id),
      type: before?.type || null,
      created_at: before?.created_at || null,
      baby_id: before?.baby_id || null,
      baby_name: baby?.name || null,
      ...getRecorderInfo(req),
    }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 辅食记录与食物状态 API
app.get('/api/solid-meals', (req, res) => {
  try {
    const babyId = Number(req.query.baby_id);
    if (!Number.isFinite(babyId) || babyId <= 0) return res.status(400).json({ error: 'baby_id required' });
    res.json(getSolidMeals(babyId, req.query.date_from, req.query.date_to));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/solid-meals', (req, res) => {
  try {
    const babyId = Number(req.body?.baby_id);
    if (!Number.isFinite(babyId) || babyId <= 0) return res.status(400).json({ error: 'baby_id required' });
    const baby = db.prepare('SELECT id FROM babies WHERE id = ?').get(babyId);
    if (!baby) return res.status(404).json({ error: 'Baby not found' });
    const payload = normalizeSolidMealPayload(babyId, req.body);
    const result = db.prepare(`
      INSERT INTO records (
        baby_id, type, created_at, note, solid_items_json, reaction_types_json,
        reaction_note, suspected_food_ids_json
      ) VALUES (?, 'solid_meal', COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?)
    `).run(
      babyId,
      payload.createdAt,
      payload.note,
      JSON.stringify(payload.items),
      JSON.stringify(payload.reactionTypes),
      payload.reactionNote,
      JSON.stringify(payload.suspectedFoodIds)
    );
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(result.lastInsertRowid);
    log(JSON.stringify({
      event: 'solid_meal_created',
      record_id: row.id,
      baby_id: babyId,
      created_at: row.created_at,
      ...getRecorderInfo(req),
    }));
    res.json(formatSolidMeal(row));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/solid-meals/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare(`SELECT * FROM records WHERE id = ? AND type = 'solid_meal'`).get(id);
    if (!existing) return res.status(404).json({ error: 'Solid meal not found' });
    const payload = normalizeSolidMealPayload(existing.baby_id, {
      ...req.body,
      items: req.body?.items ?? parseJsonArray(existing.solid_items_json),
      reaction_types: req.body?.reaction_types ?? parseJsonArray(existing.reaction_types_json),
      suspected_food_ids: req.body?.suspected_food_ids ?? parseJsonArray(existing.suspected_food_ids_json),
      note: req.body?.note ?? existing.note,
      reaction_note: req.body?.reaction_note ?? existing.reaction_note,
    });
    db.prepare(`
      UPDATE records SET
        created_at = COALESCE(?, created_at),
        note = ?,
        solid_items_json = ?,
        reaction_types_json = ?,
        reaction_note = ?,
        suspected_food_ids_json = ?
      WHERE id = ?
    `).run(
      payload.createdAt,
      payload.note,
      JSON.stringify(payload.items),
      JSON.stringify(payload.reactionTypes),
      payload.reactionNote,
      JSON.stringify(payload.suspectedFoodIds),
      id
    );
    res.json(formatSolidMeal(db.prepare('SELECT * FROM records WHERE id = ?').get(id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/solid-meals/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = db.prepare(`DELETE FROM records WHERE id = ? AND type = 'solid_meal'`).run(id);
    res.json({ ok: result.changes > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/solid-foods', (req, res) => {
  try {
    const babyId = Number(req.query.baby_id);
    if (!Number.isFinite(babyId) || babyId <= 0) return res.status(400).json({ error: 'baby_id required' });
    res.json(deriveSolidFoodSummary(babyId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/solid-foods/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = req.body?.manual_status == null || req.body?.manual_status === ''
      ? null
      : String(req.body.manual_status);
    if (status !== null && !['confirmed_allergy', 'confirmed_safe'].includes(status)) {
      return res.status(400).json({ error: 'invalid manual_status' });
    }
    const result = db.prepare(`
      UPDATE solid_foods
      SET manual_status = ?, manual_status_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, String(req.body?.manual_status_note || '').trim() || null, id);
    if (!result.changes) return res.status(404).json({ error: 'Solid food not found' });
    const food = db.prepare('SELECT baby_id FROM solid_foods WHERE id = ?').get(id);
    res.json(deriveSolidFoodSummary(food.baby_id).find((item) => Number(item.id) === id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/solid-summary', (req, res) => {
  try {
    const babyId = Number(req.query.baby_id);
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : getBeijingDate().slice(0, 7);
    if (!Number.isFinite(babyId) || babyId <= 0) return res.status(400).json({ error: 'baby_id required' });
    const [summaryYear, summaryMonth] = month.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(summaryYear, summaryMonth, 0)).getUTCDate();
    const meals = getSolidMeals(babyId, `${month}-01`, `${month}-${String(monthEnd).padStart(2, '0')}`);
    const byDate = new Map();
    for (const meal of meals) {
      const date = solidDateKey(meal.created_at);
      if (!date) continue;
      const day = byDate.get(date) || { date, meal_count: 0, food_count: 0, total_grams: 0, abnormal_meal_count: 0 };
      day.meal_count += 1;
      day.food_count += meal.solid_items.length;
      day.total_grams += meal.solid_items.reduce((sum, item) => sum + Number(item.grams || 0), 0);
      if (meal.reaction_types.length) day.abnormal_meal_count += 1;
      byDate.set(date, day);
    }
    res.json({
      month,
      days: [...byDate.values()].map((day) => ({ ...day, total_grams: Math.round(day.total_grams * 10) / 10 })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 喂奶统计
app.get('/api/stats/feeding', (req, res) => {
  try {
    const { baby_id, days = 7 } = req.query;
    const startDate = getBeijingDateDaysAgo(Number(days));
    const sql = `
      SELECT 
        date(created_at, '+8 hours') as date,
        COUNT(*) as count,
        COALESCE(SUM(COALESCE(amount_ml, 0)), 0) as total_ml,
        COALESCE(SUM(COALESCE(left_minutes, 0) + COALESCE(right_minutes, 0)), 0) as total_minutes
      FROM records
      WHERE type = 'feeding' AND baby_id = ?
        AND date(created_at, '+8 hours') >= date(?)
      GROUP BY date(created_at, '+8 hours')
      ORDER BY date DESC
    `;
    const rows = db.prepare(sql).all(baby_id, startDate);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 睡眠统计
app.get('/api/stats/sleep', (req, res) => {
  try {
    const { baby_id, days = 7 } = req.query;
    const startDate = getBeijingDateDaysAgo(Number(days));
    const records = db.prepare(`
      SELECT id, sleep_start, sleep_end, created_at
      FROM records
      WHERE type = 'sleep' AND baby_id = ? AND sleep_start IS NOT NULL AND sleep_end IS NOT NULL
        AND date(sleep_end, '+8 hours') >= date(?)
      ORDER BY sleep_start DESC
    `).all(baby_id, startDate);

    const dailyMap = {};
    const periods = [];
    for (const record of records) {
      const segments = splitSleepRecordByLocalDay(record)
        .filter((segment) => segment.date >= startDate);
      for (const segment of segments) {
        periods.push(segment);
        if (!dailyMap[segment.date]) dailyMap[segment.date] = { total_minutes: 0, sessions: 0 };
        dailyMap[segment.date].total_minutes += segment.duration_minutes;
        dailyMap[segment.date].sessions += 1;
      }
    }

    periods.sort((a, b) => {
      const byDate = b.date.localeCompare(a.date);
      if (byDate !== 0) return byDate;
      return String(a.start).localeCompare(String(b.start));
    });

    const daily = Object.entries(dailyMap)
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => b.date.localeCompare(a.date));

    res.json({ daily, periods });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 排便统计
app.get('/api/stats/diaper', (req, res) => {
  try {
    const { baby_id, days = 7 } = req.query;
    const startDate = getBeijingDateDaysAgo(Number(days));
    const sql = `
      SELECT
        date(created_at, '+8 hours') as date,
        COUNT(*) as diaper_count,
        SUM(CASE WHEN stool = 1 THEN 1 ELSE 0 END) as stool_count
      FROM records
      WHERE type = 'diaper' AND baby_id = ?
        AND date(created_at, '+8 hours') >= date(?)
      GROUP BY date(created_at, '+8 hours')
      ORDER BY date DESC
    `;
    const rows = db.prepare(sql).all(baby_id, startDate);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 体重统计
app.get('/api/stats/weight', (req, res) => {
  try {
    const { baby_id, days = 30 } = req.query;
    const startDate = getBeijingDateDaysAgo(Number(days));
    const daily = db.prepare(`
      SELECT
        date(created_at, '+8 hours') as date,
        ROUND(AVG(weight_kg), 2) as avg_weight_kg,
        ROUND(MAX(weight_kg), 2) as max_weight_kg,
        ROUND(MIN(weight_kg), 2) as min_weight_kg,
        COUNT(*) as count
      FROM records
      WHERE type = 'weight'
        AND baby_id = ?
        AND weight_kg IS NOT NULL
        AND date(created_at, '+8 hours') >= date(?)
      GROUP BY date(created_at, '+8 hours')
      ORDER BY date DESC
    `).all(baby_id, startDate);

    const latest = db.prepare(`
      SELECT created_at, weight_kg
      FROM records
      WHERE type = 'weight' AND baby_id = ? AND weight_kg IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(baby_id) || null;

    res.json({ daily, latest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 生长统计（体重 + 身高）
app.get('/api/stats/growth', (req, res) => {
  try {
    const { baby_id, days = 30 } = req.query;
    const isAllTime = String(days).toLowerCase() === 'all';
    const startDate = isAllTime ? null : getBeijingDateDaysAgo(Number(days));
    const daily = db.prepare(`
      SELECT
        date(created_at, '+8 hours') as date,
        ROUND(AVG(weight_kg), 2) as avg_weight_kg,
        ROUND(AVG(height_cm), 2) as avg_height_cm,
        SUM(CASE WHEN weight_kg IS NOT NULL THEN 1 ELSE 0 END) as weight_count,
        SUM(CASE WHEN height_cm IS NOT NULL THEN 1 ELSE 0 END) as height_count
      FROM records
      WHERE baby_id = ?
        AND type IN ('weight', 'height')
        AND (? IS NULL OR date(created_at, '+8 hours') >= date(?))
      GROUP BY date(created_at, '+8 hours')
      ORDER BY date DESC
    `).all(baby_id, startDate, startDate);

    const latestWeight = db.prepare(`
      SELECT created_at, weight_kg
      FROM records
      WHERE type = 'weight' AND baby_id = ? AND weight_kg IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(baby_id) || null;

    const latestHeight = db.prepare(`
      SELECT created_at, height_cm
      FROM records
      WHERE type = 'height' AND baby_id = ? AND height_cm IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(baby_id) || null;

    res.json({ daily, latestWeight, latestHeight });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 概览 + 下次提醒
app.get('/api/overview', (req, res) => {
  try {
    const { baby_id } = req.query;
    const records = db.prepare(`
      SELECT * FROM records
      WHERE baby_id = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(baby_id);

    const baby = db.prepare('SELECT * FROM babies WHERE id = ?').get(baby_id);
    if (!baby) return res.status(404).json({ error: 'Baby not found' });

    const birth = new Date(baby.birthdate);
    const now = new Date();
    const ageDays = Math.floor((now - birth) / (1000 * 60 * 60 * 24));

    const rules = db.prepare(`
      SELECT * FROM reminder_rules
      ORDER BY id ASC LIMIT 1
    `).get() || null;

    const lastFeeding = db.prepare(`
      SELECT * FROM records 
      WHERE baby_id = ? AND type = 'feeding'
      ORDER BY created_at DESC LIMIT 1
    `).get(baby_id);

    const lastFeedingAt = lastFeeding ? parseDbDateTime(lastFeeding.created_at) : null;
    const feedingReminder = computeFeedingReminder({ rules, lastFeedingAt, now });

    const supplementReminder = getSupplementReminder(baby_id, now);

    const recent24hStats = computeRecent24hFeedingStats(baby_id, now);

    // const rules = db.prepare(`
    //   SELECT * FROM reminder_rules 
    //   WHERE min_days <= ? AND max_days >= ?
    //   ORDER BY min_days DESC LIMIT 1
    // `).get(ageDays, ageDays);

    // let nextFeeding = null, nextDiaper = null;

    // const lastFeeding = db.prepare(`
    //   SELECT * FROM records 
    //   WHERE baby_id = ? AND type = 'feeding'
    //   ORDER BY created_at DESC LIMIT 1
    // `).get(baby_id);
    // 
    // const lastDiaper = db.prepare(`
    //   SELECT * FROM records 
    //   WHERE baby_id = ? AND type = 'diaper'
    //   ORDER BY created_at DESC LIMIT 1
    // `).get(baby_id);

    // if (rules) {
    //   const fHours = rules.feeding_interval_hours;
    //   const dHours = rules.diaper_interval_hours;
    //   const fMinutes = rules.feeding_interval_minutes || 0;
    //   const dMinutes = rules.diaper_interval_minutes || 0;
    //   const now = new Date();
    //   
    //   if (lastFeeding) {
    //     const lastFeedingTime = new Date(lastFeeding.created_at);
    //     let feedingTime = lastFeedingTime.getTime() + fHours * 3600000 + fMinutes * 60000;
    //     if (feedingTime < now.getTime()) {
    //       feedingTime = now.getTime() + fHours * 3600000 + fMinutes * 60000;
    //     }
    //     nextFeeding = new Date(feedingTime).toISOString();
    //   } else {
    //     const feedingTime = now.getTime() + fHours * 3600000 + fMinutes * 60000;
    //     nextFeeding = new Date(feedingTime).toISOString();
    //   }
    //   
    //   if (lastDiaper) {
    //     const lastDiaperTime = new Date(lastDiaper.created_at);
    //     let diaperTime = lastDiaperTime.getTime() + dHours * 3600000 + dMinutes * 60000;
    //     if (diaperTime < now.getTime()) {
    //       diaperTime = now.getTime() + dHours * 3600000 + dMinutes * 60000;
    //     }
    //     nextDiaper = new Date(diaperTime).toISOString();
    //   } else {
    //     const diaperTime = now.getTime() + dHours * 3600000 + dMinutes * 60000;
    //     nextDiaper = new Date(diaperTime).toISOString();
    //   }
    // }

    res.json({
      records,
      ageDays,
      birthdate: baby.birthdate,
      recent24h_feeding_count: recent24hStats.count,
      recent24h_feeding_total_ml: recent24hStats.totalMl,
      reminder: {
        rule: rules ? {
          id: rules.id,
          min_days: rules.min_days,
          max_days: rules.max_days,
          feeding_interval_hours: rules.feeding_interval_hours,
          feeding_interval_minutes: rules.feeding_interval_minutes || 0,
          awake_interval_hours: rules.awake_interval_hours ?? 2,
          awake_interval_minutes: rules.awake_interval_minutes ?? 15,
          show_sleep_time_range: Number(rules.show_sleep_time_range ?? 1),
        } : null,
        lastFeedingAt: lastFeedingAt ? lastFeedingAt.toISOString() : null,
        ...feedingReminder,
        supplements: supplementReminder,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 提醒规则
app.get('/api/reminder-rules', (req, res) => {
  try {
    const rules = db.prepare('SELECT * FROM reminder_rules ORDER BY id ASC LIMIT 1').all();
    res.json(rules);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/reminder-rules/:id', (req, res) => {
  try {
    const { id } = req.params;
    const {
      feeding_interval_hours,
      feeding_interval_minutes,
      diaper_interval_hours,
      diaper_interval_minutes,
      awake_interval_hours,
      awake_interval_minutes,
      show_sleep_time_range,
    } = req.body;

    db.prepare(`
      UPDATE reminder_rules
      SET feeding_interval_hours = COALESCE(?, feeding_interval_hours),
          feeding_interval_minutes = COALESCE(?, feeding_interval_minutes),
          diaper_interval_hours = COALESCE(?, diaper_interval_hours),
          diaper_interval_minutes = COALESCE(?, diaper_interval_minutes),
          awake_interval_hours = COALESCE(?, awake_interval_hours),
          awake_interval_minutes = COALESCE(?, awake_interval_minutes),
          show_sleep_time_range = COALESCE(?, show_sleep_time_range)
      WHERE id = ?
    `).run(
      feeding_interval_hours === undefined ? null : Number(feeding_interval_hours),
      feeding_interval_minutes === undefined ? null : Number(feeding_interval_minutes),
      diaper_interval_hours === undefined ? null : Number(diaper_interval_hours),
      diaper_interval_minutes === undefined ? null : Number(diaper_interval_minutes),
      awake_interval_hours === undefined ? null : Number(awake_interval_hours),
      awake_interval_minutes === undefined ? null : Number(awake_interval_minutes),
      show_sleep_time_range === undefined ? null : (show_sleep_time_range ? 1 : 0),
      id
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 日程自定义配置（跨设备同步）
app.get('/api/schedule-custom', (req, res) => {
  try {
    const babyId = Number(req.query.baby_id);
    if (!Number.isFinite(babyId) || babyId <= 0) {
      return res.status(400).json({ error: 'baby_id required' });
    }

    const row = db.prepare('SELECT payload, updated_at FROM schedule_custom WHERE baby_id = ?').get(babyId);
    if (!row) return res.json({ payload: null, updated_at: null });

    let payload = null;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = null;
    }
    res.json({ payload, updated_at: row.updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/schedule-custom', (req, res) => {
  try {
    const babyId = Number(req.body?.baby_id);
    if (!Number.isFinite(babyId) || babyId <= 0) {
      return res.status(400).json({ error: 'baby_id required' });
    }

    const payload = req.body?.payload && typeof req.body.payload === 'object'
      ? req.body.payload
      : {};
    const safePayload = {
      slots: payload.slots && typeof payload.slots === 'object' ? payload.slots : {},
      tips: Array.isArray(payload.tips) ? payload.tips : null,
      safetyNotes: Array.isArray(payload.safetyNotes) ? payload.safetyNotes : null,
    };
    const payloadText = JSON.stringify(safePayload);

    db.prepare(`
      INSERT INTO schedule_custom (baby_id, payload, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(baby_id) DO UPDATE SET
        payload = excluded.payload,
        updated_at = CURRENT_TIMESTAMP
    `).run(babyId, payloadText);

    res.json({ ok: true, payload: safePayload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 数据导出
app.get('/api/export', (req, res) => {
  try {
    const { baby_id } = req.query;
    const babies = db.prepare('SELECT * FROM babies').all();
    const records = baby_id
      ? db.prepare('SELECT * FROM records WHERE baby_id = ? ORDER BY created_at').all(baby_id)
      : db.prepare('SELECT * FROM records ORDER BY created_at').all();
    res.json({ babies, records, exported_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 日程统计 API：喂奶历史时间分布 + AD + 最近排便
app.get('/api/schedule-stats', (req, res) => {
  try {
    const { baby_id } = req.query;
    const id = Number(baby_id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'baby_id required' });
    }
    const now = new Date();

    // 今日（北京时间）喂奶记录
    const todayStr = getBeijingDate();
    const todayFeedings = db.prepare(`
      SELECT created_at, amount_ml
      FROM records
      WHERE baby_id = ? AND type = 'feeding'
        AND date(created_at, '+8 hours') = date(?)
      ORDER BY created_at ASC
    `).all(id, todayStr);

    const todayTimes = todayFeedings.map(r => {
      const d = parseRecordDateFlexible(r.created_at, now);
      if (!d) return null;
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      return { time: `${h}:${m}`, amount_ml: r.amount_ml };
    }).filter(Boolean);

    const todayTotalMl = todayFeedings.reduce((s, r) => s + Number(r.amount_ml || 0), 0);

    // 最近 7 天喂奶记录，按小时聚合（用于推算常规喂奶时间）
    const recentFeedings = db.prepare(`
      SELECT created_at, amount_ml
      FROM records
      WHERE baby_id = ? AND type = 'feeding'
        AND created_at >= datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT 500
    `).all(id);

    const hourDist = {};
    for (const r of recentFeedings) {
      const d = parseRecordDateFlexible(r.created_at, now);
      if (!d) continue;
      const h = d.getHours();
      hourDist[h] = (hourDist[h] || 0) + 1;
    }

    const supplementReminder = getSupplementReminder(id, now);

    // 最近一次有大便的换尿布（JS排序，避免混合时区字符串在SQL中排序错误）
    const recentPoopCandidates = db.prepare(`
      SELECT created_at
      FROM records
      WHERE baby_id = ? AND type = 'diaper' AND stool = 1
      ORDER BY id DESC
      LIMIT 200
    `).all(id);
    const poopTimes = recentPoopCandidates
      .map(r => parseRecordDateFlexible(r.created_at, now))
      .filter(d => d && !Number.isNaN(d.getTime()))
      .sort((a, b) => b.getTime() - a.getTime());
    const lastPoopAt = poopTimes[0] ?? null;
    let lastPoopHoursAgo = null;
    if (lastPoopAt) {
      lastPoopHoursAgo = Math.round((now.getTime() - lastPoopAt.getTime()) / 3600000 * 10) / 10;
    }

    // 最近 7 天每天大便次数
    const recentPoopRows = db.prepare(`
      SELECT date(created_at, '+8 hours') as date, COUNT(*) as count
      FROM records
      WHERE baby_id = ? AND type = 'diaper' AND stool = 1
        AND date(created_at, '+8 hours') >= date(?, '-7 days')
      GROUP BY date(created_at, '+8 hours')
      ORDER BY date DESC
    `).all(id, todayStr);
    const avgDailyPoops = recentPoopRows.length
      ? Math.round((recentPoopRows.reduce((s, r) => s + r.count, 0) / recentPoopRows.length) * 10) / 10
      : null;

    res.json({
      feeding: {
        today_count: todayFeedings.length,
        today_total_ml: Math.round(todayTotalMl),
        today_times: todayTimes,
        hour_distribution: hourDist,
      },
      supplements: supplementReminder,
      poop: {
        last_at: lastPoopAt ? lastPoopAt.toISOString() : null,
        hours_ago: lastPoopHoursAgo,
        avg_daily: avgDailyPoops,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 静态文件（生产环境）
const clientDist = join(__dirname, '../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(join(clientDist, 'index.html'));
    }
  });
}

// 简单的日志函数
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  try {
    appendFileSync('server.log', `${logMessage}\n`);
    console.log(logMessage);
  } catch (err) {
    console.error('Failed to write to log file:', err.message);
  }
}

// 错误处理中间件
app.use((err, req, res, next) => {
  log(`ERROR: ${err.message}`);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  log(`Server started on port ${PORT}`);
  console.log('\n育儿导航已启动');
  console.log(`本地: http://localhost:${PORT}`);
  console.log(`局域网: http://${getLocalIP()}:${PORT}\n`);
});

function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
