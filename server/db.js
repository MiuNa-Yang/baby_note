import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dataDir = join(__dirname, '../data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

export const dbPath = process.env.BABYNOTE_DB_PATH
  ? resolve(process.env.BABYNOTE_DB_PATH)
  : join(dataDir, 'babynote.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// 鍒濆鍖栨暟鎹簱
export function initDb(database = db) {
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS babies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      birthdate TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      note TEXT,
      -- 鍠傚ザ鐩稿叧
      feeding_type TEXT,
      left_minutes INTEGER,
      right_minutes INTEGER,
      amount_ml INTEGER,
      -- 鐫＄湢鐩稿叧
      sleep_start TEXT,
      sleep_end TEXT,
      -- 换尿布相关
      stool INTEGER DEFAULT 0,
      -- 鐢ㄨ嵂鐩稿叧
      medicine_name TEXT,
      medicine_amount TEXT,
      -- 辅食相关（JSON 字符串，保留在通用记录表便于时间线/导出）
      solid_items_json TEXT,
      reaction_types_json TEXT,
      reaction_note TEXT,
      suspected_food_ids_json TEXT,
      -- 体重相关
      weight_kg REAL,
      -- 身高相关
      height_cm REAL,
      FOREIGN KEY (baby_id) REFERENCES babies(id)
    );

    CREATE TABLE IF NOT EXISTS reminder_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      min_days INTEGER NOT NULL,
      max_days INTEGER NOT NULL,
      feeding_interval_hours REAL NOT NULL,
      diaper_interval_hours REAL NOT NULL,
      feeding_interval_minutes INTEGER DEFAULT 0,
      diaper_interval_minutes INTEGER DEFAULT 0,
      awake_interval_hours INTEGER DEFAULT 2,
      awake_interval_minutes INTEGER DEFAULT 15,
      show_sleep_time_range INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schedule_custom (
      baby_id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (baby_id) REFERENCES babies(id)
    );

    CREATE TABLE IF NOT EXISTS solid_foods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      category TEXT NOT NULL DEFAULT '其他',
      allergen_group TEXT,
      manual_status TEXT,
      manual_status_note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (baby_id, name),
      FOREIGN KEY (baby_id) REFERENCES babies(id)
    );

    CREATE TABLE IF NOT EXISTS meal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL,
      plan_date TEXT NOT NULL,
      items_json TEXT NOT NULL DEFAULT '[]',
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (baby_id, plan_date),
      FOREIGN KEY (baby_id) REFERENCES babies(id)
    );

    CREATE TABLE IF NOT EXISTS agent_settings (
      baby_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      channel TEXT NOT NULL DEFAULT 'weixin',
      target_session_key TEXT,
      reminder_enabled INTEGER NOT NULL DEFAULT 1,
      reminder_time TEXT NOT NULL DEFAULT '08:30',
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      cron_job_id TEXT,
      cron_sync_status TEXT NOT NULL DEFAULT 'waiting_for_channel',
      cron_sync_error TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (baby_id) REFERENCES babies(id)
    );

    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_channel TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_chat_id TEXT,
      operator_id TEXT,
      source_text TEXT,
      operation TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      record_id INTEGER,
      result_json TEXT,
      received_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      UNIQUE (source_channel, source_message_id)
    );

    CREATE TABLE IF NOT EXISTS record_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      source_channel TEXT,
      source_message_id TEXT,
      source_chat_id TEXT,
      operator_id TEXT,
      source_text TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reminder_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL,
      delivery_date TEXT NOT NULL,
      reminder_kind TEXT NOT NULL DEFAULT 'daily_meal_plan',
      status TEXT NOT NULL DEFAULT 'prepared',
      message_text TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      UNIQUE (baby_id, delivery_date, reminder_kind),
      FOREIGN KEY (baby_id) REFERENCES babies(id)
    );

    CREATE INDEX IF NOT EXISTS idx_records_baby_type ON records(baby_id, type);
    CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at);
    CREATE INDEX IF NOT EXISTS idx_solid_foods_baby ON solid_foods(baby_id);
    CREATE INDEX IF NOT EXISTS idx_meal_plans_baby_date ON meal_plans(baby_id, plan_date);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_source ON agent_messages(source_channel, source_message_id);
    CREATE INDEX IF NOT EXISTS idx_record_audit_record ON record_audit_events(record_id);
  `);

  // 兼容已有数据库：补齐新增字段
  const cols = database.prepare(`PRAGMA table_info(records)`).all();
  const hasWeightCol = cols.some((c) => c.name === 'weight_kg');
  const hasHeightCol = cols.some((c) => c.name === 'height_cm');
  const hasStoolCol = cols.some((c) => c.name === 'stool');
  if (!hasWeightCol) {
    database.exec(`ALTER TABLE records ADD COLUMN weight_kg REAL`);
  }
  if (!hasHeightCol) {
    database.exec(`ALTER TABLE records ADD COLUMN height_cm REAL`);
  }
  if (!hasStoolCol) {
    database.exec(`ALTER TABLE records ADD COLUMN stool INTEGER DEFAULT 0`);
  }

  const solidRecordCols = database.prepare(`PRAGMA table_info(records)`).all();
  const solidRecordColumns = [
    ['solid_items_json', 'TEXT'],
    ['reaction_types_json', 'TEXT'],
    ['reaction_note', 'TEXT'],
    ['suspected_food_ids_json', 'TEXT'],
    ['source_channel', 'TEXT'],
    ['source_message_id', 'TEXT'],
    ['source_chat_id', 'TEXT'],
    ['operator_id', 'TEXT'],
    ['updated_at', 'TEXT'],
  ];
  for (const [name, type] of solidRecordColumns) {
    if (!solidRecordCols.some((c) => c.name === name)) {
      database.exec(`ALTER TABLE records ADD COLUMN ${name} ${type}`);
    }
  }

  const reminderRuleCols = database.prepare(`PRAGMA table_info(reminder_rules)`).all();
  if (!reminderRuleCols.some((c) => c.name === 'awake_interval_hours')) {
    database.exec(`ALTER TABLE reminder_rules ADD COLUMN awake_interval_hours INTEGER DEFAULT 2`);
  }
  if (!reminderRuleCols.some((c) => c.name === 'awake_interval_minutes')) {
    database.exec(`ALTER TABLE reminder_rules ADD COLUMN awake_interval_minutes INTEGER DEFAULT 15`);
  }
  if (!reminderRuleCols.some((c) => c.name === 'show_sleep_time_range')) {
    database.exec(`ALTER TABLE reminder_rules ADD COLUMN show_sleep_time_range INTEGER DEFAULT 1`);
  }

  // 鎻掑叆榛樿鎻愰啋瑙勫垯
  const count = database.prepare('SELECT COUNT(*) as c FROM reminder_rules').get();
  if (count.c === 0) {
    const insert = database.prepare(`
      INSERT INTO reminder_rules (min_days, max_days, feeding_interval_hours, diaper_interval_hours)
      VALUES (?, ?, ?, ?)
    `);
    insert.run(0, 9999, 3, 4);
  } else if (count.c > 1) {
    // 兼容旧数据：仅保留第一条规则，改为全局规则
    database.exec(`
      DELETE FROM reminder_rules
      WHERE id NOT IN (
        SELECT id FROM reminder_rules ORDER BY id ASC LIMIT 1
      )
    `);
  }

  const onlyRule = database.prepare('SELECT id, min_days, max_days FROM reminder_rules ORDER BY id ASC LIMIT 1').get();
  if (onlyRule && (onlyRule.min_days !== 0 || onlyRule.max_days !== 9999)) {
    database.prepare('UPDATE reminder_rules SET min_days = 0, max_days = 9999 WHERE id = ?').run(onlyRule.id);
  }
}

