// 音频服务路由（T012）：按 sentence_id 返回磁盘上的句子音频
// 音频文件在 data/audio/（相对项目根），DB 只存路径引用，二进制不进库。
import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

// T062：校验路径在 data/ 目录内（防路径遍历/DB 污染泄露）
const DATA_ROOT = path.resolve(process.cwd(), "data");
function safeAudioPath(abs: string): boolean {
  const resolved = path.resolve(abs);
  return resolved === DATA_ROOT || resolved.startsWith(DATA_ROOT + path.sep);
}

// T066：sendFile 统一回调（异步失败不挂起）
function sendAudio(res: Response, abs: string): void {
  // T073：按扩展名设类型（词音频 mp3 / 句音频 mp3 或 wav）
  const type = abs.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
  res.type(type).sendFile(abs, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: "音频发送失败" });
    }
  });
}

export function audioRouter(db?: DatabaseSync): Router {
  const router = Router();
  const database = db ?? getDb();

  // T047c：词发音音频（words.audio_path 引用，有道英音）
  router.get("/word/:word", (req: Request, res: Response) => {
    const word = String(req.params.word).toLowerCase();
    const row = database
      .prepare("SELECT audio_path FROM words WHERE lower(word) = ?")
      .get(word) as { audio_path: string | null } | undefined;
    if (!row?.audio_path) {
      res.status(404).json({ error: "该词暂无音频" });
      return;
    }
    const abs = path.isAbsolute(row.audio_path)
      ? row.audio_path
      : path.resolve(process.cwd(), row.audio_path);
    if (!safeAudioPath(abs)) {
      res.status(403).json({ error: "路径不在安全目录内" });
      return;
    }
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "音频文件缺失" });
      return;
    }
    sendAudio(res, abs);
  });

  router.get("/:sentenceId", (req: Request, res: Response) => {
    const sentenceId = Number(req.params.sentenceId);
    const row = database
      .prepare("SELECT file_path FROM audio WHERE sentence_id = ?")
      .get(sentenceId) as { file_path: string | null } | undefined;
    if (!row?.file_path) {
      res.status(404).json({ error: "该句暂无音频" });
      return;
    }
    // 相对路径基于项目根解析
    const abs = path.isAbsolute(row.file_path) ? row.file_path : path.resolve(process.cwd(), row.file_path);
    if (!safeAudioPath(abs)) {
      res.status(403).json({ error: "路径不在安全目录内" });
      return;
    }
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "音频文件缺失" });
      return;
    }
    sendAudio(res, abs);
  });

  return router;
}