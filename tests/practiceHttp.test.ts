import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { configureSession } from "../src/sessionStore.js";
import { authRouter } from "../src/routes/auth.js";
import { practiceRouter } from "../src/routes/practice.js";
import { hashPassword } from "../src/auth.js";
import { resetSessionStore, createSession, getSession } from "../src/practiceSession.js";
import { addVocab } from "../src/vocab.js";

const TEST_DB = path.join(os.tmpdir(), "word_typer_test_t010.db");
let db: DatabaseSync;
let app: express.Express;
let agent: request.Agent;
let sid1: number;
let widFoo: number;
let widBar: number;

function freshDb(): DatabaseSync {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const d = new DatabaseSync(TEST_DB);
  d.exec("PRAGMA foreign_keys=ON");
  d.exec(SCHEMA_SQL);
  return d;
}

describe("T010 practice HTTP API", () => {
  beforeAll(async () => {
    resetSessionStore();
    db = freshDb();
    // 用户
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(
      "alice",
      hashPassword("a123456")
    );
    // 一个句子 "foo bar."，tokens: foo / bar
    sid1 = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "foo 和 bar。").lastInsertRowid as number;
    widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    widBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widFoo, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid1, widBar, 1, 0);

    app = express();
    app.use(express.json());
    app.use(configureSession());
    app.use("/api/auth", authRouter(db));
    app.use("/api/practice", practiceRouter(db));

    // 登录
    agent = request.agent(app);
    const r = await agent.post("/api/auth/login").send({ username: "alice", password: "a123456" });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });
  beforeEach(() => {
    resetSessionStore();
  });

  it("未登录访问 → 401", async () => {
    const anon = request.agent(app);
    const res = await anon.post("/api/practice/start").send({ targetCount: 1 });
    expect(res.status).toBe(401);
  });

  it("start 返回第一句（zh + tokens），建会话", async () => {
    const res = await agent.post("/api/practice/start").send({ targetCount: 1 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.current.zh).toBe("foo 和 bar。");
    expect(res.body.current.tokens.length).toBe(2);
    expect(res.body.current.tokens[0].word).toBe("foo");
  });

  it("start 参数校验：targetCount 非法 → 400", async () => {
    const r1 = await agent.post("/api/practice/start").send({ targetCount: 0 });
    expect(r1.status).toBe(400);
    const r2 = await agent.post("/api/practice/start").send({ targetCount: 999 });
    expect(r2.status).toBe(400);
  });

  it("check 提交字符：正确推进，错误不前进", async () => {
    await agent.post("/api/practice/start").send({ targetCount: 1 });
    // 第一个词 foo，逐字符
    const r1 = await agent.post("/api/practice/check").send({ char: "f" });
    expect(r1.status).toBe(200);
    expect(r1.body.correct).toBe(true);
    expect(r1.body.wordDone).toBe(false);
    // 大小写错误
    const r2 = await agent.post("/api/practice/check").send({ char: "O" });
    expect(r2.body.correct).toBe(false);
    // 正确的 o, o → wordDone
    await agent.post("/api/practice/check").send({ char: "o" });
    const r3 = await agent.post("/api/practice/check").send({ char: "o" });
    expect(r3.body.wordDone).toBe(true);
  });

  it("整句完成：complete 后 sentenceDone 推进，落库 test_records + word_status", async () => {
    const start = await agent.post("/api/practice/start").send({ targetCount: 1 });
    expect(start.status).toBe(200);
    // 上报整句结果
    const res = await agent.post("/api/practice/complete").send({
      wordResults: [
        { wordId: widFoo, result: "mastered" },
        { wordId: widBar, result: "mastered" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(true); // 会话结束（仅 1 句）
    expect(res.body.next).toBeUndefined();
    // 落库验证
    const tr = db.prepare("SELECT COUNT(*) AS c FROM test_records").get() as { c: number };
    expect(tr.c).toBe(2);
    const ws = db.prepare("SELECT COUNT(*) AS c FROM word_status").get() as { c: number };
    expect(ws.c).toBe(2);
  });

  it("hint 提示词：入生词本 + 返回词，停留在当前词（需再输入一次）", async () => {
    await agent.post("/api/practice/start").send({ targetCount: 1 });
    const res = await agent.post("/api/practice/hint").send({});
    expect(res.status).toBe(200);
    expect(res.body.word).toBe("foo");
    // 入生词本验证
    const uv = db.prepare("SELECT COUNT(*) AS c FROM user_vocab").get() as { c: number };
    expect(uv.c).toBe(1);
    // 仍在当前词：照敲 foo 首字符应 correct
    const r = await agent.post("/api/practice/check").send({ char: "f" });
    expect(r.body.correct).toBe(true);
  });

  it("hint 后照敲该词，再敲后续词完成整句", async () => {
    await agent.post("/api/practice/start").send({ targetCount: 1 });
    // hint foo（第 0 词）
    const h = await agent.post("/api/practice/hint").send({});
    expect(h.body.word).toBe("foo");
    // 照敲 foo
    for (const ch of ["f", "o", "o"]) await agent.post("/api/practice/check").send({ char: ch });
    // 敲 bar → 末词完成
    for (const ch of ["b", "a", "r"]) await agent.post("/api/practice/check").send({ char: ch });
    // complete 时 foo 记为 hint
    await agent.post("/api/practice/complete").send({
      wordResults: [
        { wordId: widFoo, result: "hint" },
        { wordId: widBar, result: "mastered" },
      ],
    });
    // 含 hint 词 → 词句对不移除，foo 保留在生词本
    const uv = db.prepare("SELECT COUNT(*) AS c FROM user_vocab").get() as { c: number };
    expect(uv.c).toBe(1);
  });

  it("backspace：删除当前词最后一个字符，再输入可继续", async () => {
    await agent.post("/api/practice/start").send({ targetCount: 1 });
    // 输入 f, o
    await agent.post("/api/practice/check").send({ char: "f" });
    await agent.post("/api/practice/check").send({ char: "o" });
    // 退格删掉 o
    const bs = await agent.post("/api/practice/backspace").send({});
    expect(bs.status).toBe(200);
    expect(bs.body.typed).toBe("f");
    // 再输入 o → 应正确
    const r = await agent.post("/api/practice/check").send({ char: "o" });
    expect(r.body.correct).toBe(true);
  });

  it("未开始会话调用 backspace → 409", async () => {
    const res = await agent.post("/api/practice/backspace").send({});
    expect(res.status).toBe(409);
  });

  it("整句完成且句中词在生词本 → 词句对推进不删除（T027）", async () => {
    // 先把 foo 放入生词本
    await agent.post("/api/practice/start").send({ targetCount: 1 });
    await agent.post("/api/practice/hint").send({}); // hint 第 0 词 foo
    await agent.post("/api/practice/complete").send({
      wordResults: [
        { wordId: widFoo, result: "mastered" },
        { wordId: widBar, result: "mastered" },
      ],
    });
    // v1.9：整句拼对不再移除词句对；hint 后 next_review=明天 → 当日 complete 属提前复习，T039 下不推进
    const alice = db.prepare("SELECT id FROM users WHERE username = ?").get("alice") as { id: number };
    const v = db.prepare("SELECT review_count, status FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(alice.id, widFoo, sid1) as { review_count: number; status: string };
    expect(v).toBeTruthy();
    expect(v.review_count).toBe(0); // T039：未到期成功不推进
    expect(v.status).toBe("learning");
  });

  it("finish 手动结束：计时落库 + 状态清空", async () => {
    await agent.post("/api/practice/start").send({ targetCount: 1 });
    const res = await agent.post("/api/practice/finish").send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const sess = db.prepare("SELECT COUNT(*) AS c FROM practice_sessions WHERE end_time IS NOT NULL").get() as { c: number };
    expect(sess.c).toBeGreaterThan(0);
  });

  it("未开始会话调用 check → 409", async () => {
    const res = await agent.post("/api/practice/check").send({ char: "x" });
    expect(res.status).toBe(409);
  });

  it("report 报告句子：登录后上报 → 200 + 落库 pending（T017）", async () => {
    const res = await agent.post("/api/practice/report").send({ sentenceId: sid1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const alice = db.prepare("SELECT id FROM users WHERE username = ?").get("alice") as { id: number };
    const row = db.prepare("SELECT * FROM sentence_reports WHERE sentence_id = ?").get(sid1) as { user_id: number; status: string };
    expect(row.user_id).toBe(alice.id);
    expect(row.status).toBe("pending");
  });

  it("report 未登录 → 401", async () => {
    const anon = request.agent(app);
    const res = await anon.post("/api/practice/report").send({ sentenceId: sid1 });
    expect(res.status).toBe(401);
  });

  it("report 句子不存在 → 404", async () => {
    const res = await agent.post("/api/practice/report").send({ sentenceId: 99999 });
    expect(res.status).toBe(404);
  });

  it("report sentenceId 非法 → 400", async () => {
    const r1 = await agent.post("/api/practice/report").send({ sentenceId: "abc" });
    expect(r1.status).toBe(400);
    const r2 = await agent.post("/api/practice/report").send({ sentenceId: 0 });
    expect(r2.status).toBe(400);
    const r3 = await agent.post("/api/practice/report").send({});
    expect(r3.status).toBe(400);
  });

  it("report 带错误描述：description trim 后随报告落库（T020）", async () => {
    const res = await agent
      .post("/api/practice/report")
      .send({ sentenceId: sid1, description: "  一段语音播放了两个句子  " });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT description FROM sentence_reports WHERE id = ?")
      .get(res.body.reportId) as { description: string | null };
    expect(row.description).toBe("一段语音播放了两个句子");
  });

  it("report 不带描述：description 为 NULL（T020）", async () => {
    const res = await agent.post("/api/practice/report").send({ sentenceId: sid1 });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT description FROM sentence_reports WHERE id = ?")
      .get(res.body.reportId) as { description: string | null };
    expect(row.description).toBeNull();
  });
});

describe("T014 复习模式：跳过非生词（T016 收尾）", () => {
  // T010 的 afterAll 已关闭共用 db，这里独立建库 + 独立 app/登录态
  const TEST_DB2 = path.join(os.tmpdir(), "word_typer_test_t016.db");
  let db2: DatabaseSync;
  let app2: express.Express;
  let agent2: request.Agent;
  let s2: number; // alpha beta gamma.（beta 生词）
  let s3: number; // alpha Tom beta.（Tom 人名，beta 生词）

  beforeAll(async () => {
    db2 = freshDb();
    db2.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("alice", hashPassword("a123456"));
    app2 = express();
    app2.use(express.json());
    app2.use(configureSession());
    app2.use("/api/auth", authRouter(db2));
    app2.use("/api/practice", practiceRouter(db2));
    agent2 = request.agent(app2);
    const r = await agent2.post("/api/auth/login").send({ username: "alice", password: "a123456" });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    db2.close();
    if (fs.existsSync(TEST_DB2)) fs.unlinkSync(TEST_DB2);
  });

  // 重建句子数据（保留用户），供各用例独立使用
  function seedSentences(): void {
    db2.exec(
      "DELETE FROM test_records; DELETE FROM practice_sessions; DELETE FROM user_vocab; DELETE FROM word_status; DELETE FROM sentence_words; DELETE FROM sentences; DELETE FROM words;"
    );
    const widAlpha = db2.prepare("INSERT INTO words (word) VALUES (?)").run("alpha").lastInsertRowid as number;
    const widBeta = db2.prepare("INSERT INTO words (word) VALUES (?)").run("beta").lastInsertRowid as number;
    const widGamma = db2.prepare("INSERT INTO words (word) VALUES (?)").run("gamma").lastInsertRowid as number;
    const widTom = db2.prepare("INSERT INTO words (word, is_name) VALUES (?, 1)").run("Tom").lastInsertRowid as number;
    s2 = db2.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("alpha beta gamma.", "alpha、beta 与 gamma。").lastInsertRowid as number;
    s3 = db2.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("alpha Tom beta.", "alpha、Tom 与 beta。").lastInsertRowid as number;
    // s2: alpha(0) beta(1) gamma(2)
    db2.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s2, widAlpha, 0, 0);
    db2.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s2, widBeta, 1, 0);
    db2.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s2, widGamma, 2, 0);
    // s3: alpha(0) Tom(1) beta(2)
    db2.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s3, widAlpha, 0, 0);
    db2.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s3, widTom, 1, 0);
    db2.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s3, widBeta, 2, 0);
  }

  // 取 alice 的 userId 与 beta 的 wordId，并把 beta 加入生词本
  function addBetaToVocab(sentenceId: number): void {
    const alice = db2.prepare("SELECT id FROM users WHERE username = ?").get("alice") as { id: number };
    const widBeta = db2.prepare("SELECT id FROM words WHERE word = ?").get("beta") as { id: number };
    addVocab(db2, alice.id, widBeta.id, sentenceId);
  }

  beforeEach(() => {
    resetSessionStore();
    seedSentences();
  });

  it("createSession：mode 默认 practice，传 review 时记录 mode", () => {
    const alice = db2.prepare("SELECT id FROM users WHERE username = ?").get("alice") as { id: number };
    const s = createSession(db2, alice.id, 1);
    expect(getSession(alice.id)!.mode).toBe("practice");
    resetSessionStore();
    const r = createSession(db2, alice.id, 1, { mode: "review" });
    expect(getSession(alice.id)!.mode).toBe("review");
    expect(r.mode).toBe("review");
    resetSessionStore();
  });

  it("复习模式 start：wordIdx 指向第一个生词（跳过前面非生词）", async () => {
    addBetaToVocab(s2);
    const res = await agent2.post("/api/practice/start").send({ targetCount: 1, mode: "review" });
    expect(res.status).toBe(200);
    expect(res.body.current.sentenceId).toBe(s2);
    expect(res.body.current.wordIdx).toBe(1); // beta（跳过 alpha）
  });

  it("复习模式连续输入：生词完成自动跳下一个生词，尾部非生词跳过 → sentenceDone", async () => {
    addBetaToVocab(s2);
    await agent2.post("/api/practice/start").send({ targetCount: 1, mode: "review" });
    let last: any;
    for (const ch of ["b", "e", "t", "a"]) {
      last = await agent2.post("/api/practice/check").send({ char: ch });
      expect(last.body.correct).toBe(true);
    }
    // beta 完成后 gamma（非生词）被跳过 → 整句完成
    expect(last.body.wordDone).toBe(true);
    expect(last.body.sentenceDone).toBe(true);
  });

  it("复习模式 + 人名边界：wordIdx 不停留在人名上（跳过 alpha 与 Tom）", async () => {
    addBetaToVocab(s3);
    const res = await agent2.post("/api/practice/start").send({ targetCount: 1, mode: "review" });
    expect(res.status).toBe(200);
    expect(res.body.current.sentenceId).toBe(s3);
    expect(res.body.current.wordIdx).toBe(2); // beta（跳过 alpha 与 Tom）
  });

  it("练习模式：不跳过非生词，wordIdx 从 0 开始", async () => {
    const res = await agent2.post("/api/practice/start").send({ targetCount: 1, mode: "practice" });
    expect(res.status).toBe(200);
    expect(res.body.current.wordIdx).toBe(0); // alpha 不跳过
    expect(res.body.current.tokens[0].word).toBe("alpha");
  });
});

