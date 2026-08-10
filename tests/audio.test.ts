// audio 路由测试（T012）：按 sentence_id 返回磁盘音频文件
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { audioRouter } from "../src/routes/audio.js";

// T062：测试音频放 data/ 内（安全目录校验语义），afterAll 清理
const tmpDir = fs.mkdtempSync(path.join(process.cwd(), "data", "test_audio_tmp"));
const TEST_DB = path.join(tmpDir, "test.db");
let db: DatabaseSync;
let app: express.Express;

function fakeWav(bytes = 1000): void {
  // 写一个最小合法 WAV（RIFF 头）
  const header = Buffer.from("RIFF____WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x80\x3e\x00\x00\x00\x7d\x00\x00\x02\x00\x10\x00data", "latin1");
  const data = Buffer.alloc(bytes, 0);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(36 + data.length, 0);
  const full = Buffer.concat([header, data]);
  return full;
}

describe("T012 audio router", () => {
  beforeAll(() => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    db = new DatabaseSync(TEST_DB);
    db.exec(SCHEMA_SQL);
    // 插一句 + 一条 audio 记录（file_path 指向我们造的 wav）
    const sid = db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("Hello.", "你好。").lastInsertRowid as number;
    const rel = path.join(tmpDir, `${sid}.wav`);
    fs.writeFileSync(rel, fakeWav());
    db.prepare("INSERT INTO audio (sentence_id, file_path, duration_ms) VALUES (?, ?, ?)").run(sid, rel, 500);
    // 记录无音频的句子
    db.prepare("INSERT INTO sentences (en, zh) VALUES (?, ?)").run("No audio.", "无音频。");

    app = express();
    app.use("/api/audio", audioRouter(db));
  });
  // T047c：词音频路由（复用同库同 app）
  beforeAll(() => {
    const wid = db.prepare("INSERT INTO words (word, audio_path) VALUES (?, ?)").run("zzyheavily", path.join(tmpDir, "zzyheavily_uk.wav")).lastInsertRowid as number;
    fs.writeFileSync(path.join(tmpDir, "zzyheavily_uk.wav"), fakeWav());
    db.prepare("INSERT INTO words (word) VALUES (?)").run("zzyword");
  });

  it("词有音频 → 200 返回 wav", async () => {
    const res = await request(app).get("/api/audio/word/zzyheavily");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio");
  });

  it("词无音频 → 404", async () => {
    const res = await request(app).get("/api/audio/word/zzyword");
    expect(res.status).toBe(404);
  });

  it("不存在的词 → 404", async () => {
    const res = await request(app).get("/api/audio/word/notexistzzz");
    expect(res.status).toBe(404);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("有音频的句子 → 返回 wav 文件", async () => {
    const res = await request(app).get("/api/audio/1");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio/);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("无音频记录 → 404", async () => {
    const res = await request(app).get("/api/audio/2");
    expect(res.status).toBe(404);
  });

  it("audio 记录但磁盘文件缺失 → 404", async () => {
    const res = await request(app).get("/api/audio/999");
    expect(res.status).toBe(404);
  });
});

