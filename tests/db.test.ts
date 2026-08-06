import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, TABLES, EXPECTED_COLUMNS } from "../src/db/schema.js";
import { resetDb } from "../src/db.js";

const TEST_DB = path.join(os.tmpdir(), "word_typer_test_t005.db");

afterEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

function openDb(): DatabaseSync {
  return new DatabaseSync(TEST_DB);
}

describe("T005 schema", () => {
  it("建库后 9 张表全部存在", () => {
    const db = openDb();
    db.exec(SCHEMA_SQL);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));
    for (const t of TABLES) expect(names.has(t)).toBe(true);
    db.close();
  });

  it("每张表关键列齐全", () => {
    const db = openDb();
    db.exec(SCHEMA_SQL);
    for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      const got = new Set(rows.map((r) => r.name));
      for (const c of cols) expect(got.has(c), `${table}.${c}`).toBe(true);
    }
    db.close();
  });

  it("initDb 幂等：重复执行不报错", () => {
    const db = openDb();
    db.exec(SCHEMA_SQL);
    db.exec(SCHEMA_SQL);
    db.close();
  });

  it("sentences.en 唯一约束生效", () => {
    const db = openDb();
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("hello world.", "你好世界。");
    expect(() =>
      db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("hello world.", "重复。")
    ).toThrow();
    db.close();
  });

  it("users.username 唯一约束生效", () => {
    const db = openDb();
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("alice", "x");
    expect(() =>
      db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("alice", "y")
    ).toThrow();
    db.close();
  });

  it("外键开启 PRAGMA foreign_keys 生效", () => {
    const db = openDb();
    db.exec(SCHEMA_SQL);
    db.exec("PRAGMA foreign_keys=ON");
    const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
    db.close();
  });

  it("迁移：旧版 sentence_reports 无 description 列 → initDb 自动补列（T020）", () => {
    // 模拟 T017 时代的旧库：sentence_reports 无 description 列
    const db = openDb();
    db.exec(`CREATE TABLE sentence_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sentence_id INTEGER NOT NULL,
      user_id INTEGER,
      time TEXT,
      status TEXT
    )`);
    db.close();
    // initDb（经 resetDb 重建句柄）触发迁移
    resetDb(TEST_DB);
    const cols = (
      new DatabaseSync(TEST_DB).prepare("PRAGMA table_info(sentence_reports)").all() as { name: string }[]
    ).map((r) => r.name);
    expect(cols).toContain("description");
    // 幂等：再次 initDb 不报错且列仍在
    resetDb(TEST_DB);
    const again = (
      new DatabaseSync(TEST_DB).prepare("PRAGMA table_info(sentence_reports)").all() as { name: string }[]
    ).map((r) => r.name);
    expect(again).toContain("description");
  });
});
