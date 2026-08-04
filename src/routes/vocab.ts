// 生词本 HTTP API（T013）
// 数据层在 vocab.ts，REST 端点：列表 / 统计 / 删除。
import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { requireAuth } from "./auth.js";
import { getUserVocab, removeVocab, getMasteredCount } from "../vocab.js";

export function vocabRouter(db?: DatabaseSync): Router {
  const router = Router();
  const database = db ?? getDb();

  // GET / — 生词本列表（词+句子+中文，按时间倒序）
  router.get("/", requireAuth, (req, res) => {
    const vocab = getUserVocab(database, req.session.userId!);
    res.json({ vocab, count: vocab.length });
  });

  // GET /stats — 统计（生词数、已掌握数、涉及句子数）
  router.get("/stats", requireAuth, (req, res) => {
    const vocab = getUserVocab(database, req.session.userId!);
    const sentenceIds = new Set(vocab.map((v) => v.sentence_id));
    const masteredCount = getMasteredCount(database, req.session.userId!);
    res.json({
      vocabCount: vocab.length,
      masteredCount,
      sentenceCount: sentenceIds.size,
    });
  });

  // DELETE /:wordId/:sentenceId — 删除单条词句对
  router.delete("/:wordId/:sentenceId", requireAuth, (req, res) => {
    const wordId = Number(req.params.wordId);
    const sentenceId = Number(req.params.sentenceId);
    if (!Number.isFinite(wordId) || !Number.isFinite(sentenceId)) {
      res.status(400).json({ error: "参数无效" });
      return;
    }
    removeVocab(database, req.session.userId!, wordId, sentenceId);
    res.json({ ok: true });
  });

  return router;
}
