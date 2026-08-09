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
  advanceInterval,
  computeSentenceLevel,
  recomputeAllSentenceLevels,
  MASTERY_THRESHOLD,
  getDueReviewSentenceIds,
  drawTestSentenceIds,
  getDueCount,
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

  it("completeSentence：整句拼对 → 词句对推进不删除，5 次到期成功 → candidate（T027/T040）", () => {
    // 准备两个句子的词句对
    const sid2 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("baz qux.", "baz 和 qux。").lastInsertRowid as number;
    const widBaz = db.prepare("INSERT INTO words (word) VALUES (?)").run("baz").lastInsertRowid as number;
    const widQux = db.prepare("INSERT INTO words (word) VALUES (?)").run("qux").lastInsertRowid as number;
    addVocab(db, userA, widFoo, sid1);
    addVocab(db, userA, widBar, sid1);
    addVocab(db, userA, widBaz, sid2);

    const sess = startSession(db, userA, 2);
    // 整句 sid1 拼对
    completeSentence(db, sess, userA, sid1, [
      { wordId: widFoo, result: "mastered" },
      { wordId: widBar, result: "mastered" },
    ]);
    // v1.9：词句对不整句删除，仍在生词本且 review_count=1
    const v1 = db.prepare("SELECT COUNT(*) AS c FROM user_vocab WHERE user_id=? AND sentence_id=?").get(userA, sid1) as { c: number };
    expect(v1.c).toBe(2);
    // 推进 5 次到期复习（第一次已在上面发生，再补 4 次，每次先把 next_review 置为昨天模拟到期）→ candidate
    for (let i = 0; i < MASTERY_THRESHOLD - 1; i++) {
      db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAgo(1), userA, widFoo, sid1);
      completeSentence(db, sess, userA, sid1, [
        { wordId: widFoo, result: "mastered" },
        { wordId: widBar, result: "mastered" },
      ]);
    }
    const st = db.prepare("SELECT status FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(userA, widFoo, sid1) as { status: string };
    expect(st.status).toBe("candidate"); // T040：5 次到期成功 → 待测试验收（非直接 mastered）
    // 他句（sid2）不受影响
    const v3 = db.prepare("SELECT COUNT(*) AS c FROM user_vocab WHERE user_id=? AND sentence_id=?").get(userA, sid2) as { c: number };
    expect(v3.c).toBe(1);
    // 测试模式验收通过 → mastered
    db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAgo(1), userA, widFoo, sid1);
    completeSentence(db, sess, userA, sid1, [{ wordId: widFoo, result: "mastered" }]);
    const st2 = db.prepare("SELECT status FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(userA, widFoo, sid1) as { status: string };
    expect(st2.status).toBe("mastered");
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

// T027：日期辅助（YYYY-MM-DD）
function dateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function daysAgo(n: number): string {
  return dateStr(new Date(Date.now() - n * 86400000));
}
function daysAhead(n: number): string {
  return dateStr(new Date(Date.now() + n * 86400000));
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

describe("T027 复习调度（SM-2 间隔推进 + 到期优先）", () => {
  beforeEach(() => {
    db.exec(
      "DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM user_vocab; DELETE FROM word_status; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;"
    );
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "foo 和 bar。").lastInsertRowid as number;
    widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    widBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widFoo, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widBar, 1, 0);
  });

  it("advanceInterval：拼对推进间隔序列 1→3→7→16→35，失败重置", () => {
    expect(advanceInterval(0, true)).toEqual({ interval: 1, reviewCount: 1 });
    expect(advanceInterval(1, true)).toEqual({ interval: 3, reviewCount: 2 });
    expect(advanceInterval(2, true)).toEqual({ interval: 7, reviewCount: 3 });
    expect(advanceInterval(3, true)).toEqual({ interval: 16, reviewCount: 4 });
    expect(advanceInterval(4, true)).toEqual({ interval: 35, reviewCount: 5 });
    expect(advanceInterval(9, true)).toEqual({ interval: 35, reviewCount: 10 }); // 封顶 35
    expect(advanceInterval(4, false)).toEqual({ interval: 1, reviewCount: 0 }); // 失败重置
  });

  it("recordWord mastered：词句对推进间隔/next_review，达阈值 → candidate（T027/T039/T040）", () => {
    addVocab(db, userA, widFoo, sid1);
    const sid = startSession(db, userA, 1);
    recordWord(db, sid, userA, widFoo, sid1, "mastered"); // next_review NULL → 到期 → 推进
    let v = db.prepare("SELECT interval, review_count, status FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(userA, widFoo, sid1) as { interval: number; review_count: number; status: string };
    expect(v.interval).toBe(1);
    expect(v.review_count).toBe(1);
    expect(v.status).toBe("learning");
    // 再推进 4 次（每次模拟到期）→ 达阈值（5 次）→ candidate（T040：不再直接 mastered）
    for (let i = 0; i < MASTERY_THRESHOLD - 1; i++) {
      db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAgo(1), userA, widFoo, sid1);
      recordWord(db, sid, userA, widFoo, sid1, "mastered");
    }
    v = db.prepare("SELECT interval, review_count, status FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(userA, widFoo, sid1) as { interval: number; review_count: number; status: string };
    expect(v.review_count).toBe(MASTERY_THRESHOLD);
    expect(v.status).toBe("candidate");
    // 测试模式验收通过 → mastered
    recordWord(db, sid, userA, widFoo, sid1, "mastered");
    v = db.prepare("SELECT status FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(userA, widFoo, sid1) as { status: string };
    expect(v.status).toBe("mastered");
  });

  it("recordWord hint：入本（如不在）并重置间隔与连续成功", () => {
    addVocab(db, userA, widFoo, sid1);
    const sid = startSession(db, userA, 1);
    for (let i = 0; i < 3; i++) recordWord(db, sid, userA, widFoo, sid1, "mastered");
    recordWord(db, sid, userA, widFoo, sid1, "hint"); // 失败
    const v = db.prepare("SELECT interval, review_count FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(userA, widFoo, sid1) as { interval: number; review_count: number };
    expect(v.interval).toBe(1);
    expect(v.review_count).toBe(0);
  });

  it("getDueReviewSentenceIds：仅返回到期（next_review ≤ 今日）learning 词句对所在句", () => {
    addVocab(db, userA, widFoo, sid1);
    addVocab(db, userA, widBar, sid1);
    db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAgo(1), userA, widFoo, sid1);
    db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAhead(1), userA, widBar, sid1);
    const due = getDueReviewSentenceIds(db, userA);
    expect(due).toContain(sid1); // 含到期词的句子
  });

  it("drawSession 复习模式：到期词句对所在句优先（target=1 先抽到期句）", () => {
    // 两个句子：sid1 含到期词（foo 昨天到期）、sid2 全未到期
    const sid2 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("baz qux.", "baz 和 qux。").lastInsertRowid as number;
    const widBaz = db.prepare("INSERT INTO words (word) VALUES (?)").run("baz").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid2, widBaz, 0, 0);
    addVocab(db, userA, widFoo, sid1);
    addVocab(db, userA, widBaz, sid2);
    db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAgo(1), userA, widFoo, sid1);
    db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAhead(1), userA, widBaz, sid2);
    // 复习模式 target=1：应抽到含到期词的 sid1（多次验证稳定）
    for (let i = 0; i < 5; i++) {
      const ids = drawSession(db, userA, 1, { reviewOnly: true });
      expect(ids[0]).toBe(sid1);
    }
  });
});

