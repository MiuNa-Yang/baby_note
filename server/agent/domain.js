const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export class AgentInputError extends Error {
  constructor(message, code = 'invalid_input', details = null) {
    super(message);
    this.name = 'AgentInputError';
    this.code = code;
    this.details = details;
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function shanghaiParts(date) {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function shanghaiIso(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - SHANGHAI_OFFSET_MS).toISOString();
}

export function shanghaiDateKey(date = new Date()) {
  const parts = shanghaiParts(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function addShanghaiDays(date, delta) {
  const parts = shanghaiParts(date);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + delta, parts.hour, parts.minute, parts.second) - SHANGHAI_OFFSET_MS);
}

function dayBounds(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new AgentInputError('日期格式应为 YYYY-MM-DD', 'invalid_date');
  const start = new Date(shanghaiIso(Number(match[1]), Number(match[2]), Number(match[3])));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function normalizeSummaryRange(input = {}, now = new Date()) {
  let startDate = String(input.start_date || input.from || input.date || '').trim();
  let endDate = String(input.end_date || input.to || input.date || '').trim();
  if (!startDate && !endDate) {
    startDate = shanghaiDateKey(now);
    endDate = startDate;
  } else if (!startDate) {
    startDate = endDate;
  } else if (!endDate) {
    endDate = startDate;
  }

  const start = dayBounds(startDate).start;
  const end = dayBounds(endDate).end;
  if (end <= start) throw new AgentInputError('结束日期必须不早于开始日期', 'invalid_date_range');
  const days = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  if (days > 31) throw new AgentInputError('一次最多查询 31 天', 'date_range_too_large');
  return { startDate, endDate, start, end, days };
}

export function parseStoredDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const sqlDate = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (sqlDate) {
    const parsed = new Date(Date.UTC(
      Number(sqlDate[1]), Number(sqlDate[2]) - 1, Number(sqlDate[3]),
      Number(sqlDate[4]), Number(sqlDate[5]), Number(sqlDate[6] || 0),
    ));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseChineseInteger(value) {
  const text = String(value || '').trim();
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let total = 0;
  let section = 0;
  for (const char of text) {
    if (digits[char] != null) section += digits[char];
    else if (units[char]) {
      total += (section || 1) * units[char];
      section = 0;
    } else return null;
  }
  const result = total + section;
  return result > 0 ? result : null;
}

export function parseAgentTime(value, now = new Date()) {
  const text = String(value || '').trim();
  if (!text || /^(现在|刚|刚刚|刚才)$/u.test(text)) return now.toISOString();

  const relative = text.match(/^(?<amount>\d{1,4}|[零〇一二两三四五六七八九十百千万]+|半)\s*(?<unit>分钟?|分|小时?|时|天|日|周)前$/u);
  if (relative) {
    const amountText = relative.groups.amount;
    const amount = amountText === '半'
      ? 0.5
      : /^\d+$/.test(amountText) ? Number(amountText) : parseChineseInteger(amountText);
    const multiplier = /^(?:小时?|时)$/u.test(relative.groups.unit)
      ? 60
      : /^(?:天|日)$/u.test(relative.groups.unit)
        ? 24 * 60
        : /^(?:周)$/u.test(relative.groups.unit) ? 7 * 24 * 60 : 1;
    if (amount && Number.isFinite(amount)) {
      return new Date(now.getTime() - amount * multiplier * 60 * 1000).toISOString();
    }
  }

  const explicit = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (explicit) {
    const result = new Date(shanghaiIso(
      Number(explicit[1]), Number(explicit[2]), Number(explicit[3]),
      Number(explicit[4]), Number(explicit[5]), Number(explicit[6] || 0),
    ));
    if (Number.isNaN(result.getTime())) throw new AgentInputError('无法识别这个时间', 'invalid_time');
    if (result.getTime() > now.getTime() + 5 * 60 * 1000) {
      throw new AgentInputError('这个时间还没到，请确认日期或上午/下午', 'future_time');
    }
    return result.toISOString();
  }

  let dayOffset = 0;
  if (/昨天|昨日/u.test(text)) dayOffset = -1;
  const period = text.match(/凌晨|早上|上午|中午|下午|晚上|夜里/u)?.[0] || '';
  const time = text.match(/(\d{1,2})(?:\s*[点时:：]\s*(\d{1,2})?)?\s*(半|一刻|三刻)?/u);
  if (!time) throw new AgentInputError('无法识别这个时间，请换成“刚刚”“20分钟前”或“下午2点半”', 'ambiguous_time');

  let hour = Number(time[1]);
  let minute = time[2] ? Number(time[2]) : 0;
  if (time[3] === '半') minute = 30;
  if (time[3] === '一刻') minute = 15;
  if (time[3] === '三刻') minute = 45;
  if (period === '下午' || period === '晚上' || period === '夜里') {
    if (hour < 12) hour += 12;
  } else if (period === '中午' && hour < 11) {
    hour += 12;
  } else if (period === '凌晨' && hour === 12) {
    hour = 0;
  }
  if (hour > 23 || minute > 59) throw new AgentInputError('时间超出有效范围', 'invalid_time');

  const targetDay = shanghaiParts(addShanghaiDays(now, dayOffset));
  const result = new Date(shanghaiIso(targetDay.year, targetDay.month, targetDay.day, hour, minute));
  if (!period && dayOffset === 0 && result.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new AgentInputError('这个时间还没到，请说明是昨天、上午还是下午', 'ambiguous_time');
  }
  if (result.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new AgentInputError('这个时间还没到，请确认日期', 'future_time');
  }
  return result.toISOString();
}

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

function normalizeContext(context = {}) {
  return {
    source_channel: String(context.source_channel || 'manual').trim() || 'manual',
    source_message_id: String(context.source_message_id || '').trim() || null,
    source_chat_id: String(context.source_chat_id || '').trim() || null,
    operator_id: String(context.operator_id || '').trim() || null,
    source_text: String(context.source_text || '').trim().slice(0, 2000) || null,
  };
}

function normalizeItems(items, { requireAmount = true } = {}) {
  if (!Array.isArray(items) || !items.length) {
    throw new AgentInputError('至少需要一种辅食', 'missing_food');
  }
  return items.map((raw) => {
    const name = String(raw?.name || '').trim();
    const amount = Number(raw?.amount ?? raw?.grams);
    // Agent/MCP calls omit unit on purpose: new voice records use grams by
    // default. Keep an explicitly supplied unit for the web/API path so old
    // flexible-unit records and meal plans remain compatible.
    const unit = String(raw?.unit || (raw?.grams != null ? 'g' : '')).trim() || '克';
    if (!name) throw new AgentInputError('辅食名称不能为空', 'missing_food_name');
    if (requireAmount && (!Number.isFinite(amount) || amount <= 0)) {
      throw new AgentInputError(`请补充“${name}”的食用量`, 'missing_food_amount', { food: name });
    }
    const item = {
      food_id: raw?.food_id ? Number(raw.food_id) : undefined,
      name,
      amount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null,
      unit,
    };
    if (unit.toLowerCase() === 'g' || unit === '克') item.grams = item.amount;
    item.quantity_text = item.amount == null ? null : `${item.amount}${unit}`;
    return item;
  });
}

function formatShanghaiDateTime(date) {
  const parts = shanghaiParts(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

function elapsedText(minutes) {
  const value = Math.max(0, Number(minutes) || 0);
  if (value < 1) return '刚刚';
  if (value < 60) return `${value}分钟`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours}小时${rest}分钟` : `${hours}小时`;
}

function minutesSince(date, now) {
  return Math.max(0, Math.round((now.getTime() - date.getTime()) / 60000));
}

function latestByDate(rows, field) {
  return rows
    .map((row) => ({ row, date: parseStoredDate(row[field]) }))
    .filter(({ date }) => date && !Number.isNaN(date.getTime()))
    .sort((left, right) => right.date.getTime() - left.date.getTime()
      || Number(right.row.id || 0) - Number(left.row.id || 0))[0] || null;
}

function formatPlanItem(item) {
  const amount = item?.amount ?? item?.grams;
  const unit = item?.unit || (item?.grams != null ? 'g' : '');
  return amount != null ? `${item.name} ${amount}${unit}` : item.name;
}

export function createAgentService(database, options = {}) {
  const getNow = typeof options.now === 'function' ? options.now : () => new Date();

  function assertBaby(babyId) {
    const id = Number(babyId);
    if (!Number.isInteger(id) || id <= 0) throw new AgentInputError('宝宝 ID 无效', 'invalid_baby');
    if (!database.prepare('SELECT id FROM babies WHERE id = ?').get(id)) {
      throw new AgentInputError('没有找到宝宝档案', 'baby_not_found');
    }
    return id;
  }

  function appendAudit(recordId, action, context) {
    database.prepare(`
      INSERT INTO record_audit_events (
        record_id, action, source_channel, source_message_id,
        source_chat_id, operator_id, source_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordId, action, context.source_channel, context.source_message_id,
      context.source_chat_id, context.operator_id, context.source_text,
    );
  }

  function runMutation(operation, rawContext, callback) {
    const context = normalizeContext(rawContext);
    const execute = database.transaction(() => {
      if (context.source_message_id) {
        const existing = database.prepare(`
          SELECT * FROM agent_messages
          WHERE source_channel = ? AND source_message_id = ?
        `).get(context.source_channel, context.source_message_id);
        if (existing) {
          if (existing.operation !== operation) {
            throw new AgentInputError('一条消息只能记录一个动作，请拆成两条发送', 'multiple_mutations');
          }
          if (existing.status === 'completed' && existing.result_json) {
            return { ...JSON.parse(existing.result_json), idempotent_replay: true };
          }
        } else {
          database.prepare(`
            INSERT INTO agent_messages (
              source_channel, source_message_id, source_chat_id,
              operator_id, source_text, operation, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'processing')
          `).run(
            context.source_channel, context.source_message_id, context.source_chat_id,
            context.operator_id, context.source_text, operation,
          );
        }
      }

      const result = callback(context);
      for (const audit of result.audit_events || []) {
        appendAudit(audit.record_id, audit.action, context);
      }
      const publicResult = { ...result };
      delete publicResult.audit_events;
      if (context.source_message_id) {
        database.prepare(`
          UPDATE agent_messages
          SET status = 'completed', record_id = ?, result_json = ?, completed_at = CURRENT_TIMESTAMP
          WHERE source_channel = ? AND source_message_id = ?
        `).run(
          publicResult.record_id || null, JSON.stringify(publicResult),
          context.source_channel, context.source_message_id,
        );
      }
      return publicResult;
    });
    return execute();
  }

  function recordGrowth(input, context = {}) {
    const babyId = assertBaby(input?.baby_id);
    const measurements = [['weight_kg', 'weight', 100], ['height_cm', 'height', 250]]
      .filter(([key]) => input?.[key] != null);
    if (!measurements.length) throw new AgentInputError('请提供体重（公斤）或身长（厘米）');
    for (const [key, , max] of measurements) {
      if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] <= 0 || input[key] > max) {
        throw new AgentInputError('体重或身长数值无效，请确认单位');
      }
    }
    return runMutation('record_growth', context, (ctx) => {
      const occurredAt = parseAgentTime(input.time_text, getNow());
      const ids = measurements.map(([key, type]) => Number(database.prepare(`
        INSERT INTO records (baby_id, type, created_at, ${key}, note,
          source_channel, source_message_id, source_chat_id, operator_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(babyId, type, occurredAt, input[key], String(input.note || '').trim() || null,
        ctx.source_channel, ctx.source_message_id, ctx.source_chat_id, ctx.operator_id, occurredAt).lastInsertRowid));
      return { ok: true, record_id: ids[0], record_ids: ids,
        ...Object.fromEntries(measurements.map(([key]) => [key, input[key]])),
        occurred_at: occurredAt, occurred_at_beijing: formatShanghaiDateTime(new Date(occurredAt)),
        audit_events: ids.map(record_id => ({ record_id, action: 'created' })) };
    });
  }

  function getGrowthHistory(input) {
    const babyId = assertBaby(input?.baby_id);
    const rows = database.prepare(`SELECT id, type, created_at, weight_kg, height_cm, note
      FROM records WHERE baby_id = ? AND type IN ('weight', 'height')`).all(babyId)
      .sort((a, b) => parseStoredDate(b.created_at) - parseStoredDate(a.created_at) || b.id - a.id);
    return { ok: true, records: rows };
  }

  function listSolidFoods(input) {
    const babyId = assertBaby(input?.baby_id);
    const foods = database.prepare(`SELECT * FROM solid_foods WHERE baby_id = ? ORDER BY category, name`).all(babyId);
    const confirmed = foods.filter(food => food.manual_status === 'confirmed_safe');
    return { ok: true, foods, total_count: foods.length, confirmed_safe_count: confirmed.length,
      confirmed_safe_by_category: Object.fromEntries([...new Set(confirmed.map(food => food.category))]
        .map(category => [category, confirmed.filter(food => food.category === category).map(food => food.name)])),
      status_note: 'manual_status 为家长确认状态；空值表示尚未手动确认，不能据此断言从未吃过。' };
  }

  function getBabyProfile(input) {
    const babyId = assertBaby(input?.baby_id);
    const rows = getGrowthHistory(input).records;
    return { ok: true, baby: database.prepare('SELECT * FROM babies WHERE id = ?').get(babyId),
      as_of_date: shanghaiDateKey(getNow()),
      latest_weight: rows.find(row => row.weight_kg != null) || null,
      latest_height: rows.find(row => row.height_cm != null) || null,
      ...listSolidFoods(input) };
  }

  function setFoodStatus(input, context = {}) {
    const babyId = assertBaby(input?.baby_id);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new AgentInputError('请提供1–100种食材');
    const items = input.items.map(item => {
      const name = String(item?.name || '').trim().replace(/^西蓝花$/, '西兰花');
      if (!name || name.length > 100) throw new AgentInputError('食材名称无效');
      if (!['confirmed_safe', 'confirmed_allergy', null].includes(item.status)) throw new AgentInputError('请明确食材状态');
      return { ...item, name };
    });
    return runMutation('set_food_status', context, () => {
      const foods = items.map(item => {
        database.prepare(`INSERT INTO solid_foods (baby_id, name, category, manual_status, manual_status_note)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(baby_id, name) DO UPDATE SET
          manual_status = excluded.manual_status, manual_status_note = excluded.manual_status_note,
          updated_at = CURRENT_TIMESTAMP`).run(babyId, item.name, String(item.category || '其他'), item.status,
            String(item.note || input.note || '').trim() || null);
        return database.prepare('SELECT * FROM solid_foods WHERE baby_id = ? AND name = ?').get(babyId, item.name);
      });
      return { ok: true, foods, count: foods.length };
    });
  }

  function recordMilk(input, context = {}) {
    const babyId = assertBaby(input?.baby_id);
    const amountMl = Number(input?.amount_ml);
    if (!Number.isFinite(amountMl) || amountMl <= 0 || amountMl > 1000) {
      throw new AgentInputError('奶量应为 1–1000 ml', 'invalid_milk_amount');
    }
    return runMutation('record_milk', { ...context, source_text: context.source_text || input?.source_text }, (ctx) => {
      const occurredAt = parseAgentTime(input?.time_text, getNow());
      const result = database.prepare(`
        INSERT INTO records (
          baby_id, type, created_at, note, feeding_type, amount_ml,
          source_channel, source_message_id, source_chat_id, operator_id, updated_at
        ) VALUES (?, 'feeding', ?, ?, 'formula', ?, ?, ?, ?, ?, ?)
      `).run(
        babyId, occurredAt, String(input?.note || '').trim() || null, Math.round(amountMl),
        ctx.source_channel, ctx.source_message_id, ctx.source_chat_id, ctx.operator_id, occurredAt,
      );
      return {
        ok: true,
        action: 'milk_recorded',
        record_id: Number(result.lastInsertRowid),
        amount_ml: Math.round(amountMl),
        occurred_at: occurredAt,
        occurred_at_beijing: formatShanghaiDateTime(new Date(occurredAt)),
        audit_events: [{ record_id: Number(result.lastInsertRowid), action: 'created' }],
      };
    });
  }

  function startSleep(input, context = {}) {
    const babyId = assertBaby(input?.baby_id);
    return runMutation('start_sleep', { ...context, source_text: context.source_text || input?.source_text }, (ctx) => {
      const open = database.prepare(`
        SELECT id, sleep_start FROM records
        WHERE baby_id = ? AND type = 'sleep' AND sleep_start IS NOT NULL AND sleep_end IS NULL
        ORDER BY id DESC LIMIT 1
      `).get(babyId);
      if (open) {
        throw new AgentInputError('已经有一段进行中的睡眠，请先确认是否已经醒来', 'sleep_already_open', open);
      }
      const startedAt = parseAgentTime(input?.time_text, getNow());
      const result = database.prepare(`
        INSERT INTO records (
          baby_id, type, created_at, sleep_start, note,
          source_channel, source_message_id, source_chat_id, operator_id, updated_at
        ) VALUES (?, 'sleep', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        babyId, startedAt, startedAt, String(input?.note || '').trim() || null,
        ctx.source_channel, ctx.source_message_id, ctx.source_chat_id, ctx.operator_id, startedAt,
      );
      return {
        ok: true,
        action: 'sleep_started',
        record_id: Number(result.lastInsertRowid),
        sleep_start: startedAt,
        sleep_start_beijing: formatShanghaiDateTime(new Date(startedAt)),
        audit_events: [{ record_id: Number(result.lastInsertRowid), action: 'sleep_started' }],
      };
    });
  }

  function endSleep(input, context = {}) {
    const babyId = assertBaby(input?.baby_id);
    return runMutation('end_sleep', { ...context, source_text: context.source_text || input?.source_text }, (ctx) => {
      const open = database.prepare(`
        SELECT * FROM records
        WHERE baby_id = ? AND type = 'sleep' AND sleep_start IS NOT NULL AND sleep_end IS NULL
        ORDER BY id DESC LIMIT 1
      `).get(babyId);
      if (!open) throw new AgentInputError('没有找到进行中的睡眠记录', 'no_open_sleep');
      const endedAt = parseAgentTime(input?.time_text, getNow());
      const start = parseStoredDate(open.sleep_start);
      const end = new Date(endedAt);
      if (!start || end <= start) {
        throw new AgentInputError('醒来时间必须晚于入睡时间', 'sleep_end_before_start');
      }
      database.prepare(`UPDATE records SET sleep_end = ?, updated_at = ? WHERE id = ?`).run(endedAt, endedAt, open.id);
      return {
        ok: true,
        action: 'sleep_ended',
        record_id: Number(open.id),
        sleep_start: open.sleep_start,
        sleep_start_beijing: start ? formatShanghaiDateTime(start) : null,
        sleep_end: endedAt,
        sleep_end_beijing: formatShanghaiDateTime(end),
        duration_minutes: Math.round((end.getTime() - start.getTime()) / 60000),
        audit_events: [{ record_id: Number(open.id), action: 'sleep_ended' }],
      };
    });
  }

  function recordSolidMeal(input, context = {}) {
    const babyId = assertBaby(input?.baby_id);
    const rawItems = normalizeItems(input?.items);
    return runMutation('record_solid_meal', { ...context, source_text: context.source_text || input?.source_text }, (ctx) => {
      const occurredAt = parseAgentTime(input?.time_text, getNow());
      const items = rawItems.map((raw) => {
        let food = raw.food_id
          ? database.prepare('SELECT * FROM solid_foods WHERE id = ? AND baby_id = ?').get(raw.food_id, babyId)
          : null;
        if (!food) food = database.prepare('SELECT * FROM solid_foods WHERE baby_id = ? AND name = ?').get(babyId, raw.name);
        if (!food) {
          const inserted = database.prepare(`
            INSERT INTO solid_foods (baby_id, name, category) VALUES (?, ?, '其他')
          `).run(babyId, raw.name);
          food = database.prepare('SELECT * FROM solid_foods WHERE id = ?').get(inserted.lastInsertRowid);
        }
        return { ...raw, food_id: Number(food.id), name: food.name, category: food.category };
      });
      const result = database.prepare(`
        INSERT INTO records (
          baby_id, type, created_at, note, solid_items_json,
          reaction_types_json, reaction_note, suspected_food_ids_json,
          source_channel, source_message_id, source_chat_id, operator_id, updated_at
        ) VALUES (?, 'solid_meal', ?, ?, ?, '[]', NULL, '[]', ?, ?, ?, ?, ?)
      `).run(
        babyId, occurredAt, String(input?.note || '').trim() || null, JSON.stringify(items),
        ctx.source_channel, ctx.source_message_id, ctx.source_chat_id, ctx.operator_id, occurredAt,
      );
      return {
        ok: true,
        action: 'solid_meal_recorded',
        record_id: Number(result.lastInsertRowid),
        occurred_at: occurredAt,
        occurred_at_beijing: formatShanghaiDateTime(new Date(occurredAt)),
        items,
        audit_events: [{ record_id: Number(result.lastInsertRowid), action: 'created' }],
      };
    });
  }

  function getLatestFeeding({ baby_id: babyId }) {
    const id = assertBaby(babyId);
    const now = getNow();
    const rows = database.prepare(`
      SELECT id, created_at, amount_ml, feeding_type, note
      FROM records
      WHERE baby_id = ? AND type = 'feeding' AND amount_ml IS NOT NULL
    `).all(id);
    const latest = latestByDate(rows, 'created_at');
    if (!latest) {
      return {
        ok: true,
        found: false,
        record_id: null,
        amount_ml: null,
        occurred_at: null,
        occurred_at_beijing: null,
        minutes_ago: null,
        elapsed_text: null,
      };
    }
    const minutesAgo = minutesSince(latest.date, now);
    return {
      ok: true,
      found: true,
      record_id: Number(latest.row.id),
      amount_ml: Number(latest.row.amount_ml),
      feeding_type: latest.row.feeding_type || null,
      note: latest.row.note || null,
      occurred_at: latest.date.toISOString(),
      occurred_at_beijing: formatShanghaiDateTime(latest.date),
      minutes_ago: minutesAgo,
      elapsed_text: elapsedText(minutesAgo),
    };
  }

  function getLatestWake({ baby_id: babyId }) {
    const id = assertBaby(babyId);
    const now = getNow();
    const rows = database.prepare(`
      SELECT id, sleep_start, sleep_end
      FROM records
      WHERE baby_id = ? AND type = 'sleep'
    `).all(id);
    const completed = latestByDate(rows.filter((row) => row.sleep_end), 'sleep_end');
    const open = latestByDate(rows.filter((row) => !row.sleep_end), 'sleep_start');
    const currentSleepStart = open?.date || null;
    if (!completed) {
      return {
        ok: true,
        found: false,
        currently_sleeping: Boolean(currentSleepStart),
        current_sleep_start: currentSleepStart?.toISOString() || null,
        current_sleep_start_beijing: currentSleepStart ? formatShanghaiDateTime(currentSleepStart) : null,
        record_id: null,
        woke_at: null,
        woke_at_beijing: null,
        awake_minutes: null,
        awake_text: null,
        sleep_duration_minutes: null,
      };
    }

    const sleepStart = parseStoredDate(completed.row.sleep_start);
    const sleepDuration = sleepStart
      ? Math.max(0, Math.round((completed.date.getTime() - sleepStart.getTime()) / 60000))
      : null;
    const awakeMinutes = minutesSince(completed.date, now);
    const currentlySleeping = Boolean(currentSleepStart && currentSleepStart.getTime() > completed.date.getTime());
    return {
      ok: true,
      found: true,
      currently_sleeping: currentlySleeping,
      current_sleep_start: currentlySleeping ? currentSleepStart.toISOString() : null,
      current_sleep_start_beijing: currentlySleeping ? formatShanghaiDateTime(currentSleepStart) : null,
      record_id: Number(completed.row.id),
      woke_at: completed.date.toISOString(),
      woke_at_beijing: formatShanghaiDateTime(completed.date),
      awake_minutes: awakeMinutes,
      awake_text: elapsedText(awakeMinutes),
      sleep_duration_minutes: sleepDuration,
    };
  }

  function getPeriodSummary(input = {}) {
    const babyId = assertBaby(input.baby_id);
    const now = getNow();
    const { startDate, endDate, start, end, days } = normalizeSummaryRange(input, now);
    const dailyMap = new Map();
    for (let index = 0; index < days; index += 1) {
      const date = shanghaiDateKey(addShanghaiDays(start, index));
      dailyMap.set(date, {
        date,
        milk: { count: 0, total_ml: 0 },
        sleep: { sessions: 0, total_minutes: 0 },
        solids: { meals: 0, items: [] },
      });
    }

    let milkCount = 0;
    let milkMl = 0;
    let sleepMinutes = 0;
    let sleepCount = 0;
    let openSleep = null;
    const solidItems = [];
    let solidMeals = 0;
    const rows = database.prepare(`
      SELECT * FROM records WHERE baby_id = ?
      AND type IN ('feeding', 'sleep', 'solid_meal') ORDER BY id DESC LIMIT 5000
    `).all(babyId);

    for (const row of rows) {
      if (row.type === 'feeding') {
        const at = parseStoredDate(row.created_at);
        if (!at || at < start || at >= end) continue;
        const date = shanghaiDateKey(at);
        const daily = dailyMap.get(date);
        if (!daily) continue;
        const amount = Number(row.amount_ml || 0);
        milkCount += 1;
        milkMl += amount;
        daily.milk.count += 1;
        daily.milk.total_ml += amount;
      } else if (row.type === 'solid_meal') {
        const at = parseStoredDate(row.created_at);
        if (!at || at < start || at >= end) continue;
        const date = shanghaiDateKey(at);
        const daily = dailyMap.get(date);
        if (!daily) continue;
        const items = parseJsonArray(row.solid_items_json);
        solidMeals += 1;
        solidItems.push(...items);
        daily.solids.meals += 1;
        daily.solids.items.push(...items);
      } else if (row.type === 'sleep') {
        const sleepStart = parseStoredDate(row.sleep_start || row.created_at);
        const sleepEnd = parseStoredDate(row.sleep_end) || (row.sleep_end ? null : now);
        if (!sleepStart || !sleepEnd || sleepEnd <= start || sleepStart >= end) continue;
        const clippedStart = new Date(Math.max(sleepStart.getTime(), start.getTime()));
        const clippedEnd = new Date(Math.min(sleepEnd.getTime(), end.getTime()));
        const clippedMinutes = Math.max(0, Math.round((clippedEnd - clippedStart) / 60000));
        sleepMinutes += clippedMinutes;
        sleepCount += 1;
        if (!row.sleep_end && !openSleep) openSleep = { record_id: row.id, sleep_start: row.sleep_start };

        for (let index = 0; index < days; index += 1) {
          const date = shanghaiDateKey(addShanghaiDays(start, index));
          const day = dailyMap.get(date);
          const dayStart = addShanghaiDays(start, index);
          const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
          const segmentStart = new Date(Math.max(sleepStart.getTime(), dayStart.getTime()));
          const segmentEnd = new Date(Math.min(sleepEnd.getTime(), dayEnd.getTime()));
          if (!day || segmentEnd <= segmentStart) continue;
          day.sleep.sessions += 1;
          day.sleep.total_minutes += Math.max(0, Math.round((segmentEnd - segmentStart) / 60000));
        }
      }
    }

    const daily = [...dailyMap.values()].map((day) => ({
      ...day,
      milk: {
        ...day.milk,
        total_ml: Math.round(day.milk.total_ml),
      },
    }));
    return {
      ok: true,
      start_date: startDate,
      end_date: endDate,
      days,
      milk: {
        count: milkCount,
        total_ml: Math.round(milkMl),
        avg_daily_ml: Math.round(milkMl / days),
        avg_per_feed_ml: milkCount ? Math.round(milkMl / milkCount) : 0,
      },
      sleep: {
        count: sleepCount,
        total_minutes: sleepMinutes,
        avg_daily_minutes: Math.round(sleepMinutes / days),
        open: openSleep,
      },
      solids: { meals: solidMeals, items: solidItems },
      daily,
    };
  }

  function getTodaySummary(input = {}) {
    const summary = getPeriodSummary({ ...input, date: input.date || shanghaiDateKey(getNow()) });
    return {
      ok: true,
      date: summary.start_date,
      milk: { count: summary.milk.count, total_ml: summary.milk.total_ml },
      sleep: { count: summary.sleep.count, total_minutes: summary.sleep.total_minutes, open: summary.sleep.open },
      solids: summary.solids,
    };
  }

  function listMealPlans({ baby_id: babyId, from, to }) {
    const id = assertBaby(babyId);
    const start = from || shanghaiDateKey(getNow());
    const finish = to || start;
    dayBounds(start);
    dayBounds(finish);
    return database.prepare(`
      SELECT * FROM meal_plans WHERE baby_id = ? AND plan_date BETWEEN ? AND ? ORDER BY plan_date
    `).all(id, start, finish).map((row) => ({ ...row, items: parseJsonArray(row.items_json) }));
  }

  function getMealPlan({ baby_id: babyId, date }) {
    const id = assertBaby(babyId);
    const planDate = date || shanghaiDateKey(getNow());
    dayBounds(planDate);
    const row = database.prepare('SELECT * FROM meal_plans WHERE baby_id = ? AND plan_date = ?').get(id, planDate);
    return row ? { ...row, items: parseJsonArray(row.items_json) } : null;
  }

  function saveMealPlan({ baby_id: babyId, date, items, note }) {
    const id = assertBaby(babyId);
    dayBounds(date);
    const normalizedItems = normalizeItems(items);
    database.prepare(`
      INSERT INTO meal_plans (baby_id, plan_date, items_json, note, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(baby_id, plan_date) DO UPDATE SET
        items_json = excluded.items_json,
        note = excluded.note,
        updated_at = CURRENT_TIMESTAMP
    `).run(id, date, JSON.stringify(normalizedItems), String(note || '').trim() || null);
    return getMealPlan({ baby_id: id, date });
  }

  function deleteMealPlan({ baby_id: babyId, date }) {
    const id = assertBaby(babyId);
    dayBounds(date);
    const result = database.prepare('DELETE FROM meal_plans WHERE baby_id = ? AND plan_date = ?').run(id, date);
    return { ok: true, deleted: result.changes > 0 };
  }

  function getAgentSettings({ baby_id: babyId }) {
    const id = assertBaby(babyId);
    let row = database.prepare('SELECT * FROM agent_settings WHERE baby_id = ?').get(id);
    if (!row) {
      database.prepare('INSERT INTO agent_settings (baby_id) VALUES (?)').run(id);
      row = database.prepare('SELECT * FROM agent_settings WHERE baby_id = ?').get(id);
    }
    return {
      ...row,
      enabled: Boolean(row.enabled),
      reminder_enabled: Boolean(row.reminder_enabled),
    };
  }

  function saveAgentSettings(input) {
    const id = assertBaby(input.baby_id);
    const reminderTime = String(input.reminder_time || '08:30');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) {
      throw new AgentInputError('提醒时间格式应为 HH:mm', 'invalid_reminder_time');
    }
    const existing = getAgentSettings({ baby_id: id });
    const values = {
      enabled: input.enabled == null ? existing.enabled : Boolean(input.enabled),
      channel: String(input.channel || existing.channel || 'weixin'),
      target_session_key: input.target_session_key == null
        ? existing.target_session_key
        : String(input.target_session_key).trim() || null,
      reminder_enabled: input.reminder_enabled == null
        ? existing.reminder_enabled
        : Boolean(input.reminder_enabled),
      reminder_time: reminderTime,
    };
    database.prepare(`
      UPDATE agent_settings SET
        enabled = ?, channel = ?, target_session_key = ?, reminder_enabled = ?,
        reminder_time = ?, timezone = 'Asia/Shanghai', updated_at = CURRENT_TIMESTAMP
      WHERE baby_id = ?
    `).run(
      values.enabled ? 1 : 0, values.channel, values.target_session_key,
      values.reminder_enabled ? 1 : 0, values.reminder_time, id,
    );
    return getAgentSettings({ baby_id: id });
  }

  function updateCronSync(babyId, patch) {
    assertBaby(babyId);
    database.prepare(`
      UPDATE agent_settings SET cron_job_id = ?, cron_sync_status = ?, cron_sync_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE baby_id = ?
    `).run(patch.cron_job_id || null, patch.cron_sync_status, patch.cron_sync_error || null, babyId);
    return getAgentSettings({ baby_id: babyId });
  }

  function buildDailyReminder({ baby_id: babyId, date }) {
    const planDate = date || shanghaiDateKey(getNow());
    const plan = getMealPlan({ baby_id: babyId, date: planDate });
    const message = plan
      ? `今日辅食计划：${plan.items.map(formatPlanItem).join('、')}${plan.note ? `。${plan.note}` : ''}`
      : '今天还未配置辅食计划。';
    return { ok: true, date: planDate, has_plan: Boolean(plan), message, plan };
  }

  return {
    recordGrowth,
    getGrowthHistory,
    getBabyProfile,
    listSolidFoods,
    setFoodStatus,
    recordMilk,
    startSleep,
    endSleep,
    recordSolidMeal,
    getLatestFeeding,
    getLatestWake,
    getPeriodSummary,
    getTodaySummary,
    listMealPlans,
    getMealPlan,
    saveMealPlan,
    deleteMealPlan,
    getAgentSettings,
    saveAgentSettings,
    updateCronSync,
    buildDailyReminder,
  };
}
