// 数据库连接与初始化（平台启动时调用）
import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./db/schema.js";

export const DATA_DIR = path.join(import.meta.dirname, "..", "data");
export const DB_PATH = path.join(DATA_DIR, "word_typer.db");

let db: DatabaseSync | null = null;
let dbPath: string | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error("数据库未初始化，请先调用 initDb()");
  return db;
}

// 建库（幂等）：目录 + 建表 + 外键开启
// 轻量迁移：旧库缺失列时自动 ALTER 补列（幂等）
//   T020：sentence_reports.description
//   T026：user_vocab.interval/review_count/next_review/status；practice_sessions.mode
const MIGRATIONS: [string, string, string][] = [
  ["sentence_reports", "description", "TEXT"],
  ["user_vocab", "interval", "INTEGER DEFAULT 1"],
  ["user_vocab", "review_count", "INTEGER DEFAULT 0"],
  ["user_vocab", "next_review", "TEXT"],
  ["user_vocab", "status", "TEXT DEFAULT 'learning'"],
  ["user_vocab", "fail_count", "INTEGER DEFAULT 0"],
  ["practice_sessions", "mode", "TEXT DEFAULT 'practice'"],
  // T047a：内容分级与词语音字段
  ["words", "level", "INTEGER DEFAULT 5"],
  ["words", "meaning", "TEXT"],
  ["words", "phonetic", "TEXT"],
  ["words", "audio_path", "TEXT"],
  ["sentences", "level", "INTEGER"],
  // T053a：用户等级
  ["users", "level", "INTEGER DEFAULT 1"],
];

function migrate(db: DatabaseSync): void {
  for (const [table, col, ddl] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  }
}

export function initDb(databasePath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  if (db && dbPath === databasePath) return db;
  if (db) db.close();
  db = new DatabaseSync(databasePath);
  dbPath = databasePath;
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

// 仅供测试：强制用新路径重建句柄
export function resetDb(databasePath: string): DatabaseSync {
  if (db) db.close();
  db = null;
  dbPath = null;
  return initDb(databasePath);
}