describe("T028 测试模式（内容池 + 降级）", () => {
  let sid2: number;
  let sid3: number;
  let widBaz: number;
  let widQux: number;

  beforeEach(() => {
    db.exec(
      "DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM user_vocab; DELETE FROM word_status; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;"
    );
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "foo 和 bar。").lastInsertRowid as number;
    sid2 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("baz qux.", "baz 和 qux。").lastInsertRowid as number;
    sid3 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("quux corge.", "quux 和 corge。").lastInsertRowid as number;
    widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    widBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    widBaz = db.prepare("INSERT INTO words (word) VALUES (?)").run("baz").lastInsertRowid as number;
    widQux = db.prepare("INSERT INTO words (word) VALUES (?)").run("quux").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widFoo, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid2, widBaz, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid3, widQux, 0, 0);
  });

  it("recordWord test_fail：已掌握词句对降级（回 learning、间隔重置、fail_count+1）", () => {
    addVocab(db, userA, widFoo, sid1);
    db.prepare("UPDATE user_vocab SET status='mastered', review_count=5, interval=35 WHERE user_id=? AND word_id=? AND sentence_id=?").run(userA, widFoo, sid1);
    const sid = startSession(db, userA, 1);
    recordWord(db, sid, userA, widFoo, sid1, "test_fail");
    const v = db.prepare("SELECT status, interval, review_count, fail_count FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(userA, widFoo, sid1) as { status: string; interval: number; review_count: number; fail_count: number };
    expect(v.status).toBe("learning");
    expect(v.interval).toBe(1);
    expect(v.review_count).toBe(0);
    expect(v.fail_count).toBe(1);
  });

  it("drawTestSentenceIds：临近掌握优先（target=1 抽 near 句）", () => {
    // foo 临近掌握（review_count=3）、baz 高错（fail_count=2）、quux 普通 learning
    addVocab(db, userA, widFoo, sid1);
    addVocab(db, userA, widBaz, sid2);
    addVocab(db, userA, widQux, sid3);
    db.prepare("UPDATE user_vocab SET review_count=3, interval=16 WHERE user_id=? AND word_id=? AND sentence_id=?").run(userA, widFoo, sid1);
    db.prepare("UPDATE user_vocab SET fail_count=2 WHERE user_id=? AND word_id=? AND sentence_id=?").run(userA, widBaz, sid2);
    for (let i = 0; i < 5; i++) {
      const ids = drawTestSentenceIds(db, userA, 1);
      expect(ids[0]).toBe(sid1); // 临近掌握优先
    }
  });

  it("drawTestSentenceIds：scope=fail 只抽高错句", () => {
    addVocab(db, userA, widFoo, sid1);
    addVocab(db, userA, widBaz, sid2);
    addVocab(db, userA, widQux, sid3);
    db.prepare("UPDATE user_vocab SET review_count=3, interval=16 WHERE user_id=? AND word_id=? AND sentence_id=?").run(userA, widFoo, sid1);
    db.prepare("UPDATE user_vocab SET fail_count=2 WHERE user_id=? AND word_id=? AND sentence_id=?").run(userA, widBaz, sid2);
    const ids = drawTestSentenceIds(db, userA, 3, "fail");
    expect(ids).toContain(sid2);
    expect(ids).not.toContain(sid1); // near 不在 fail 池
    expect(ids).not.toContain(sid3);
  });
});

