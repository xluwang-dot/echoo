// 生词本 HTTP API（T013）
// 数据层在 vocab.ts，REST 端点：列表 / 统计 / 删除。
import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { requireAuth } from "./auth.js";
import { getUserVocab, removeVocab, getMasteredCount, getMasteredVocab, addVocab, searchWords, lookupWord } from "../vocab.js";

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

  // GET /mastered — 已掌握词句对（T046 掌握词墙）
  router.get("/mastered", requireAuth, (req, res) => {
    const vocab = getMasteredVocab(database, req.session.userId!);
    res.json({ vocab, count: vocab.length });
  });

  // T070：单词候选（输入防抖搜索）
  router.get("/search", requireAuth, (req, res) => {
    const q = String(req.query.q ?? "").trim().toLowerCase();
    if (!q) {
      res.json({ matches: [] });
      return;
    }
    res.json({ matches: searchWords(database, q) });
  });

  // T070：词详情 + 状态 + 关联句子
  router.get("/lookup", requireAuth, (req, res) => {
    const word = String(req.query.word ?? "").trim().toLowerCase();
    if (!word) {
      res.status(400).json({ error: "word 参数必填" });
      return;
    }
    const r = lookupWord(database, req.session.userId!, word);
    if (!r) {
      res.status(404).json({ error: "词未收录" });
      return;
    }
    res.json(r);
  });

  // T070：指定句子入本（幂等；不动该词其他句的已有记录——保留原有位置）
  router.post("/add", requireAuth, (req, res) => {
    const wordId = Number(req.body?.wordId);
    const sentenceId = Number(req.body?.sentenceId);
    if (!Number.isInteger(wordId) || !Number.isInteger(sentenceId)) {
      res.status(400).json({ error: "wordId/sentenceId 需为整数" });
      return;
    }
    addVocab(database, req.session.userId!, wordId, sentenceId);
    res.json({ ok: true });
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
