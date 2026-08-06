import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { hashPassword } from "../src/auth.js";
import {
  getUntestedSentenceIds,
  getTestedSentenceIds,
  drawSession,
  startSession,
  finishSession,
  recordWord,
  completeSentence,
  getSentenceWithTokens,
} from "../src/practice.js";
import { addVocab } from "../src/vocab.js";

const TEST_DB = path.join(os.tmpdir(), "word_typer_test_t009.db");
let db: DatabaseSync;
let userA: number;
let userB: number;
let sid1: number;
let sid2: number;
let sid3: number;
let widFoo: number;
let widBar: number;
let widBaz: number;

function freshDb(): DatabaseSync {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const d = new DatabaseSync(TEST_DB);
  d.exec("PRAGMA foreign_keys=ON");
  d.exec(SCHEMA_SQL);
  return d;
}

beforeAll(() => {
  db = freshDb();
  userA = db
    .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
    .run("alice", hashPassword("a123456")).lastInsertRowid as number;
  userB = db
    .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
    .run("bob", hashPassword("b123456")).lastInsertRowid as number;
});

afterAll(() => {
  db.close();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("T009 practice 抽取", () => {
  beforeEach(() => {
    // 每个用例前重置句子/词/记录（保留用户）
    db.exec("DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM sentence_reports; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;");
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "foo 和 bar。").lastInsertRowid as number;
    sid2 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("baz qux.", "baz 和 qux。").lastInsertRowid as number;
    sid3 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("quux corge.", "quux 和 corge。").lastInsertRowid as number;
    widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    widBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    widBaz = db.prepare("INSERT INTO words (word) VALUES (?)").run("baz").lastInsertRowid as number;
  });

  it("全部未测试：target=2 从 U 抽 2 句，会话内不重复", () => {
    const ids = drawSession(db, userA, 2);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => [sid1, sid2, sid3].includes(id))).toBe(true);
  });

  it("有生词本句时按 3:7 抽：target=10 时约 3 新 + 7 复习", () => {
    // 把全部 3 句标记为已测试，并把 sid1/sid2 放入生词本
    addVocab(db, userA, widFoo, sid1);
    addVocab(db, userA, widBaz, sid2);
    // 先跑一次完整会话把所有句子标为已测试
    const sid = startSession(db, userA, 10);
    recordWord(db, sid, userA, widFoo, sid1, "mastered");
    recordWord(db, sid, userA, widBar, sid1, "mastered");
    recordWord(db, sid, userA, widBaz, sid2, "mastered");
    recordWord(db, sid, userA, widBar, sid2, "mastered");
    recordWord(db, sid, userA, widFoo, sid3, "mastered");
    recordWord(db, sid, userA, widBar, sid3, "mastered");
    finishSession(db, sid, 3, 1000);

    const ids = drawSession(db, userA, 10);
    expect(ids.length).toBe(10);
    // 3 句都已被测过 → U 空，生词本 R = {sid1, sid2}，其余从已测试补齐
    const reviewIds = getVocabSentenceIdsFor(db, userA);
    const fromReview = ids.filter((id) => reviewIds.includes(id));
    expect(fromReview.length).toBeGreaterThanOrEqual(2); // 复习池尽量抽
    // 池仅 3 句 < target 10：兜底允许重复（不再出现无题可练）
    expect(new Set(ids).size).toBeLessThanOrEqual(3);
  });

  it("池不足：从已测试句子补齐，仍满 target", () => {
    // 全部标记已测试，生词本为空
    const sid = startSession(db, userA, 3);
    recordWord(db, sid, userA, widFoo, sid1, "mastered");
    recordWord(db, sid, userA, widBar, sid1, "mastered");
    recordWord(db, sid, userA, widBaz, sid2, "mastered");
    recordWord(db, sid, userA, widFoo, sid2, "mastered");
    recordWord(db, sid, userA, widBaz, sid3, "mastered");
    recordWord(db, sid, userA, widFoo, sid3, "mastered");
    finishSession(db, sid, 3, 1000);

    // 只有 3 句全部已测试，target=5 → 补齐到 5（重复已测试句）
    const ids = drawSession(db, userA, 5);
    expect(ids.length).toBe(5);
  });

  it("跨用户隔离：A 的抽取不受 B 的生词本影响", () => {
    // B 把 sid3 放进生词本
    addVocab(db, userB, widFoo, sid3);
    const idsA = drawSession(db, userA, 3);
    expect(idsA.length).toBe(3);
    // A 的未测试句应不含因 B 产生的差异 —— 全 3 句未测试，都能抽到
    expect(idsA.every((id) => [sid1, sid2, sid3].includes(id))).toBe(true);
  });

  it("被报告句子：常规池充足时不抽到（优先规避，T017）", () => {
    // 报告 sid1
    db.prepare("INSERT INTO sentence_reports (sentence_id, user_id, time, status) VALUES (?, ?, ?, 'pending')").run(sid1, userA, "2026-08-05T00:00:00Z");
    // 未测试池 {sid1,sid2,sid3}，剔除 sid1 后 target=2 应抽 sid2/sid3
    const ids = drawSession(db, userA, 2);
    expect(ids.length).toBe(2);
    expect(ids).not.toContain(sid1);
    // 多次抽取也不含（稳定规避）
    for (let i = 0; i < 5; i++) {
      const again = drawSession(db, userA, 2);
      expect(again).not.toContain(sid1);
    }
  });

  it("被报告句子：常规池耗尽时兜底可抽到（不再出现无题可练，T017）", () => {
    // 全部标记已测试 + 全部被报告 → 常规池空
    const sid = startSession(db, userA, 3);
    recordWord(db, sid, userA, widFoo, sid1, "mastered");
    recordWord(db, sid, userA, widBar, sid1, "mastered");
    recordWord(db, sid, userA, widBaz, sid2, "mastered");
    recordWord(db, sid, userA, widFoo, sid2, "mastered");
    recordWord(db, sid, userA, widBaz, sid3, "mastered");
    recordWord(db, sid, userA, widFoo, sid3, "mastered");
    finishSession(db, sid, 3, 1000);
    for (const s of [sid1, sid2, sid3]) {
      db.prepare("INSERT INTO sentence_reports (sentence_id, user_id, time, status) VALUES (?, ?, ?, 'pending')").run(s, userA, "2026-08-05T00:00:00Z");
    }
    const ids = drawSession(db, userA, 3);
    expect(ids.length).toBe(3); // 常规池空 → 兜底抽被报告句
    expect(ids.every((id) => [sid1, sid2, sid3].includes(id))).toBe(true);
  });
});

