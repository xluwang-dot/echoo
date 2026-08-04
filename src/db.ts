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
export function initDb(databasePath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  if (db && dbPath === databasePath) return db;
  if (db) db.close();
  db = new DatabaseSync(databasePath);
  dbPath = databasePath;
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA_SQL);
  return db;
}

// 仅供测试：强制用新路径重建句柄
export function resetDb(databasePath: string): DatabaseSync {
  if (db) db.close();
  db = null;
  dbPath = null;
  return initDb(databasePath);
}