describe("T028 测试模式 HTTP（禁提示 + 判定）", () => {
  const TEST_DB3 = path.join(os.tmpdir(), "word_typer_test_t028.db");
  let db3: DatabaseSync;
  let app3: express.Express;
  let agent3: request.Agent;
  let tSid: number;
  let tWidFoo: number;
  let tWidBar: number;

  beforeAll(async () => {
    db3 = freshDb();
    db3.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("carol", hashPassword("c123456"));
    // 句子 "foo bar." + 词句对：foo 临近掌握、bar 高错
    tSid = db3.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "foo 和 bar。").lastInsertRowid as number;
    tWidFoo = db3.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    tWidBar = db3.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    db3.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(tSid, tWidFoo, 0, 0);
    db3.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(tSid, tWidBar, 1, 0);
    const uid = db3.prepare("SELECT id FROM users WHERE username='carol'").get() as { id: number };
    db3.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status, fail_count) VALUES (?,?,?,?,16,3,?, 'learning', 0)").run(uid.id, tWidFoo, tSid, "2026-08-06", "2026-08-07");
    db3.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status, fail_count) VALUES (?,?,?,?,1,0,?, 'learning', 2)").run(uid.id, tWidBar, tSid, "2026-08-06", "2026-08-07");

    app3 = express();
    app3.use(express.json());
    app3.use(configureSession());
    app3.use("/api/auth", authRouter(db3));
    app3.use("/api/practice", practiceRouter(db3));
    agent3 = request.agent(app3);
    const r = await agent3.post("/api/auth/login").send({ username: "carol", password: "c123456" });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    db3.close();
    if (fs.existsSync(TEST_DB3)) fs.unlinkSync(TEST_DB3);
  });
  beforeEach(() => {
    resetSessionStore();
  });

  it("start mode=test：从测试内容池抽句", async () => {
    const res = await agent3.post("/api/practice/start").send({ targetCount: 1, mode: "test" });
    expect(res.status).toBe(200);
    expect(res.body.current.sentenceId).toBe(tSid);
  });

  it("测试模式 hint → 403", async () => {
    await agent3.post("/api/practice/start").send({ targetCount: 1, mode: "test" });
    const h = await agent3.post("/api/practice/hint").send({});
    expect(h.status).toBe(403);
  });

  it("测试模式 complete：mastered 推进、test_fail 降级（fail_count+1）", async () => {
    await agent3.post("/api/practice/start").send({ targetCount: 1, mode: "test" });
    await agent3.post("/api/practice/complete").send({
      wordResults: [
        { wordId: tWidFoo, result: "mastered" }, // 推进：3→4
        { wordId: tWidBar, result: "test_fail" }, // 降级
      ],
    });
    const uid = db3.prepare("SELECT id FROM users WHERE username='carol'").get() as { id: number };
    const foo = db3.prepare("SELECT review_count FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(uid.id, tWidFoo, tSid) as { review_count: number };
    const bar = db3.prepare("SELECT status, review_count, fail_count FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(uid.id, tWidBar, tSid) as { status: string; review_count: number; fail_count: number };
    expect(foo.review_count).toBe(4);
    expect(bar.status).toBe("learning");
    expect(bar.review_count).toBe(0);
    expect(bar.fail_count).toBe(3);
  });
});