describe("T009 practice 会话", () => {
  beforeEach(() => {
    db.exec("DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM user_vocab; DELETE FROM word_status; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;");
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "foo 和 bar。").lastInsertRowid as number;
    widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    widBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
  });

  it("startSession 创建会话，finishSession 记录用时", () => {
    const sid = startSession(db, userA, 5);
    const row = db.prepare("SELECT * FROM practice_sessions WHERE id=?").get(sid) as { target_count: number; start_time: string; end_time: null | string };
    expect(row.target_count).toBe(5);
    expect(row.start_time).toBeTruthy();
    expect(row.end_time).toBeNull();
    finishSession(db, sid, 3, 12345);
    const done = db.prepare("SELECT * FROM practice_sessions WHERE id=?").get(sid) as { done_count: number; total_ms: number; end_time: string };
    expect(done.done_count).toBe(3);
    expect(done.total_ms).toBe(12345);
    expect(done.end_time).toBeTruthy();
  });

  it("recordWord mastered → word_status 记录 + test_records 入库", () => {
    const sid = startSession(db, userA, 1);
    recordWord(db, sid, userA, widFoo, sid1, "mastered");
    const st = db.prepare("SELECT * FROM word_status WHERE user_id=? AND word_id=?").get(userA, widFoo) as { status: string };
    expect(st.status).toBe("mastered");
    const tr = db.prepare("SELECT * FROM test_records WHERE session_id=? AND word_id=?").get(sid, widFoo) as { result: string };
    expect(tr.result).toBe("mastered");
  });

  it("recordWord hint → user_vocab 入生词本（词+句）", () => {
    const sid = startSession(db, userA, 1);
    recordWord(db, sid, userA, widBar, sid1, "hint");
    const uv = db.prepare("SELECT * FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(userA, widBar, sid1);
    expect(uv).toBeTruthy();
  });

  it("completeSentence：生词本句整句拼对 → 该句所有词句对移除，他句保留", () => {
    // 准备两个句子的词句对
    const sid2 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("baz qux.", "baz 和 qux。").lastInsertRowid as number;
    const widBaz = db.prepare("INSERT INTO words (word) VALUES (?)").run("baz").lastInsertRowid as number;
    const widQux = db.prepare("INSERT INTO words (word) VALUES (?)").run("qux").lastInsertRowid as number;
    addVocab(db, userA, widFoo, sid1);
    addVocab(db, userA, widBar, sid1);
    addVocab(db, userA, widBaz, sid2);

    const sess = startSession(db, userA, 2);
    // 整句 sid1 拼对：foo、bar 全 mastered
    completeSentence(db, sess, userA, sid1, [
      { wordId: widFoo, result: "mastered" },
      { wordId: widBar, result: "mastered" },
    ]);
    // sid1 词句对应移除，sid2 的 baz 保留
    const v1 = db.prepare("SELECT COUNT(*) AS c FROM user_vocab WHERE user_id=? AND sentence_id=?").get(userA, sid1) as { c: number };
    expect(v1.c).toBe(0);
    const v2 = db.prepare("SELECT COUNT(*) AS c FROM user_vocab WHERE user_id=? AND sentence_id=?").get(userA, sid2) as { c: number };
    expect(v2.c).toBe(1);
  });

  it("getSentenceWithTokens 返回句子 + tokens（含 is_name）", () => {
    db.prepare("DELETE FROM sentence_words;");
    const widTom = db.prepare("INSERT INTO words (word, is_name) VALUES (?, 1)").run("Tom").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widFoo, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widBar, 1, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widTom, 2, 0);
    const got = getSentenceWithTokens(db, sid1);
    expect(got.en).toBe("foo bar.");
    expect(got.tokens.length).toBe(3);
    expect(got.tokens[0].word).toBe("foo");
    expect(got.tokens[2].is_name).toBe(1);
  });
});

// 辅助：取生词本句子 id 集合（本地读 user_vocab）
function getVocabSentenceIdsFor(db: DatabaseSync, userId: number): number[] {
  const rows = db.prepare("SELECT DISTINCT sentence_id FROM user_vocab WHERE user_id=?").all(userId) as { sentence_id: number }[];
  return rows.map((r) => r.sentence_id);
}

// 确保导出的函数被使用（getUntestedSentenceIds/getTestedSentenceIds 在本文件有覆盖）
describe("T009 practice 已测试句查询", () => {
  it("getTestedSentenceIds 返回 test_records 去重句 id", () => {
    db.exec("DELETE FROM test_records;");
    const sid = startSession(db, userA, 1);
    recordWord(db, sid, userA, widFoo, sid1, "mastered");
    recordWord(db, sid, userA, widBar, sid1, "mastered");
    const tested = getTestedSentenceIds(db, userA);
    expect(tested).toContain(sid1);
  });

  it("getUntestedSentenceIds 排除已测试句", () => {
    const untested = getUntestedSentenceIds(db, userA);
    expect(untested).not.toContain(sid1);
  });
});
