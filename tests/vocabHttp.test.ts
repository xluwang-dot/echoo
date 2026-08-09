import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { configureSession } from "../src/sessionStore.js";
import { authRouter } from "../src/routes/auth.js";
import { vocabRouter } from "../src/routes/vocab.js";
import { hashPassword } from "../src/auth.js";

const TEST_DB = path.join(os.tmpdir(), "word_typer_test_vocab_http.db");
let db: DatabaseSync;
let app: express.Express;
let agent: request.Agent;

function freshDb(): DatabaseSync {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const d = new DatabaseSync(TEST_DB);
  d.exec("PRAGMA foreign_keys=ON");
  d.exec(SCHEMA_SQL);
  return d;
}

describe("T013 vocab HTTP API", () => {
  beforeAll(async () => {
    db = freshDb();
    // 用户
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(
      "alice", hashPassword("a123456")
    );
    // 句子 + 词
    const sid = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "foo。").lastInsertRowid as number;
    const widFoo = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    const widBar = db.prepare("INSERT INTO words (word) VALUES (?)").run("bar").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid, widFoo, 0, 0);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(sid, widBar, 1, 0);
    // 已掌握词
    db.prepare("INSERT INTO word_status (user_id, word_id, status) VALUES (1, ?, 'mastered')").run(widFoo);

    app = express();
    app.use(express.json());
    app.use(configureSession());
    app.use("/api/auth", authRouter(db));
    app.use("/api/vocab", vocabRouter(db));

    agent = request.agent(app);
    const r = await agent.post("/api/auth/login").send({ username: "alice", password: "a123456" });
    expect(r.status).toBe(200);
  });

  afterAll(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("未登录 → 401", async () => {
    const anon = request.agent(app);
    const r = await anon.get("/api/vocab");
    expect(r.status).toBe(401);
  });

  it("GET /api/vocab — 空生词本返回空列表", async () => {
    const r = await agent.get("/api/vocab");
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(0);
    expect(r.body.vocab).toEqual([]);
  });

  it("GET /api/vocab/stats — 统计数据正确", async () => {
    const r = await agent.get("/api/vocab/stats");
    expect(r.status).toBe(200);
    expect(r.body.vocabCount).toBe(0);
    expect(r.body.masteredCount).toBe(1);
    expect(r.body.sentenceCount).toBe(0);
  });

  it("通过练习 hint 添加生词后可查到", async () => {
    // 手动插入生词（模拟 hint 效果）
    db.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at) VALUES (?, ?, ?, ?)").run(1, 2, 1, new Date().toISOString());
    const r = await agent.get("/api/vocab");
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
    expect(r.body.vocab[0].word).toBe("bar");
    expect(r.body.vocab[0].en).toBe("foo bar.");
  });

  it("GET /api/vocab/stats — 有生词后统计更新", async () => {
    const r = await agent.get("/api/vocab/stats");
    expect(r.body.vocabCount).toBe(1);
    expect(r.body.sentenceCount).toBe(1);
  });

  it("DELETE /api/vocab/:wordId/:sentenceId — 删除词句对", async () => {
    const r = await agent.delete("/api/vocab/2/1");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const check = await agent.get("/api/vocab");
    expect(check.body.count).toBe(0);
  });

  it("DELETE 参数无效 → 400", async () => {
    const r = await agent.delete("/api/vocab/abc/def");
    expect(r.status).toBe(400);
  });
});

describe("T046 已掌握词墙（GET /api/vocab/mastered）", () => {
  const TEST_DB11 = path.join(os.tmpdir(), "word_typer_test_t046.db");
  let db11: DatabaseSync;
  let app11: express.Express;
  let agent11: request.Agent;

  beforeAll(async () => {
    db11 = freshDb();
    db11.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("kate", hashPassword("k123456"));
    const uid = db11.prepare("SELECT id FROM users WHERE username='kate'").get() as { id: number };
    // 一个 mastered 词句对 + 一个 learning 词句对
    const s1 = db11.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "T046a。").lastInsertRowid as number;
    const s2 = db11.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("baz qux.", "T046b。").lastInsertRowid as number;
    const w1 = db11.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    const w2 = db11.prepare("INSERT INTO words (word) VALUES (?)").run("baz").lastInsertRowid as number;
    db11.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s1, w1, 0, 0);
    db11.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?,?,?,?)").run(s2, w2, 0, 0);
    db11.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status) VALUES (?,?,?,?,35,5,?,'mastered')").run(uid.id, w1, s1, "2026-08-06", "2026-08-07");
    db11.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status) VALUES (?,?,?,?,1,0,?,'learning')").run(uid.id, w2, s2, "2026-08-06", "2026-08-07");
    app11 = express();
    app11.use(express.json());
    app11.use(configureSession());
    app11.use("/api/auth", authRouter(db11));
    app11.use("/api/vocab", vocabRouter(db11));
    agent11 = request.agent(app11);
    const r = await agent11.post("/api/auth/login").send({ username: "kate", password: "k123456" });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    db11.close();
    if (fs.existsSync(TEST_DB11)) fs.unlinkSync(TEST_DB11);
  });

  it("mastered 接口：只返回已掌握词句对", async () => {
    const res = await agent11.get("/api/vocab/mastered");
    expect(res.status).toBe(200);
    expect(res.body.vocab.length).toBe(1);
    expect(res.body.vocab[0].word).toBe("foo");
  });
});