describe("T029 到期横幅与偏好（due-count + preferences）", () => {
  const TEST_DB4 = path.join(os.tmpdir(), "word_typer_test_t029.db");
  let db4: DatabaseSync;
  let app4: express.Express;
  let agent4: request.Agent;

  beforeAll(async () => {
    db4 = freshDb();
    db4.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("dave", hashPassword("d123456"));
    app4 = express();
    app4.use(express.json());
    app4.use(configureSession());
    app4.use("/api/auth", authRouter(db4));
    app4.use("/api/practice", practiceRouter(db4));
    agent4 = request.agent(app4);
    const r = await agent4.post("/api/auth/login").send({ username: "dave", password: "d123456" });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    db4.close();
    if (fs.existsSync(TEST_DB4)) fs.unlinkSync(TEST_DB4);
  });
  beforeEach(() => {
    resetSessionStore();
  });

  it("due-count：无生词本时为 0", async () => {
    const res = await agent4.get("/api/practice/due-count");
    expect(res.status).toBe(200);
    expect(res.body.due).toBe(0);
  });

  it("due-count：有到期词句对时返回数量", async () => {
    const uid = db4.prepare("SELECT id FROM users WHERE username='dave'").get() as { id: number };
    const sid = db4.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "foo bar。").lastInsertRowid as number;
    const wid = db4.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    db4.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid, wid, 0, 0);
    // 到期词句对（昨天到期）
    db4.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status, fail_count) VALUES (?,?,?,?,1,0,?,'learning',0)")
      .run(uid.id, wid, sid, "2026-08-06", new Date(Date.now() - 86400000).toISOString().slice(0, 10));
    const res = await agent4.get("/api/practice/due-count");
    expect(res.body.due).toBe(1);
  });

  it("preferences：更新后 me 返回合并结果", async () => {
    const r1 = await agent4.post("/api/auth/preferences").send({ login_force_review: true });
    expect(r1.status).toBe(200);
    const me = await agent4.get("/api/auth/me");
    expect(me.body.preferences).toEqual({ login_force_review: true });
  });
});

