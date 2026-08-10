// 音频服务路由（T012）：按 sentence_id 返回磁盘上的句子音频
// 音频文件在 data/audio/（相对项目根），DB 只存路径引用，二进制不进库。
import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

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
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "音频文件缺失" });
      return;
    }
    res.type("audio/wav").sendFile(abs);
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
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "音频文件缺失" });
      return;
    }
    res.type("audio/wav").sendFile(abs);
  });

  return router;
}