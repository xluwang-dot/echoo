// T070 单词查询 HTTP 测试：search / lookup / add（指定句子入本）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import path from "path";
import os from "os";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { hashPassword } from "../src/auth.js";
import { configureSession } from "../src/sessionStore.js";
import { authRouter } from "../src/routes/auth.js";
import { vocabRouter } from "../src/routes/vocab.js";

const TEST_DB = path.join(os.tmpdir(), "word_typer_test_t070.db");
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
import fs from "fs";

describe("T070 单词查询", () => {
  beforeAll(async () => {
    db = freshDb();
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("quser", hashPassword("q123456"));
    // 词 + 句子
    const wid = db.prepare("INSERT INTO words (word, meaning, phonetic, level, lesson_no, lesson_pos, audio_path) VALUES ('excuse', '原谅', '/ɪkˈskjuːs/', 1, 1, 1, 'e.mp3')").run().lastInsertRowid as number;
    const wid2 = db.prepare("INSERT INTO words (word, meaning, phonetic, level) VALUES ('excited', '兴奋的', '/ɪkˈsaɪtɪd/', 1)").run().lastInsertRowid as number;
    const sid1 = db.prepare("INSERT INTO sentences (en, zh, level) VALUES ('Excuse me!', '打扰一下！', 1)").run().lastInsertRowid as number;
    const sid2 = db.prepare("INSERT INTO sentences (en, zh, level) VALUES ('Please excuse my friend.', '请原谅我的朋友。', 1)").run().lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?, ?, 0, 0)").run(sid1, wid);
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?, ?, 0, 0)").run(sid2, wid);

    app = express();
    app.use(express.json());
    app.use(configureSession());
    app.use("/api/auth", authRouter(db));
    app.use("/api/vocab", vocabRouter(db));
    agent = request.agent(app);
    const r = await agent.post("/api/auth/login").send({ username: "quser", password: "q123456" });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("search：前缀模糊匹配候选", async () => {
    const r = await agent.get("/api/vocab/search?q=exc");
    expect(r.status).toBe(200);
    const words = r.body.matches.map((m: any) => m.word);
    expect(words).toContain("excuse");
    expect(words).toContain("excited");
  });

  it("search：无匹配返回空", async () => {
    const r = await agent.get("/api/vocab/search?q=zzzzzz");
    expect(r.status).toBe(200);
    expect(r.body.matches).toEqual([]);
  });

  it("lookup：词详情 + 句子列表 + 状态", async () => {
    const r = await agent.get("/api/vocab/lookup?word=excuse");
    expect(r.status).toBe(200);
    expect(r.body.word.word).toBe("excuse");
    expect(r.body.word.meaning).toBe("原谅");
    expect(r.body.sentences.length).toBe(2);
    expect(r.body.sentences[0].en).toContain("Excuse");
    // 未入本状态
    expect(r.body.sentences[0].in_vocab).toBe(false);
    // SM 状态（无记录）
    expect(r.body.sm).toEqual([]);
  });

  it("lookup：听写状态（dictation_done 后 done=true）", async () => {
    const wid = db.prepare("SELECT id FROM words WHERE word='excuse'").get() as { id: number };
    db.prepare("INSERT INTO dictation_done (user_id, word_id, time) VALUES (?, ?, ?)").run(
      (db.prepare("SELECT id FROM users WHERE username='quser'").get() as { id: number }).id,
      wid.id, new Date().toISOString()
    );
    const r = await agent.get("/api/vocab/lookup?word=excuse");
    expect(r.body.dictation.done).toBe(true);
  });

  it("add：指定句子入本 + 不动已有记录", async () => {
    const wid = (db.prepare("SELECT id FROM words WHERE word='excuse'").get() as any).id;
    const sid1 = db.prepare("SELECT id FROM sentences WHERE en='Excuse me!'").get() as { id: number };
    const sid2 = db.prepare("SELECT id FROM sentences WHERE en LIKE 'Please%'").get() as { id: number };
    const uid = (db.prepare("SELECT id FROM users WHERE username='quser'").get() as any).id;
    // 先有一条 SM 记录（sid1，已推进 2 次）
    db.prepare("INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status) VALUES (?, ?, ?, ?, 3, 2, '2026-08-14', 'learning')").run(uid, wid, sid1.id, new Date().toISOString());
    // add 新句（sid2）
    const r = await agent.post("/api/vocab/add").send({ wordId: wid, sentenceId: sid2.id });
    expect(r.status).toBe(200);
    // sid2 新记录（learning 初始）
    const uv2 = db.prepare("SELECT * FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(uid, wid, sid2.id) as any;
    expect(uv2).toBeTruthy();
    expect(uv2.review_count).toBe(0);
    expect(uv2.status).toBe("learning");
    // 已有记录（sid1）保留原有位置
    const uv1 = db.prepare("SELECT * FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").get(uid, wid, sid1.id) as any;
    expect(uv1.review_count).toBe(2);
    expect(uv1.interval).toBe(3);
  });

  it("add：重复添加幂等（已有句对不重复）", async () => {
    const wid = (db.prepare("SELECT id FROM words WHERE word='excuse'").get() as any).id;
    const sid1 = db.prepare("SELECT id FROM sentences WHERE en='Excuse me!'").get() as { id: number };
    await agent.post("/api/vocab/add").send({ wordId: wid, sentenceId: sid1.id });
    const cnt = db.prepare("SELECT COUNT(*) c FROM user_vocab WHERE word_id=? AND sentence_id=?").get(wid, sid1.id) as any;
    expect(cnt.c).toBe(1);
  });
});