describe("T031 单词状态聚合（vocab-state + due-words）", () => {
  const TEST_DB5 = path.join(os.tmpdir(), "word_typer_test_t031.db");
  let db5: DatabaseSync;
  let app5: express.Express;
  let agent5: request.Agent;
  let u5: { id: number };
  let w5foo: number;
  let w5bar: number;
  let s5a: number;
  let s5b: number;

  beforeAll(async () => {
    db5 = freshDb();
    db5.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("erin", hashPassword("e123456"));
    u5 = db5.prepare("SELECT id FROM users WHERE username='erin'").get() as { id: number };
    w5foo = db5.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    w5bar = db5.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    s5a = db5.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo a.", "foo a。").lastInsertRowid as number;
    s5b = db5.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("bar b.", "bar b。").lastInsertRowid as number;
    db5.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s5a, w5foo, 0, 0);
    db5.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s5b, w5bar, 0, 0);
    // foo：两个词句对（interval 3 / 16）→ 聚合取 16；bar：mastered
    db5.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status, fail_count) VALUES (?,?,?,?,3,2,?,'learning',0)").run(u5.id, w5foo, s5a, "2026-08-06", "2026-08-07");
    db5.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status, fail_count) VALUES (?,?,?,?,16,4,?,'learning',0)").run(u5.id, w5foo, s5b, "2026-08-06", "2026-08-07");
    db5.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status, fail_count) VALUES (?,?,?,?,35,5,?,'mastered',0)").run(u5.id, w5bar, s5a, "2026-08-06", "2026-08-07");

    app5 = express();
    app5.use(express.json());
    app5.use(configureSession());
    app5.use("/api/auth", authRouter(db5));
    app5.use("/api/practice", practiceRouter(db5));
    agent5 = request.agent(app5);
    const r = await agent5.post("/api/auth/login").send({ username: "erin", password: "e123456" });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    db5.close();
    if (fs.existsSync(TEST_DB5)) fs.unlinkSync(TEST_DB5);
  });
  beforeEach(() => {
    resetSessionStore();
  });

  it("vocab-state：同词多词句对 interval 取最大、mastered 优先", async () => {
    const res = await agent5.post("/api/practice/vocab-state").send({ wordIds: [w5foo, w5bar] });
    expect(res.status).toBe(200);
    const words = res.body.words as { wordId: number; word: string; interval: number; status: string }[];
    const foo = words.find((x) => x.wordId === w5foo)!;
    const bar = words.find((x) => x.wordId === w5bar)!;
    expect(foo.interval).toBe(16);
    expect(foo.status).toBe("learning");
    expect(bar.interval).toBe(35);
    expect(bar.status).toBe("mastered");
  });

  it("vocab-state：空数组返回空", async () => {
    const res = await agent5.post("/api/practice/vocab-state").send({ wordIds: [] });
    expect(res.body.words).toEqual([]);
  });

  it("vocab-state：非法参数 400", async () => {
    const res = await agent5.post("/api/practice/vocab-state").send({ wordIds: "x" });
    expect(res.status).toBe(400);
  });

  it("due-words：到期词按词聚合返回", async () => {
    // 把 foo 的一个词句对改为昨日到期
    db5.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?").run(new Date(Date.now() - 86400000).toISOString().slice(0, 10), u5.id, w5foo, s5b);
    const res = await agent5.get("/api/practice/due-words");
    expect(res.status).toBe(200);
    const words = res.body.words as { wordId: number; word: string }[];
    expect(words.map((x) => x.wordId)).toContain(w5foo);
    expect(words.map((x) => x.wordId)).not.toContain(w5bar); // mastered 不计
  });

  it("due-words：无到期词返回空数组", async () => {
    db5.prepare("UPDATE user_vocab SET next_review=? WHERE user_id=?").run("2099-01-01", u5.id);
    const res = await agent5.get("/api/practice/due-words");
    expect(res.body.words).toEqual([]);
  });
});