describe("T029 到期横幅数据（getDueCount）", () => {
  beforeEach(() => {
    db.exec(
      "DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM user_vocab; DELETE FROM word_status; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;"
    );
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar baz.", "foo bar baz。").lastInsertRowid as number;
    widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    widBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    const widBaz = db.prepare("INSERT INTO words (word) VALUES (?)").run("baz").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widFoo, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widBar, 1, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widBaz, 2, 0);
    addVocab(db, userA, widFoo, sid1);
    addVocab(db, userA, widBar, sid1);
    addVocab(db, userA, widBaz, sid1);
  });

  it("getDueCount：learning 到期计数，未到期/mastered 不计", () => {
    // foo 到期（昨天）、bar 未到期（明天）、baz mastered（过期也不计）
    db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAgo(1), userA, widFoo, sid1);
    db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAhead(1), userA, widBar, sid1);
    const widBaz = db.prepare("SELECT id FROM words WHERE word='baz'").get() as { id: number };
    db.prepare("UPDATE user_vocab SET status='mastered', next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAgo(1), userA, widBaz.id, sid1);
    expect(getDueCount(db, userA)).toBe(1); // 仅 foo 到期
  });

  it("getDueCount：next_review 为空（未调度）不计", () => {
    expect(getDueCount(db, userA)).toBe(0);
  });
});

describe("T037 立即复习 includeSentenceIds（必含指定句子）", () => {
  beforeEach(() => {
    db.exec("DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM user_vocab; DELETE FROM word_status; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;");
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar baz.", "A。").lastInsertRowid as number;
    sid2 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("qux quux corge.", "B。").lastInsertRowid as number;
    widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    widBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widFoo, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widBar, 1, 0);
    addVocab(db, userA, widFoo, sid1); // 句子1 在生词本（未到期）
    addVocab(db, userA, widBar, sid1);
  });

  it("includeSentenceIds：复习模式结果必含指定句（未到期也含）", () => {
    const sids = drawSession(db, userA, 5, { reviewOnly: true, includeSentenceIds: [sid1] });
    expect(sids).toContain(sid1);
  });

  it("includeSentenceIds：不在生词本的句子不包含", () => {
    const sids = drawSession(db, userA, 5, { reviewOnly: true, includeSentenceIds: [sid2] });
    expect(sids).not.toContain(sid2);
  });
});

