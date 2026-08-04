import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { needsSeed, seedFromJson } from "../src/db/seed.js";

const POOL_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "res", "sentence_pool.json");
const TEST_DB = path.join(os.tmpdir(), "word_typer_test_t006.db");

let db: DatabaseSync;

function freshDb(): DatabaseSync {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const d = new DatabaseSync(TEST_DB);
  d.exec("PRAGMA foreign_keys=ON");
  d.exec(SCHEMA_SQL);
  return d;
}

describe("T006 seed", () => {
  beforeAll(() => {
    db = freshDb();
  });
  afterAll(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("空库 needsSeed 为 true，落库后为 false", () => {
    expect(needsSeed(db)).toBe(true);
    const n = seedFromJson(db, POOL_PATH);
    expect(n).toBe(1405);
    expect(needsSeed(db)).toBe(false);
  });

  it("sentences 数 = 1405", () => {
    const r = db.prepare("SELECT COUNT(*) AS c FROM sentences").get() as { c: number };
    expect(r.c).toBe(1405);
  });

  it("sentence_words 数 = token 总数 10687", () => {
    const r = db.prepare("SELECT COUNT(*) AS c FROM sentence_words").get() as { c: number };
    expect(r.c).toBe(10687);
  });

  it("words 唯一词形 = 2378", () => {
    const r = db.prepare("SELECT COUNT(*) AS c FROM words").get() as { c: number };
    expect(r.c).toBe(2378);
  });

  it("Tom 的 is_name = 1 且关联到句子", () => {
    const w = db.prepare("SELECT id, is_name FROM words WHERE word = ?").get("Tom") as { id: number; is_name: number };
    expect(w.is_name).toBe(1);
    const sw = db.prepare("SELECT COUNT(*) AS c FROM sentence_words WHERE word_id = ?").get(w.id) as { c: number };
    expect(sw.c).toBe(1);
  });

  it("students' 词尾撇号词正常入库", () => {
    const w = db.prepare("SELECT id FROM words WHERE word = ?").get("students'") as { id: number };
    expect(w.id).toBeGreaterThan(0);
  });

  it("抽样句 en/zh/position/is_bold 正确", () => {
    const s = db.prepare(
      "SELECT id, en, zh, round, topic, section, source FROM sentences WHERE en LIKE 'Our school%'"
    ).get() as { id: number; en: string; zh: string; round: string; source: string };
    expect(s.round).toBe("第一轮");
    expect(s.source).toBe("grammar");
    expect(s.zh).toContain("图书馆");
    // 该句 tokens：Our school has a large library with thousands of books.
    const toks = db.prepare(
      "SELECT sw.position, w.word, sw.is_bold FROM sentence_words sw JOIN words w ON w.id=sw.word_id WHERE sw.sentence_id=? ORDER BY sw.position"
    ).all(s.id) as { position: number; word: string; is_bold: number }[];
    expect(toks.length).toBe(10);
    expect(toks[0].word).toBe("Our");
    expect(toks[0].position).toBe(0);
    const lib = toks.find((t) => t.word === "library")!;
    expect(lib.is_bold).toBe(1);
    const school = toks.find((t) => t.word === "school")!;
    expect(school.is_bold).toBe(0);
  });

  it("幂等：重跑后行数不变", () => {
    const before = db.prepare("SELECT COUNT(*) AS c FROM sentences").get() as { c: number };
    seedFromJson(db, POOL_PATH);
    const after = db.prepare("SELECT COUNT(*) AS c FROM sentences").get() as { c: number };
    expect(after.c).toBe(before.c);
  });
});
