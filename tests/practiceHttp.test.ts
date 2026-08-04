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
import { resetSessionStore } from "../src/practiceSession.js";

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
});
