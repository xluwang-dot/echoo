import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { hashPassword } from "../src/auth.js";
import {
  addVocab,
  removeVocabBySentence,
  getUserVocab,
  getVocabSentenceIds,
  markMastered,
  getMasteredCount,
} from "../src/vocab.js";

const TEST_DB = path.join(os.tmpdir(), "word_typer_test_t008.db");
let db: DatabaseSync;
let userA: number;
let userB: number;
let sentence1: number;
let sentence2: number;
let wordFoo: number;
let wordBar: number;
let wordBaz: number;

function freshDb(): DatabaseSync {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const d = new DatabaseSync(TEST_DB);
  d.exec("PRAGMA foreign_keys=ON");
  d.exec(SCHEMA_SQL);
  return d;
}

describe("T008 生词本数据层", () => {
  beforeAll(() => {
    db = freshDb();
    // 两个用户
    userA = db
      .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run("alice", hashPassword("a123456")).lastInsertRowid as number;
    userB = db
      .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run("bob", hashPassword("b123456")).lastInsertRowid as number;
    // 两个句子 + 三个词
    sentence1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "foo 和 bar。").lastInsertRowid as number;
    sentence2 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("bar baz.", "bar 和 baz。").lastInsertRowid as number;
    wordFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    wordBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    wordBaz = db.prepare("INSERT INTO words (word) VALUES (?)").run("baz").lastInsertRowid as number;
  });
  afterAll(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("addVocab 幂等：重复 add 行数不变", () => {
    addVocab(db, userA, wordFoo, sentence1);
    addVocab(db, userA, wordFoo, sentence1);
    addVocab(db, userA, wordFoo, sentence1);
    const r = db
      .prepare("SELECT COUNT(*) AS c FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?")
      .get(userA, wordFoo, sentence1) as { c: number };
    expect(r.c).toBe(1);
  });

  it("同词不同句 → 两条；不同词同句 → 多条", () => {
    addVocab(db, userA, wordFoo, sentence2);
    addVocab(db, userA, wordBar, sentence1);
    const c = db.prepare("SELECT COUNT(*) AS c FROM user_vocab WHERE user_id=?").get(userA) as { c: number };
    expect(c.c).toBe(3);
  });

  it("getUserVocab 返回可展示条目（含词与句）", () => {
    const rows = getUserVocab(db, userA);
    expect(rows.length).toBe(3);
    const foo1 = rows.find((r) => r.word === "foo" && r.sentence_id === sentence1)!;
    expect(foo1.en).toBe("foo bar.");
    expect(foo1.zh).toContain("foo 和 bar");
  });

  it("按句移除：该句所有词句对消失，他句不受影响", () => {
    removeVocabBySentence(db, userA, sentence2);
    const rows = getUserVocab(db, userA);
    expect(rows.length).toBe(2); // foo/s1 + bar/s1，s2 的两条全没了
    expect(rows.every((r) => r.sentence_id !== sentence2)).toBe(true);
  });

  it("getVocabSentenceIds 返回去重句子 id", () => {
    addVocab(db, userA, wordFoo, sentence2);
    addVocab(db, userA, wordBar, sentence2);
    const ids = getVocabSentenceIds(db, userA);
    expect(ids).toContain(sentence1);
    expect(ids).toContain(sentence2);
    // 去重
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("跨用户隔离：A 的生词本不含 B 数据", () => {
    // B 单独加一条
    addVocab(db, userB, wordBaz, sentence2);
    const rowsA = getUserVocab(db, userA);
    expect(rowsA.some((r) => r.word === "baz")).toBe(false);
    const rowsB = getUserVocab(db, userB);
    expect(rowsB.length).toBe(1);
    expect(rowsB[0].word).toBe("baz");
  });

  it("markMastered upsert：重复 mark 行数不变", () => {
    markMastered(db, userA, wordFoo);
    markMastered(db, userA, wordFoo);
    const r = db
      .prepare("SELECT COUNT(*) AS c FROM word_status WHERE user_id=? AND word_id=?")
      .get(userA, wordFoo) as { c: number };
    expect(r.c).toBe(1);
    const row = db
      .prepare("SELECT status FROM word_status WHERE user_id=? AND word_id=?")
      .get(userA, wordFoo) as { status: string };
    expect(row.status).toBe("mastered");
  });

  it("getMasteredCount 统计正确且按用户隔离", () => {
    markMastered(db, userA, wordBar);
    markMastered(db, userB, wordFoo);
    expect(getMasteredCount(db, userA)).toBe(2);
    expect(getMasteredCount(db, userB)).toBe(1);
  });
});