describe("T032 复习/测试模式中段无法输入（complete 跳词不完整, B0004）", () => {
  const TEST_DB6 = path.join(os.tmpdir(), "word_typer_test_t032.db");
  let db6: DatabaseSync;
  let app6: express.Express;
  let agent6: request.Agent;
  let u6: { id: number };
  // 句子 A: She(人名/生词) school(非生词) library(生词)
  // 句子 B: He(人名/生词) class(非生词) pencil(生词)
  let sA: number;
  let sB: number;
  let wLibrary: number;
  let wPencil: number;

  beforeAll(async () => {
    db6 = freshDb();
    db6.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("frank", hashPassword("f123456"));
    u6 = db6.prepare("SELECT id FROM users WHERE username='frank'").get() as { id: number };
    const mk = (en: string, zh: string, words: [string, number, boolean][]) => {
      const sid = db6.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run(en, zh).lastInsertRowid as number;
      for (const [w, pos, name] of words) {
        const wid = db6.prepare("INSERT INTO words (word, is_name) VALUES (?, ?)").run(w, name ? 1 : 0).lastInsertRowid as number;
        db6.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid, wid, pos, 0);
      }
      return sid;
    };
    // 生词（入本）：
    wLibrary = db6.prepare("SELECT id FROM words WHERE word='library'").get() as { id: number } | undefined ? (db6.prepare("SELECT id FROM words WHERE word='library'").get() as { id: number }).id : 0;
    wPencil = db6.prepare("SELECT id FROM words WHERE word='pencil'").get() as { id: number } | undefined ? (db6.prepare("SELECT id FROM words WHERE word='pencil'").get() as { id: number }).id : 0;
    sA = mk("She school library.", "A 句。", [["She", 0, true], ["school", 1, false], ["library", 2, false]]);
    sB = mk("He class pencil.", "B 句。", [["He", 0, true], ["class", 1, false], ["pencil", 2, false]]);
    // 词句对（人名+生词都入本，昨天到期 → 复习池）
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const addVocab6 = (wid: number, sid: number) => {
      db6.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status, fail_count) VALUES (?,?,?,?,1,0,?,'learning',0)")
        .run(u6.id, wid, sid, "2026-08-06", yesterday);
    };
    for (const [wid, sid] of [
      [db6.prepare("SELECT id FROM words WHERE word='She'").get() as { id: number }, sA],
      [db6.prepare("SELECT id FROM words WHERE word='library'").get() as { id: number }, sA],
      [db6.prepare("SELECT id FROM words WHERE word='He'").get() as { id: number }, sB],
      [db6.prepare("SELECT id FROM words WHERE word='pencil'").get() as { id: number }, sB],
    ]) addVocab6(wid.id, sid);

    app6 = express();
    app6.use(express.json());
    app6.use(configureSession());
    app6.use("/api/auth", authRouter(db6));
    app6.use("/api/practice", practiceRouter(db6));
    agent6 = request.agent(app6);
    const r = await agent6.post("/api/auth/login").send({ username: "frank", password: "f123456" });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    db6.close();
    if (fs.existsSync(TEST_DB6)) fs.unlinkSync(TEST_DB6);
  });
  beforeEach(() => {
    resetSessionStore();
  });

  it("复习模式 start：current.wordIdx 指向第一个生词（跳过句首人名+非生词）", async () => {
    const res = await agent6.post("/api/practice/start").send({ targetCount: 1, mode: "review" });
    expect(res.status).toBe(200);
    expect(res.body.current.wordIdx).toBe(2); // library
  });

  it("复习模式 complete 后：next.wordIdx 指向下一句第一个生词（B0004 修复点）", async () => {
    const st = await agent6.post("/api/practice/start").send({ targetCount: 2, mode: "review" });
    // 用当前句的生词动态构造 wordResults
    const cur = st.body.current;
    const results = cur.tokens
      .filter((t: { in_vocab: boolean; is_name: number }) => t.in_vocab && t.is_name !== 1)
      .map((t: { word_id: number }) => ({ wordId: t.word_id, result: "mastered" }));
    const comp = await agent6.post("/api/practice/complete").send({ wordResults: results });
    expect(comp.status).toBe(200);
    expect(comp.body.done).toBe(false);
    const next = comp.body.next;
    expect(next.sentenceId).toBe(sB === st.body.current.sentenceId ? sA : sB); // 另一句
    expect(next.wordIdx).toBe(next.tokens.findIndex((t: { in_vocab: boolean; is_name: number }) => t.in_vocab && t.is_name !== 1)); // 第一个生词（修复前=1）
  });

  it("复习模式 complete 后输入流：check 生词首字符 → correct（修复前永远 false）", async () => {
    const st = await agent6.post("/api/practice/start").send({ targetCount: 2, mode: "review" });
    const results = st.body.current.tokens
      .filter((t: { in_vocab: boolean; is_name: number }) => t.in_vocab && t.is_name !== 1)
      .map((t: { word_id: number }) => ({ wordId: t.word_id, result: "mastered" }));
    const comp = await agent6.post("/api/practice/complete").send({ wordResults: results });
    const next = comp.body.next;
    const firstWord = next.tokens.find((t: { in_vocab: boolean; is_name: number }) => t.in_vocab && t.is_name !== 1).word as string;
    const chk = await agent6.post("/api/practice/check").send({ char: firstWord[0] });
    expect(chk.body.correct).toBe(true);
    const chk2 = await agent6.post("/api/practice/check").send({ char: firstWord[1] });
    expect(chk2.body.correct).toBe(true);
  });

  it("测试模式 complete 后：next.wordIdx 同样跳过人名/非生词（连带修复）", async () => {
    const st = await agent6.post("/api/practice/start").send({ targetCount: 2, mode: "test" });
    const cur = st.body.current;
    const results = cur.tokens
      .filter((t: { in_vocab: boolean; is_name: number }) => t.in_vocab && t.is_name !== 1)
      .map((t: { word_id: number }) => ({ wordId: t.word_id, result: "mastered" }));
    const comp = await agent6.post("/api/practice/complete").send({ wordResults: results });
    expect(comp.status).toBe(200);
    const next = comp.body.next;
    expect(next.wordIdx).toBe(next.tokens.findIndex((t: { in_vocab: boolean; is_name: number }) => t.in_vocab && t.is_name !== 1));
  });
});

