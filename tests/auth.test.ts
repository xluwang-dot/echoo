import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.js";
import {
  hashPassword,
  verifyPassword,
  createUser,
  findUserByUsername,
  findUserById,
  login,
} from "../src/auth.js";

const TEST_DB = path.join(os.tmpdir(), "word_typer_test_t007.db");
let db: DatabaseSync;

function freshDb(): DatabaseSync {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const d = new DatabaseSync(TEST_DB);
  d.exec("PRAGMA foreign_keys=ON");
  d.exec(SCHEMA_SQL);
  return d;
}

describe("T007 auth 数据层", () => {
  beforeAll(() => {
    db = freshDb();
  });
  afterAll(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("hashPassword 生成 bcrypt 哈希（非明文）", () => {
    const h = hashPassword("secret123");
    expect(h).not.toBe("secret123");
    expect(h.startsWith("$2")).toBe(true);
  });

  it("verifyPassword 正确/错误", () => {
    const h = hashPassword("secret123");
    expect(verifyPassword("secret123", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });

  it("createUser 落库，密码为哈希", () => {
    const id = createUser(db, { username: "alice", password: "pw123456", nickname: "小爱" });
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as {
      username: string;
      password_hash: string;
      nickname: string;
    };
    expect(row.username).toBe("alice");
    expect(row.nickname).toBe("小爱");
    expect(row.password_hash).not.toBe("pw123456");
    expect(verifyPassword("pw123456", row.password_hash)).toBe(true);
  });

  it("重复 username 抛错", () => {
    expect(() => createUser(db, { username: "alice", password: "x1234567" })).toThrow();
  });

  it("findUserByUsername / findUserById", () => {
    const u = findUserByUsername(db, "alice")!;
    expect(u.username).toBe("alice");
    expect(findUserById(db, u.id)!.nickname).toBe("小爱");
  });

  it("login 成功返回 user，密码错误返回 undefined", () => {
    const ok = login(db, "alice", "pw123456");
    expect(ok?.username).toBe("alice");
    expect(login(db, "alice", "badpass")).toBeUndefined();
    expect(login(db, "nobody", "pw123456")).toBeUndefined();
  });
});
