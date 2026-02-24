process.env.TZ = 'Asia/Shanghai';
import express from 'express';
import { getBeijingDate, getBeijingDateDaysAgo } from './date-utils.js';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb, db } from './db.js';
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

function computeFeedingReminder({ rules, lastFeedingAt, now }) {
  if (!rules) {
    return {
      intervalMinutes: null,
      nextFeedingAt: null,
      remainingMinutes: null,
      overdueMinutes: 0,
      isFeedingDue: false,
    };
  }

  const feedingHours = Number(rules.feeding_interval_hours || 0);
  const feedingMinutes = Number(rules.feeding_interval_minutes || 0);
  const intervalMinutes = Math.max(0, Math.round(feedingHours * 60 + feedingMinutes));
  if (intervalMinutes <= 0) {
    return {
      intervalMinutes: 0,
      nextFeedingAt: null,
      remainingMinutes: null,
      overdueMinutes: 0,
      isFeedingDue: false,
    };
  }

  const baseTime = lastFeedingAt || now;
  const nextFeedingAt = new Date(baseTime.getTime() + intervalMinutes * 60000);
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
    const orderSql = `${sql} ORDER BY created_at DESC, id DESC`;
    const usePaged = String(paged || '') === '1';
    if (!usePaged) {
      const records = db.prepare(orderSql).all(...params);
      return res.json(records);
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, Number(page_size) || 20));
    const offset = (pageNum - 1) * pageSizeNum;

    const totalRow = db.prepare(`SELECT COUNT(1) AS c FROM (${sql})`).get(...params);
    const total = Number(totalRow?.c || 0);
    const records = db.prepare(`${orderSql} LIMIT ? OFFSET ?`).all(...params, pageSizeNum, offset);
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
      INSERT INTO records (baby_id, type, created_at, note, feeding_type, left_minutes, right_minutes, amount_ml, sleep_start, sleep_end, medicine_name, medicine_amount, weight_kg, height_cm)
      VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      r.medicine_name || null,
      r.medicine_amount || null,
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
      { key: 'medicine_name', col: 'medicine_name', normalize: (v) => v === '' ? null : v },
      { key: 'medicine_amount', col: 'medicine_amount', normalize: (v) => v === '' ? null : v },
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
        AND date(sleep_start, '+8 hours') >= date(?)
      ORDER BY sleep_start DESC
    `).all(baby_id, startDate);

    const dailyMap = {};
    const periods = records.map(r => {
      const start = new Date(r.sleep_start);
      const end = new Date(r.sleep_end);
      const duration = Math.round((end - start) / 60000);
      const date = r.sleep_start.slice(0, 10);
      if (!dailyMap[date]) dailyMap[date] = { total_minutes: 0, sessions: 0 };
      dailyMap[date].total_minutes += duration;
      dailyMap[date].sessions += 1;
      return {
        date,
        start: r.sleep_start,
        end: r.sleep_end,
        duration_minutes: duration,
      };
    });

    const daily = Object.entries(dailyMap)
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => b.date.localeCompare(a.date));

    res.json({ daily, periods });
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
    const startDate = getBeijingDateDaysAgo(Number(days));
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
        AND date(created_at, '+8 hours') >= date(?)
      GROUP BY date(created_at, '+8 hours')
      ORDER BY date DESC
    `).all(baby_id, startDate);

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
      recent24h_feeding_count: recent24hStats.count,
      recent24h_feeding_total_ml: recent24hStats.totalMl,
      reminder: {
        rule: rules ? {
          id: rules.id,
          min_days: rules.min_days,
          max_days: rules.max_days,
          feeding_interval_hours: rules.feeding_interval_hours,
          feeding_interval_minutes: rules.feeding_interval_minutes || 0,
        } : null,
        lastFeedingAt: lastFeedingAt ? lastFeedingAt.toISOString() : null,
        ...feedingReminder,
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
    } = req.body;

    db.prepare(`
      UPDATE reminder_rules
      SET feeding_interval_hours = ?,
          feeding_interval_minutes = ?,
          diaper_interval_hours = COALESCE(?, diaper_interval_hours),
          diaper_interval_minutes = COALESCE(?, diaper_interval_minutes)
      WHERE id = ?
    `).run(
      Number(feeding_interval_hours || 0),
      Number(feeding_interval_minutes || 0),
      diaper_interval_hours === undefined ? null : Number(diaper_interval_hours),
      diaper_interval_minutes === undefined ? null : Number(diaper_interval_minutes),
      id
    );

    res.json({ ok: true });
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