describe("T032 边界：空生词本复习/测试会话（不再 500）", () => {
  const TEST_DB7 = path.join(os.tmpdir(), "word_typer_test_t032b.db");
  let db7: DatabaseSync;
  let app7: express.Express;
  let agent7: request.Agent;

  beforeAll(async () => {
    db7 = freshDb();
    db7.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("gina", hashPassword("g123456"));
    app7 = express();
    app7.use(express.json());
    app7.use(configureSession());
    app7.use("/api/auth", authRouter(db7));
    app7.use("/api/practice", practiceRouter(db7));
    agent7 = request.agent(app7);
    const r = await agent7.post("/api/auth/login").send({ username: "gina", password: "g123456" });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    db7.close();
    if (fs.existsSync(TEST_DB7)) fs.unlinkSync(TEST_DB7);
  });
  beforeEach(() => {
    resetSessionStore();
  });

  it("复习模式：无词句对时返回 400 友好错误（不 500）", async () => {
    const res = await agent7.post("/api/practice/start").send({ targetCount: 5, mode: "review" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("生词本");
  });

  it("测试模式：无词句对时返回 400 友好错误（不 500）", async () => {
    const res = await agent7.post("/api/practice/start").send({ targetCount: 5, mode: "test" });
    expect(res.status).toBe(400);
  });
});

describe("T033 start total 返回实际抽取数（非请求值）", () => {
  const TEST_DB8 = path.join(os.tmpdir(), "word_typer_test_t033.db");
  let db8: DatabaseSync;
  let app8: express.Express;
  let agent8: request.Agent;

  beforeAll(async () => {
    db8 = freshDb();
    db8.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("henry", hashPassword("h123456"));
    const uid = db8.prepare("SELECT id FROM users WHERE username='henry'").get() as { id: number };
    // 造 2 个复习句（各 1 个生词词句对，昨天到期）
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    for (const [en, w] of [["foo bar.", "foo"], ["baz qux.", "baz"]] as const) {
      const sid = db8.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run(en, en).lastInsertRowid as number;
      const wid = db8.prepare("INSERT INTO words (word) VALUES (?)").run(w).lastInsertRowid as number;
      db8.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid, wid, 0, 0);
      db8.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status, fail_count) VALUES (?,?,?,?,1,0,?,'learning',0)")
        .run(uid.id, wid, sid, "2026-08-06", yesterday);
    }
    app8 = express();
    app8.use(express.json());
    app8.use(configureSession());
    app8.use("/api/auth", authRouter(db8));
    app8.use("/api/practice", practiceRouter(db8));
    agent8 = request.agent(app8);
    const r = await agent8.post("/api/auth/login").send({ username: "henry", password: "h123456" });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    db8.close();
    if (fs.existsSync(TEST_DB8)) fs.unlinkSync(TEST_DB8);
  });
  beforeEach(() => {
    resetSessionStore();
  });

  it("复习池仅 2 句：targetCount=10 时 total 返回 2", async () => {
    const res = await agent8.post("/api/practice/start").send({ targetCount: 10, mode: "review" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2); // 修复前为 10
  });
});

describe("T035 点击单词加入生词本（add-vocab）", () => {
  const TEST_DB9 = path.join(os.tmpdir(), "word_typer_test_t035.db");
  let db9: DatabaseSync;
  let app9: express.Express;
  let agent9: request.Agent;
  let s9: number;
  let wFoo9: number;
  let wBar9: number;

  beforeAll(async () => {
    db9 = freshDb();
    db9.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("iris", hashPassword("i123456"));
    const uid = db9.prepare("SELECT id FROM users WHERE username='iris'").get() as { id: number };
    s9 = db9.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "foo bar。").lastInsertRowid as number;
    wFoo9 = db9.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    wBar9 = db9.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    db9.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s9, wFoo9, 0, 0);
    db9.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s9, wBar9, 1, 0);
    app9 = express();
    app9.use(express.json());
    app9.use(configureSession());
    app9.use("/api/auth", authRouter(db9));
    app9.use("/api/practice", practiceRouter(db9));
    agent9 = request.agent(app9);
    const r = await agent9.post("/api/auth/login").send({ username: "iris", password: "i123456" });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    db9.close();
    if (fs.existsSync(TEST_DB9)) fs.unlinkSync(TEST_DB9);
  });
  beforeEach(() => {
    resetSessionStore();
  });

  it("add-vocab：会话中将词加入生词本（词句对落库）", async () => {
    await agent9.post("/api/practice/start").send({ targetCount: 1, mode: "practice" });
    const res = await agent9.post("/api/practice/add-vocab").send({ wordId: wBar9 });
    expect(res.status).toBe(200);
    const uid = db9.prepare("SELECT id FROM users WHERE username='iris'").get() as { id: number };
    const row = db9.prepare("SELECT * FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(uid.id, wBar9, s9);
    expect(row).toBeTruthy();
  });

  it("add-vocab：无进行中会话 → 409", async () => {
    const res = await agent9.post("/api/practice/add-vocab").send({ wordId: wFoo9 });
    expect(res.status).toBe(409);
  });

  it("add-vocab：wordId 非法 → 400", async () => {
    await agent9.post("/api/practice/start").send({ targetCount: 1, mode: "practice" });
    const res = await agent9.post("/api/practice/add-vocab").send({ wordId: "x" });
    expect(res.status).toBe(400);
  });
});
