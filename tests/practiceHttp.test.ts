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

  it("整句完成且句中词在生词本 → 该句词句对移除", async () => {
    // 先把 bar 放入生词本
    await agent.post("/api/practice/start").send({ targetCount: 1 });
    await agent.post("/api/practice/hint").send({}); // hint 第 0 词 foo
    await agent.post("/api/practice/complete").send({
      wordResults: [
        { wordId: widFoo, result: "mastered" },
        { wordId: widBar, result: "mastered" },
      ],
    });
    // foo 的 hint 已入生词本，整句拼对后应移除
    const uv = db.prepare("SELECT COUNT(*) AS c FROM user_vocab").get() as { c: number };
    expect(uv.c).toBe(0);
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
