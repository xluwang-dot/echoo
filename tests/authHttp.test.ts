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
    // 预置一个用户 bob（密码哈希）供登录测试
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(
      "bob",
      hashPassword("bob123456")
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
      .send({ username: "carol", password: "carol123", nickname: "小卡" });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe("carol");
    expect(res.body.password_hash).toBeUndefined();
    // 已登录（同 agent 共享 cookie）
    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("carol");
  });

  it("注册参数校验：空用户名/短密码返回 400", async () => {
    const r1 = await request(app).post("/api/auth/register").send({ username: "", password: "x1234567" });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post("/api/auth/register").send({ username: "dave", password: "123" });
    expect(r2.status).toBe(400);
  });

  it("重复注册返回 409", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ username: "carol", password: "carol123" });
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
