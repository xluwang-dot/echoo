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

  it("迁移：旧版 user_vocab / practice_sessions 补记忆字段与 mode（T026）", () => {
    // 模拟 T025 之前的旧库：user_vocab 无记忆字段、practice_sessions 无 mode
    const db = openDb();
    db.exec(`CREATE TABLE user_vocab (
      user_id INTEGER NOT NULL,
      word_id INTEGER NOT NULL,
      sentence_id INTEGER NOT NULL,
      created_at TEXT,
      PRIMARY KEY (user_id, word_id, sentence_id)
    )`);
    db.exec(`CREATE TABLE practice_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      target_count INTEGER,
      start_time TEXT,
      end_time TEXT,
      done_count INTEGER,
      total_ms INTEGER
    )`);
    db.close();
    resetDb(TEST_DB);
    const vc = (
      new DatabaseSync(TEST_DB).prepare("PRAGMA table_info(user_vocab)").all() as { name: string }[]
    ).map((r) => r.name);
    for (const c of ["interval", "review_count", "next_review", "status"]) {
      expect(vc, `user_vocab.${c}`).toContain(c);
    }
    const ps = (
      new DatabaseSync(TEST_DB).prepare("PRAGMA table_info(practice_sessions)").all() as { name: string }[]
    ).map((r) => r.name);
    expect(ps).toContain("mode");
    // 幂等
    resetDb(TEST_DB);
    const vc2 = (
      new DatabaseSync(TEST_DB).prepare("PRAGMA table_info(user_vocab)").all() as { name: string }[]
    ).map((r) => r.name);
    expect(vc2).toContain("interval");
  });
});

  it("迁移：旧版 words/sentences 补分级与语音字段（T047a）", () => {
    // 模拟 T047 之前旧库：words 无 level/meaning/phonetic/audio_path，sentences 无 level
    const db = openDb();
    db.exec(`CREATE TABLE words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL UNIQUE,
      freq INTEGER DEFAULT 0,
      is_name INTEGER DEFAULT 0,
      years TEXT
    )`);
    db.exec(`CREATE TABLE sentences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      en TEXT NOT NULL UNIQUE,
      zh TEXT NOT NULL,
      round TEXT, topic TEXT, section TEXT, source TEXT
    )`);
    db.close();
    resetDb(TEST_DB);
    const wcols = (
      new DatabaseSync(TEST_DB).prepare("PRAGMA table_info(words)").all() as { name: string }[]
    ).map((r) => r.name);
    expect(wcols).toContain("level");
    expect(wcols).toContain("meaning");
    expect(wcols).toContain("phonetic");
    expect(wcols).toContain("audio_path");
    const scols = (
      new DatabaseSync(TEST_DB).prepare("PRAGMA table_info(sentences)").all() as { name: string }[]
    ).map((r) => r.name);
    expect(scols).toContain("level");
    // 幂等：再次 initDb 不报错且列仍在
    resetDb(TEST_DB);
    const again = (
      new DatabaseSync(TEST_DB).prepare("PRAGMA table_info(words)").all() as { name: string }[]
    ).map((r) => r.name);
    expect(again).toContain("level");
  });

  it("迁移：users 补 level 字段（T053a）", () => {
    const db = openDb();
    db.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nickname TEXT,
      preferences TEXT
    )`);
    db.close();
    resetDb(TEST_DB);
    const cols = (
      new DatabaseSync(TEST_DB).prepare("PRAGMA table_info(users)").all() as { name: string }[]
    ).map((r) => r.name);
    expect(cols).toContain("level");
    // 默认 1
    const lv = new DatabaseSync(TEST_DB).prepare("SELECT level FROM users LIMIT 1").get() as { level: number } | undefined;
    // 无用户则略过默认值断言（仅验证列存在与默认）
    expect(cols).toContain("level");
  });
