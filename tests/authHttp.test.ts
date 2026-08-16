import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { configureSession } from "../src/sessionStore.js";
import { authRouter } from "../src/routes/auth.js";
import { hashPassword } from "../src/auth.js";
const TEST_DB = path.join(os.tmpdir(), "word_typer_test_t007_http.db");
let db: import("node:sqlite").DatabaseSync;
let app: express.Express;

describe("T007 auth 路由", () => {
  beforeAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    db = new DatabaseSync(TEST_DB);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(SCHEMA_SQL);
    // 预置用户 bob + 停用用户 disableduser + 测试邀请码
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(
      "bob",
      hashPassword("bob123456")
    );
    db.prepare("INSERT INTO users (username, password_hash, status) VALUES (?, ?, 'disabled')").run(
      "baduser",
      hashPassword("bad12345!")
    );
    db.prepare("INSERT INTO invite_codes (code, created_at) VALUES ('TESTCODE1', ?), ('TESTCODE2', ?)").run(
      new Date().toISOString(), new Date().toISOString()
    );

    app = express();
    app.use(express.json());
    app.use(configureSession());
    app.use("/api/auth", authRouter(db));
  });
  afterAll(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("注册成功返回 201 与 user，并自动登录", async () => {
    const agent = request.agent(app);
    const res = await agent
      .post("/api/auth/register")
      .send({ username: "carol", password: "carol123!", nickname: "小卡", inviteCode: "TESTCODE1" });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe("carol");
    expect(res.body.password_hash).toBeUndefined();
    // 已登录（同 agent 共享 cookie）
    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("carol");
  });

  it("注册参数校验：空用户名/短密码/弱密码/无邀请码返回 400", async () => {
    const r1 = await request(app).post("/api/auth/register").send({ username: "", password: "x1234567!", inviteCode: "TESTCODE2" });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post("/api/auth/register").send({ username: "dave", password: "123", inviteCode: "TESTCODE2" });
    expect(r2.status).toBe(400);
    // 密码策略：8 位但仅 2 类字符 → 400
    const r3 = await request(app).post("/api/auth/register").send({ username: "dave", password: "dave1234", inviteCode: "TESTCODE2" });
    expect(r3.status).toBe(400);
    expect(r3.body.error).toContain("3 种");
    // 无邀请码 → 400
    const r4 = await request(app).post("/api/auth/register").send({ username: "dave", password: "dave1234!", });
    expect(r4.status).toBe(400);
    // 无效邀请码 → 400
    const r5 = await request(app).post("/api/auth/register").send({ username: "dave", password: "dave1234!", inviteCode: "NOPE" });
    expect(r5.status).toBe(400);
  });

  it("邀请码二次使用返回 400", async () => {
    // TESTCODE2 未被使用 → 注册成功消费
    const r1 = await request(app).post("/api/auth/register").send({ username: "eve", password: "eve12345!", inviteCode: "TESTCODE2" });
    expect(r1.status).toBe(201);
    // 同一码再用 → 400
    const r2 = await request(app).post("/api/auth/register").send({ username: "frank", password: "frank123!", inviteCode: "TESTCODE2" });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toContain("邀请码");
  });

  it("重复注册返回 409", async () => {
    db.prepare("INSERT INTO invite_codes (code, created_at) VALUES ('TESTCODE3', ?)").run(new Date().toISOString());
    const res = await request(app)
      .post("/api/auth/register")
      .send({ username: "carol", password: "carol456!", inviteCode: "TESTCODE3" });
    expect(res.status).toBe(409);
  });

  it("登录成功返回 user 与 session，错误返回 401", async () => {
    const ok = await request(app).post("/api/auth/login").send({ username: "bob", password: "bob123456" });
    expect(ok.status).toBe(200);
    expect(ok.body.username).toBe("bob");
    const bad = await request(app).post("/api/auth/login").send({ username: "bob", password: "wrong" });
    expect(bad.status).toBe(401);
  });

  it("未登录访问 /me 返回 401", async () => {
    const agent = request.agent(app);
    const res = await agent.get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("停用用户登录返回 403", async () => {
    const r = await request(app).post("/api/auth/login").send({ username: "baduser", password: "bad12345!" });
    expect(r.status).toBe(403);
  });

  it("change-password：旧密码错/弱新密码/成功清强制改密", async () => {
    // 建一个 must_change_password=1 的用户
    db.prepare("INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, 1)").run("newbie", hashPassword("newbie12!"));
    const agent = request.agent(app);
    const lg = await agent.post("/api/auth/login").send({ username: "newbie", password: "newbie12!" });
    expect(lg.status).toBe(200);
    const me = await agent.get("/api/auth/me");
    expect(me.body.must_change_password).toBe(true);
    // 旧密码错
    const bad = await agent.post("/api/auth/change-password").send({ oldPassword: "wrong", newPassword: "newpass123!" });
    expect(bad.status).toBe(400);
    // 弱新密码
    const weak = await agent.post("/api/auth/change-password").send({ oldPassword: "newbie12!", newPassword: "weakpass" });
    expect(weak.status).toBe(400);
    // 成功
    const ok = await agent.post("/api/auth/change-password").send({ oldPassword: "newbie12!", newPassword: "newpass123!" });
    expect(ok.status).toBe(200);
    const me2 = await agent.get("/api/auth/me");
    expect(me2.body.must_change_password).toBe(false);
    // 新密码可登录
    const relogin = await request(app).post("/api/auth/login").send({ username: "newbie", password: "newpass123!" });
    expect(relogin.status).toBe(200);
  });

  it("登出后 /me 返回 401（cookie 会话被销毁）", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ username: "bob", password: "bob123456" });
    const before = await agent.get("/api/auth/me");
    expect(before.status).toBe(200);
    await agent.post("/api/auth/logout");
    const after = await agent.get("/api/auth/me");
    expect(after.status).toBe(401);
  });
});