describe("T037b 立即复习 include 优先于到期队列", () => {
  beforeEach(() => {
    db.exec("DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM user_vocab; DELETE FROM word_status; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;");
    // 两个生词句：sid1=include 目标（未到期），sid2=到期（会被现有逻辑优先抽走）
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("alpha beta.", "A。").lastInsertRowid as number;
    sid2 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("gamma delta.", "B。").lastInsertRowid as number;
    widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("alpha").lastInsertRowid as number;
    widBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("gamma").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widFoo, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid2, widBar, 0, 0);
    addVocab(db, userA, widFoo, sid1); // 未到期
    addVocab(db, userA, widBar, sid2);
    db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND sentence_id=?").run(daysAgo(1), userA, sid2); // sid2 到期
  });

  it("include 未到期句也必含（优先于到期队列）", () => {
    const sids = drawSession(db, userA, 1, { reviewOnly: true, includeSentenceIds: [sid1] });
    expect(sids).toEqual([sid1]); // 修复前：due 优先抽 sid2
  });
});

describe("T039 SM 时间语义：未到期复习成功不推进", () => {
  beforeEach(() => {
    db.exec("DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM user_vocab; DELETE FROM word_status; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;");
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar baz.", "T039。").lastInsertRowid as number;
    widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widFoo, 0, 0);
    addVocab(db, userA, widFoo, sid1); // next_review = 明天
  });

  const pair = () => db.prepare("SELECT interval, review_count, status, next_review FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(userA, widFoo, sid1) as { interval: number; review_count: number; status: string; next_review: string };

  it("到期复习成功 → 间隔进入序列下一档（1→3）", () => {
    // 初始：已成功过一次（interval=1, review_count=1），今日到期
    db.prepare("UPDATE user_vocab SET interval=1, review_count=1, next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAgo(1), userA, widFoo, sid1);
    const sid = startSession(db, userA, 1);
    recordWord(db, sid, userA, widFoo, sid1, "mastered");
    const p = pair();
    expect(p.interval).toBe(3);
    expect(p.review_count).toBe(2);
    expect(p.next_review).toBe(daysAhead(3));
  });

  it("未到期（明天到期）同日复习成功 → 不推进", () => {
    // 初始：interval=3, review_count=2，明天才到期
    db.prepare("UPDATE user_vocab SET interval=3, review_count=2, next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAhead(1), userA, widFoo, sid1);
    const sid = startSession(db, userA, 1);
    recordWord(db, sid, userA, widFoo, sid1, "mastered");
    const p = pair();
    expect(p.interval).toBe(3);
    expect(p.review_count).toBe(2);
    expect(p.next_review).toBe(daysAhead(1)); // 原计划不变
  });

  it("未到期失败（hint）→ 仍重置 1 天", () => {
    db.prepare("UPDATE user_vocab SET interval=3, review_count=1, next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAhead(1), userA, widFoo, sid1);
    const sid = startSession(db, userA, 1);
    recordWord(db, sid, userA, widFoo, sid1, "hint");
    const p = pair();
    expect(p.interval).toBe(1);
    expect(p.review_count).toBe(0);
  });
});

describe("T040 掌握判定：5 次到期成功 → candidate → 测试通过 → mastered", () => {
  beforeEach(() => {
    db.exec("DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM user_vocab; DELETE FROM word_status; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;");
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar baz.", "T040。").lastInsertRowid as number;
    sid2 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("qux quux.", "T040b。").lastInsertRowid as number;
    widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    widBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widFoo, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widBar, 1, 0);
    addVocab(db, userA, widFoo, sid1);
    addVocab(db, userA, widBar, sid1);
  });

  const pairFoo = () => db.prepare("SELECT interval, review_count, status, fail_count FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(userA, widFoo, sid1) as { interval: number; review_count: number; status: string; fail_count: number };

  // 造 candidate：5 次到期复习成功（每次先把 next_review 置为昨天）
  const toCandidate = () => {
    for (let i = 0; i < MASTERY_THRESHOLD; i++) {
      db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAgo(1), userA, widFoo, sid1);
      const sid = startSession(db, userA, 1);
      recordWord(db, sid, userA, widFoo, sid1, "mastered");
    }
  };

  it("5 次到期复习成功 → status='candidate'（非直接 mastered）", () => {
    toCandidate();
    expect(pairFoo().status).toBe("candidate");
    expect(pairFoo().interval).toBe(35);
    expect(pairFoo().review_count).toBe(5);
  });

  it("candidate 测试模式通过 → mastered（间隔不推进）", () => {
    toCandidate();
    const sid = startSession(db, userA, 1);
    recordWord(db, sid, userA, widFoo, sid1, "mastered");
    expect(pairFoo().status).toBe("mastered");
    expect(pairFoo().interval).toBe(35);
  });

  it("candidate 测试失败 → 降级 learning（间隔重置、fail_count+1）", () => {
    toCandidate();
    const sid = startSession(db, userA, 1);
    recordWord(db, sid, userA, widFoo, sid1, "test_fail");
    const p = pairFoo();
    expect(p.status).toBe("learning");
    expect(p.interval).toBe(1);
    expect(p.review_count).toBe(0);
    expect(p.fail_count).toBe(1);
  });

  it("candidate 不入复习队列（到期列表不含）", () => {
    toCandidate();
    expect(getDueReviewSentenceIds(db, userA)).not.toContain(sid1);
    expect(getDueCount(db, userA)).toBe(0);
  });

  it("drawTestSentenceIds：candidate 优先进入测试池", () => {
    toCandidate();
    const sids = drawTestSentenceIds(db, userA, 1, "all");
    expect(sids).toContain(sid1); // candidate 最高优先级
  });

  it("candidate 完成后学习中途失败：mastered 词测试失败降级（既有行为保持）", () => {
    toCandidate();
    const sid = startSession(db, userA, 1);
    recordWord(db, sid, userA, widFoo, sid1, "mastered"); // → mastered
    recordWord(db, sid, userA, widFoo, sid1, "test_fail"); // 再失败 → 降级
    const p = pairFoo();
    expect(p.status).toBe("learning");
    expect(p.interval).toBe(1);
  });
});

describe("T045 掌握特效数据：completeSentence 返回新掌握词 + masteryCount", () => {
  beforeEach(() => {
    db.exec("DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM user_vocab; DELETE FROM word_status; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;");
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar baz.", "T045。").lastInsertRowid as number;
    widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    widBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widFoo, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widBar, 1, 0);
    addVocab(db, userA, widFoo, sid1);
    addVocab(db, userA, widBar, sid1);
  });

  const toCandidate = (wid: number) => {
    for (let i = 0; i < MASTERY_THRESHOLD; i++) {
      db.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(daysAgo(1), userA, wid, sid1);
      const sid = startSession(db, userA, 1);
      recordWord(db, sid, userA, wid, sid1, "mastered");
    }
  };

  it("candidate 词测试通过 → completeSentence 返回该词为新掌握", () => {
    toCandidate(widFoo); // foo → candidate
    const sid = startSession(db, userA, 1);
    const mastered = completeSentence(db, sid, userA, sid1, [{ wordId: widFoo, result: "mastered" }]);
    expect(mastered).toContain(widFoo);
    // bar 仍是 learning（未达候选）→ 不返回
    const mastered2 = completeSentence(db, sid, userA, sid1, [{ wordId: widBar, result: "mastered" }]);
    expect(mastered2).not.toContain(widBar);
  });

  it("普通 learning 词推进不返回新掌握", () => {
    const sid = startSession(db, userA, 1);
    const mastered = completeSentence(db, sid, userA, sid1, [{ wordId: widBar, result: "mastered" }]);
    expect(mastered).toEqual([]);
  });
});



describe("T047b 句子级别派生（computeSentenceLevel）", () => {
  beforeEach(() => {
    db.exec("DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM user_vocab; DELETE FROM word_status; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;");
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("alpha beta.", "T047b。").lastInsertRowid as number;
    const widA = db.prepare("INSERT INTO words (word, level) VALUES (?, ?)").run("alpha", 2).lastInsertRowid as number;
    const widB = db.prepare("INSERT INTO words (word, level) VALUES (?, ?)").run("beta", 4).lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widA, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widB, 1, 0);
  });

  it("句中 2 级 + 4 级词 → 句子 level=4（取最高）", () => {
    expect(computeSentenceLevel(db, sid1)).toBe(4);
  });

  it("无词句（无 sentence_words）→ null", () => {
    const sid2 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("1. 2.", "T047b2。").lastInsertRowid as number;
    expect(computeSentenceLevel(db, sid2)).toBeNull();
  });

  it("recomputeAllSentenceLevels 全量重算并落库", () => {
    const n = recomputeAllSentenceLevels(db);
    expect(n).toBe(1);
    const lv = db.prepare("SELECT level FROM sentences WHERE id=?").get(sid1) as { level: number | null };
    expect(lv.level).toBe(4);
  });
});
