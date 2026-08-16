// T075 管理接口测试：用户管理 / 报告 / 句子更新替换音频 / 邀请码
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { hashPassword } from "../src/auth.js";
import { configureSession } from "../src/sessionStore.js";
import { authRouter } from "../src/routes/auth.js";
import { adminRouter } from "../src/routes/admin.js";

const TEST_DB = path.join(os.tmpdir(), "word_typer_test_t075.db");
let db: DatabaseSync;
let app: express.Express;
let adminAgent: request.Agent;
let userAgent: request.Agent;

function freshDb(): DatabaseSync {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const d = new DatabaseSync(TEST_DB);
  d.exec("PRAGMA foreign_keys=ON");
  d.exec(SCHEMA_SQL);
  return d;
}

describe("T075 管理接口", () => {
  beforeAll(async () => {
    db = freshDb();
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run("root", hashPassword("root12345!"));
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("alice", hashPassword("alice1234!"));
    const sid = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("foo bar.", "foo 和 bar。").lastInsertRowid as number;
    const wid = db.prepare("INSERT INTO words (word) VALUES (?)").run("foo").lastInsertRowid as number;
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?, ?, 0, 0)").run(sid, wid);
    db.prepare("INSERT INTO audio (sentence_id, file_path, duration_ms) VALUES (?, ?, 500)").run(sid, "data/audio/1.wav");
    db.prepare("INSERT INTO sentence_reports (sentence_id, user_id, time, status, description) VALUES (?, ?, ?, 'pending', '翻译有误')").run(
      sid, (db.prepare("SELECT id FROM users WHERE username='alice'").get() as any).id, new Date().toISOString()
    );
    db.prepare("INSERT INTO invite_codes (code, created_at) VALUES ('ADMININV1', ?)").run(new Date().toISOString());

    app = express();
    app.use(express.json());
    app.use(configureSession());
    app.use("/api/auth", authRouter(db));
    app.use("/api/admin", adminRouter(db));
    adminAgent = request.agent(app);
    userAgent = request.agent(app);
    const ar = await adminAgent.post("/api/auth/login").send({ username: "root", password: "root12345!" });
    expect(ar.status).toBe(200);
    const ur = await userAgent.post("/api/auth/login").send({ username: "alice", password: "alice1234!" });
    expect(ur.status).toBe(200);
  });
  afterAll(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("普通用户访问管理接口 → 403", async () => {
    const r = await userAgent.get("/api/admin/users");
    expect(r.status).toBe(403);
  });

  it("报告列表 + 标记 handled", async () => {
    const r = await adminAgent.get("/api/admin/reports");
    expect(r.status).toBe(200);
    expect(r.body.reports.length).toBe(1);
    expect(r.body.reports[0].en).toContain("foo");
    const h = await adminAgent.post(`/api/admin/reports/${r.body.reports[0].id}/handle`);
    expect(h.status).toBe(200);
    const st = db.prepare("SELECT status FROM sentence_reports WHERE id=?").get(r.body.reports[0].id) as any;
    expect(st.status).toBe("handled");
  });

  it("句子更新（en/zh）重建 sentence_words + 报告自动 handled", async () => {
    const sid = (db.prepare("SELECT id FROM sentences WHERE en='foo bar.'").get() as any).id;
    const r = await adminAgent
      .post(`/api/admin/sentences/${sid}/update`)
      .field("en", "baz qux.")
      .field("zh", "baz 和 qux。");
    expect(r.status).toBe(200);
    const s = db.prepare("SELECT en, zh FROM sentences WHERE id=?").get(sid) as any;
    expect(s.en).toBe("baz qux.");
    const sw = db.prepare("SELECT COUNT(*) c FROM sentence_words WHERE sentence_id=?").get(sid) as any;
    expect(sw.c).toBe(2);
    const rep = db.prepare("SELECT status FROM sentence_reports WHERE sentence_id=? AND status='pending'").get(sid);
    expect(rep).toBeUndefined();
  });

  it("邀请码列表/生成/停用", async () => {
    const list = await adminAgent.get("/api/admin/invites");
    expect(list.status).toBe(200);
    expect(list.body.invites.length).toBeGreaterThanOrEqual(1);
    const gen = await adminAgent.post("/api/admin/invites").send({});
    expect(gen.status).toBe(200);
    expect(gen.body.code).toBeTruthy();
    const id = gen.body.id;
    const toggle = await adminAgent.post(`/api/admin/invites/${id}/toggle`).send({});
    expect(toggle.status).toBe(200);
    const st = db.prepare("SELECT enabled FROM invite_codes WHERE id=?").get(id) as any;
    expect(st.enabled).toBe(0);
  });

  it("句子删除级联清理", async () => {
    const sid = (db.prepare("SELECT id FROM sentences WHERE en='baz qux.'").get() as any).id;
    const r = await adminAgent.post(`/api/admin/sentences/${sid}/delete`);
    expect(r.status).toBe(200);
    expect(db.prepare("SELECT * FROM sentences WHERE id=?").get(sid)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) c FROM sentence_words WHERE sentence_id=?").get(sid).c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM audio WHERE sentence_id=?").get(sid).c).toBe(0);
  });

  it("用户列表 + 停用/启用/删除", async () => {
    const list = await adminAgent.get("/api/admin/users");
    expect(list.status).toBe(200);
    expect(list.body.users.length).toBeGreaterThanOrEqual(2);
    const alice = list.body.users.find((u: any) => u.username === "alice");
    const d = await adminAgent.post(`/api/admin/users/${alice.id}/disable`);
    expect(d.status).toBe(200);
    const bad = await request(app).post("/api/auth/login").send({ username: "alice", password: "alice1234!" });
    expect(bad.status).toBe(403);
    const e = await adminAgent.post(`/api/admin/users/${alice.id}/enable`);
    expect(e.status).toBe(200);
    const del = await adminAgent.post(`/api/admin/users/${alice.id}/delete`);
    expect(del.status).toBe(200);
    const gone = db.prepare("SELECT * FROM users WHERE id=?").get(alice.id);
    expect(gone).toBeUndefined();
    // 级联：alice 的数据全清
    expect(db.prepare("SELECT COUNT(*) c FROM user_vocab WHERE user_id=?").get(alice.id).c).toBe(0);
  });
});
