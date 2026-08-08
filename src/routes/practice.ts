// 练习 HTTP API（T010）
// 会话状态机在 practiceSession.ts，tokens 判定用 checker.ts，落库用 practice.ts。
import { Router, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { requireAuth } from "./auth.js";
import { getSentenceWithTokens, completeSentence, getDueCount, aggregateVocabState, getDueWords } from "../practice.js";
import { wordState, sentenceDone } from "../checker.js";
import { createSession, getSession, clearSession, elapsedMs } from "../practiceSession.js";
import { finishSession as persistSession } from "../practice.js";
import { addVocab } from "../vocab.js";

const MAX_TARGET = 50;

// 取当前句子 tokens（word + is_name + in_vocab）
function currentTokens(db: DatabaseSync, state: import("../practiceSession.js").SessionState, userId: number) {
  const sentenceId = state.sentenceIds[state.idx];
  const s = getSentenceWithTokens(db, sentenceId, userId);
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

// 复习模式：跳过非生词与人名（in_vocab=false 或 is_name=1），指向下一个需默写的词
// 注意：人名在复习模式同样不输入，一并跳过（不依赖与 skipNameWords 的调用顺序）
function skipNonVocabWords(
  state: { wordIdx: number; typed: string },
  tokens: { in_vocab: boolean; is_name: number }[],
  mode: string
) {
  if (mode !== "review" && mode !== "test") return; // B0004：测试模式同样跳词（与前端一致）
  while (
    state.wordIdx < tokens.length &&
    (!tokens[state.wordIdx].in_vocab || tokens[state.wordIdx].is_name === 1)
  ) {
    state.wordIdx += 1;
    state.typed = "";
  }
}

export function practiceRouter(db?: DatabaseSync): Router {
  const router = Router();
  const database = db ?? getDb();

  // 开始练习（mode: "practice"=默认学新, "review"=到期复习, "test"=验收测试）
  router.post("/start", requireAuth, (req, res) => {
    const targetCount = Number(req.body?.targetCount);
    if (!Number.isInteger(targetCount) || targetCount <= 0 || targetCount > MAX_TARGET) {
      res.status(400).json({ error: `targetCount 需为 1~${MAX_TARGET} 的整数` });
      return;
    }
    const m = req.body?.mode;
    const mode = m === "review" || m === "test" ? m : "practice";
    // 测试范围（T028）
    const scope = ["all", "near", "fail", "mastered"].includes(req.body?.scope) ? req.body.scope : "all";
    const state = createSession(database, req.session.userId!, targetCount, {
      newRatio: mode === "practice" ? 10 : 0,
      reviewRatio: mode === "review" ? 10 : 0,
      reviewOnly: mode === "review",
      mode,
      scope,
    });
    // 空会话（复习/测试无词句对）：友好提示而非 500（T032 边界）
    if (state.sentenceIds.length === 0) {
      clearSession(req.session.userId!);
      res.status(400).json({
        error: mode === "review" ? "生词本暂无内容，先去「练习」收集生词吧" : "暂无生词可测，先去「练习」收集生词吧",
      });
      return;
    }
    skipNameWords(state, []); // start 后 skipNameWords 需要 tokens，后面 currentTokens 里处理
    const cur = currentTokens(database, state, req.session.userId!);
    skipNameWords(state, cur.sentence.tokens);
    skipNonVocabWords(state, cur.sentence.tokens, state.mode); // 复习模式跳过非生词
    res.json({
      total: state.sentenceIds.length, // T033：返回实际抽取句数（复习池不足 targetCount 时）
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
    const { sentence } = currentTokens(database, state, req.session.userId!);
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
      skipNameWords(state, sentence.tokens);
      skipNonVocabWords(state, sentence.tokens, state.mode); // 复习模式跳过非生词
      const sentenceIsDone = state.wordIdx >= sentence.tokens.length;
      res.json({ correct: true, wordDone: true, sentenceDone: sentenceIsDone });
    } else {
      res.json({ correct: true, wordDone: false, sentenceDone: false });
    }
  });

  // T035：将当前会话句子的指定词加入生词本（练习模式完成态点击单词）
  router.post("/add-vocab", requireAuth, (req, res) => {
    const state = getSession(req.session.userId!);
    if (!state) {
      res.status(409).json({ error: "没有进行中的练习" });
      return;
    }
    const wordId = Number(req.body?.wordId);
    if (!Number.isInteger(wordId)) {
      res.status(400).json({ error: "wordId 需为整数" });
      return;
    }
    const { sentence } = currentTokens(database, state, req.session.userId!);
    addVocab(database, req.session.userId!, wordId, sentence.id);
    res.json({ ok: true });
  });

  // 提示词：当前词入生词本 + 返回词；词浅色提示，仍要求用户再输入一次
  // T028：测试模式禁用提示词（验收性质）
  router.post("/hint", requireAuth, (req, res) => {
    const state = getSession(req.session.userId!);
    if (!state) {
      res.status(409).json({ error: "没有进行中的练习" });
      return;
    }
    if (state.mode === "test") {
      res.status(403).json({ error: "测试模式禁用提示词" });
      return;
    }
    const { sentence } = currentTokens(database, state, req.session.userId!);
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
    const { sentence } = currentTokens(database, state, req.session.userId!);
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
      const cur = getSentenceWithTokens(database, state.sentenceIds[state.idx], req.session.userId!)!;
      skipNameWords(state, cur.tokens);
      // B0004：复习/测试模式继续跳过非生词，保持与前端 skipNonVocabWords 一致
      if (state.mode === "review" || state.mode === "test") {
        skipNonVocabWords(state, cur.tokens, state.mode);
      }
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

  // 到期复习数量（T029，§4.1 登录到期横幅）
  router.get("/due-count", requireAuth, (req, res) => {
    res.json({ due: getDueCount(database, req.session.userId!) });
  });

  // 当前到期词聚合（T031：横幅「查看单词」弹窗）
  router.get("/due-words", requireAuth, (req, res) => {
    res.json({ words: getDueWords(database, req.session.userId!) });
  });

  // 指定词的聚合状态（T031：复习总结表格）
  router.post("/vocab-state", requireAuth, (req, res) => {
    const wordIds = req.body?.wordIds;
    if (!Array.isArray(wordIds) || !wordIds.every((n: unknown) => Number.isInteger(n))) {
      res.status(400).json({ error: "wordIds 需为整数数组" });
      return;
    }
    res.json({ words: aggregateVocabState(database, req.session.userId!, wordIds as number[]) });
  });

  // 报告句子有误（§3.6）：写入待处理队列（sentence_reports，status=pending）
  // T020：支持可选错误描述 description（trim 后入库，缺省/空串为 NULL）
  router.post("/report", requireAuth, (req, res) => {
    const sentenceId = Number(req.body?.sentenceId);
    if (!Number.isInteger(sentenceId) || sentenceId <= 0) {
      res.status(400).json({ error: "sentenceId 需为正整数" });
      return;
    }
    const exists = database.prepare("SELECT id FROM sentences WHERE id = ?").get(sentenceId);
    if (!exists) {
      res.status(404).json({ error: "句子不存在" });
      return;
    }
    const desc = typeof req.body?.description === "string" ? req.body.description.trim() : null;
    const result = database
      .prepare(
        "INSERT INTO sentence_reports (sentence_id, user_id, time, status, description) VALUES (?, ?, ?, 'pending', ?)"
      )
      .run(sentenceId, req.session.userId!, new Date().toISOString(), desc);
    res.json({ ok: true, reportId: result.lastInsertRowid });
  });

  return router;
}