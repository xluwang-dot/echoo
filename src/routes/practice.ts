// 练习 HTTP API（T010）
// 会话状态机在 practiceSession.ts，tokens 判定用 checker.ts，落库用 practice.ts。
import { Router, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { requireAuth } from "./auth.js";
import { getSentenceWithTokens, completeSentence } from "../practice.js";
import { wordState, sentenceDone } from "../checker.js";
import { createSession, getSession, clearSession, elapsedMs } from "../practiceSession.js";
import { finishSession as persistSession } from "../practice.js";
import { addVocab } from "../vocab.js";

const MAX_TARGET = 50;

// 取当前句子 tokens（word + is_name）
function currentTokens(db: DatabaseSync, state: import("../practiceSession.js").SessionState) {
  const sentenceId = state.sentenceIds[state.idx];
  const s = getSentenceWithTokens(db, sentenceId);
  return { sentenceId, sentence: s!, wordIdx: state.wordIdx, typed: state.typed };
}

// 判断当前词是否为人名词（跳过输入）
function isNameAt(tokens: { is_name: number }[], wordIdx: number): boolean {
  const t = tokens[wordIdx];
  return !!t && t.is_name === 1;
}

// 跳过连续人名词，指向下一个需要输入的词
function skipNameWords(state: { wordIdx: number; typed: string }, tokens: { is_name: number }[]) {
  while (isNameAt(tokens, state.wordIdx)) {
    state.wordIdx += 1;
    state.typed = "";
  }
}

export function practiceRouter(db?: DatabaseSync): Router {
  const router = Router();
  const database = db ?? getDb();

  // 开始练习（mode: "practice"=默认, "review"=纯复习生词本）
  router.post("/start", requireAuth, (req, res) => {
    const targetCount = Number(req.body?.targetCount);
    if (!Number.isInteger(targetCount) || targetCount <= 0 || targetCount > MAX_TARGET) {
      res.status(400).json({ error: `targetCount 需为 1~${MAX_TARGET} 的整数` });
      return;
    }
    const mode = req.body?.mode === "review" ? "review" : "practice";
    const state = createSession(database, req.session.userId!, targetCount, {
      newRatio: mode === "practice" ? 10 : 0,
      reviewRatio: mode === "review" ? 10 : 0,
      reviewOnly: mode === "review",
    });
    skipNameWords(state, []); // start 后 skipNameWords 需要 tokens，后面 currentTokens 里处理
    const cur = currentTokens(database, state);
    skipNameWords(state, cur.sentence.tokens);
    res.json({
      total: state.targetCount,
      current: {
        sentenceId: cur.sentenceId,
        zh: cur.sentence.zh,
        en: cur.sentence.en,
        tokens: cur.sentence.tokens,
        wordIdx: state.wordIdx,
      },
    });
  });

  // 提交当前词一个字符（服务端权威判定）
  router.post("/check", requireAuth, (req, res) => {
    const state = getSession(req.session.userId!);
    if (!state) {
      res.status(409).json({ error: "没有进行中的练习" });
      return;
    }
    const char = String(req.body?.char ?? "");
    if (char.length !== 1) {
      res.status(400).json({ error: "char 需为单个字符" });
      return;
    }
    const { sentence } = currentTokens(database, state);
    skipNameWords(state, sentence.tokens);
    const word = sentence.tokens[state.wordIdx]?.word;
    if (word === undefined) {
      res.status(409).json({ error: "当前无单词" });
      return;
    }
    const nextTyped = state.typed + char;
    const st = wordState(word, nextTyped);

    // 错误字符不落库、不推进
    if (!st.correct) {
      res.json({ correct: false, wordDone: false, sentenceDone: false });
      return;
    }

    // 正确：推进当前词输入
    state.typed = nextTyped;
    if (st.done) {
      state.wordIdx += 1;
      state.typed = "";
      const sentenceIsDone = state.wordIdx >= sentence.tokens.length;
      res.json({ correct: true, wordDone: true, sentenceDone: sentenceIsDone });
    } else {
      res.json({ correct: true, wordDone: false, sentenceDone: false });
    }
  });

  // 提示词：当前词入生词本 + 返回词；词浅色提示，仍要求用户再输入一次
  router.post("/hint", requireAuth, (req, res) => {
    const state = getSession(req.session.userId!);
    if (!state) {
      res.status(409).json({ error: "没有进行中的练习" });
      return;
    }
    const { sentence } = currentTokens(database, state);
    skipNameWords(state, sentence.tokens);
    const word = sentence.tokens[state.wordIdx]?.word;
    if (word === undefined) {
      res.status(409).json({ error: "当前无单词" });
      return;
    }
    // 词 → word_id
    const wrow = database.prepare("SELECT id FROM words WHERE word = ?").get(word) as { id: number } | undefined;
    if (wrow) {
      addVocab(database, req.session.userId!, wrow.id, sentence.id);
    }
    // 不推进当前词：用户仍需照敲一次
    res.json({ word });
  });

  // 退格：删除当前词已输入的最后字符（保持服务端权威判定）
  router.post("/backspace", requireAuth, (req, res) => {
    const state = getSession(req.session.userId!);
    if (!state) {
      res.status(409).json({ error: "没有进行中的练习" });
      return;
    }
    const { sentence } = currentTokens(database, state);
    skipNameWords(state, sentence.tokens);
    state.typed = state.typed.slice(0, -1);
    res.json({ typed: state.typed });
  });

  // 整句完成：上报各词结果落库，推进下一句或结束
  router.post("/complete", requireAuth, (req, res) => {
    const state = getSession(req.session.userId!);
    if (!state) {
      res.status(409).json({ error: "没有进行中的练习" });
      return;
    }
    const wordResults = Array.isArray(req.body?.wordResults) ? req.body.wordResults : [];
    const sentenceId = state.sentenceIds[state.idx];
    completeSentence(database, state.sessionId, req.session.userId!, sentenceId, wordResults);

    state.idx += 1;
    state.wordIdx = 0;
    state.typed = "";
    const done = state.idx >= state.sentenceIds.length;
    if (done) {
      persistSession(database, state.sessionId, state.sentenceIds.length, elapsedMs(state));
      clearSession(req.session.userId!);
      res.json({ done: true });
    } else {
      const cur = getSentenceWithTokens(database, state.sentenceIds[state.idx])!;
      skipNameWords(state, cur.tokens);
      res.json({
        done: false,
        next: {
          sentenceId: cur.id,
          zh: cur.zh,
          en: cur.en,
          tokens: cur.tokens,
          wordIdx: state.wordIdx,
        },
      });
    }
  });

  // 手动结束/中断
  router.post("/finish", requireAuth, (req, res) => {
    const state = getSession(req.session.userId!);
    if (!state) {
      res.status(409).json({ error: "没有进行中的练习" });
      return;
    }
    // 已完成的句子已在 complete 时落库，这里只收尾会话
    persistSession(database, state.sessionId, state.idx, elapsedMs(state));
    clearSession(req.session.userId!);
    res.json({ ok: true, done: state.idx });
  });

  return router;
}