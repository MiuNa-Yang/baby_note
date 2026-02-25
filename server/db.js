import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dataDir = join(__dirname, '../data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const dbPath = join(dataDir, 'babynote.db');
export const db = new Database(dbPath);

// 鍒濆鍖栨暟鎹簱
export function initDb() {
  db.exec(`
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_records_baby_type ON records(baby_id, type);
    CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at);
  `);

  // 兼容已有数据库：补齐新增字段
  const cols = db.prepare(`PRAGMA table_info(records)`).all();
  const hasWeightCol = cols.some((c) => c.name === 'weight_kg');
  const hasHeightCol = cols.some((c) => c.name === 'height_cm');
  const hasStoolCol = cols.some((c) => c.name === 'stool');
  if (!hasWeightCol) {
    db.exec(`ALTER TABLE records ADD COLUMN weight_kg REAL`);
  }
  if (!hasHeightCol) {
    db.exec(`ALTER TABLE records ADD COLUMN height_cm REAL`);
  }
  if (!hasStoolCol) {
    db.exec(`ALTER TABLE records ADD COLUMN stool INTEGER DEFAULT 0`);
  }

  // 鎻掑叆榛樿鎻愰啋瑙勫垯
  const count = db.prepare('SELECT COUNT(*) as c FROM reminder_rules').get();
  if (count.c === 0) {
    const insert = db.prepare(`
      INSERT INTO reminder_rules (min_days, max_days, feeding_interval_hours, diaper_interval_hours)
      VALUES (?, ?, ?, ?)
    `);
    insert.run(0, 9999, 3, 4);
  } else if (count.c > 1) {
    // 兼容旧数据：仅保留第一条规则，改为全局规则
    db.exec(`
      DELETE FROM reminder_rules
      WHERE id NOT IN (
        SELECT id FROM reminder_rules ORDER BY id ASC LIMIT 1
      )
    `);
  }

  const onlyRule = db.prepare('SELECT id, min_days, max_days FROM reminder_rules ORDER BY id ASC LIMIT 1').get();
  if (onlyRule && (onlyRule.min_days !== 0 || onlyRule.max_days !== 9999)) {
    db.prepare('UPDATE reminder_rules SET min_days = 0, max_days = 9999 WHERE id = ?').run(onlyRule.id);
  }
}

