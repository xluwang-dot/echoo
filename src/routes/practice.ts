// 练习 HTTP API（T010）
// 会话状态机在 practiceSession.ts，tokens 判定用 checker.ts，落库用 practice.ts。
import { Router, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { requireAuth } from "./auth.js";
import { getSentenceWithTokens, completeSentence, getDueCount, aggregateVocabState, getDueWords, getMasteryCount, getUserLevel, updateUserLevel, isLevelUpPassed, isLevelTestReady, DICTATION_TIMING, getOrCreateWordSentence, addDays } from "../practice.js";
import { wordState } from "../checker.js";
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
    const mode = m === "review" || m === "test" || m === "dictation" ? m : "practice"; // T069：听写模式
    // 测试范围（T028）
    const scope = ["all", "near", "fail", "mastered", "levelup"].includes(req.body?.scope) ? req.body.scope : "all"; // T053b
    // T037：立即复习必含的句子（当前练习入本句）
    const includeRaw = req.body?.includeSentenceIds;
    const includeSentenceIds =
      Array.isArray(includeRaw) && includeRaw.every((n: unknown) => Number.isInteger(n))
        ? (includeRaw as number[])
        : undefined;
    const state = createSession(database, req.session.userId!, targetCount, {
      newRatio: mode === "practice" ? 10 : 0,
      reviewRatio: mode === "review" ? 10 : 0,
      reviewOnly: mode === "review",
      mode,
      scope,
      includeSentenceIds,
      level: getUserLevel(database, req.session.userId!), // T053a
    });
    // 空会话（复习/测试无词句对）：友好提示而非 500（T032 边界）
    if (state.sentenceIds.length === 0) {
      clearSession(req.session.userId!);
      res.status(400).json({
        error:
          mode === "review"
            ? "生词本暂无内容，先去「练习」收集生词吧"
            : mode === "dictation"
              ? "当前册暂无未听写单词"
              : "暂无生词可测，先去「练习」收集生词吧",
      });
      return;
    }
    skipNameWords(state, []); // start 后 skipNameWords 需要 tokens，后面 currentTokens 里处理
    const cur = currentTokens(database, state, req.session.userId!);
    skipNameWords(state, cur.sentence.tokens);
    skipNonVocabWords(state, cur.sentence.tokens, state.mode); // 复习模式跳过非生词
    // T069：听写一次性返回全部词（前端不调 next 推进服务端 state——否则输入判定错位）
    let words: unknown[] | undefined;
    if (mode === "dictation") {
      // T069：words 带音标（提示用）
      words = state.sentenceIds.map((id) => {
        const s = getSentenceWithTokens(database, id, req.session.userId!);
        const w = s?.tokens?.[0]
          ? (database.prepare("SELECT phonetic FROM words WHERE id=?").get(s.tokens[0].word_id) as
              | { phonetic: string | null }
              | undefined)
          : undefined;
        return { ...s, phonetic: w?.phonetic ?? null };
      });
    }
    res.json({
      total: state.sentenceIds.length, // T033：返回实际抽取句数（复习池不足 targetCount 时）
      current: {
        sentenceId: cur.sentenceId,
        zh: cur.sentence.zh,
        en: cur.sentence.en,
        is_word_only: cur.sentence.is_word_only, // T069：占位句标记（前端听音拼写）
        prev_en: cur.sentence.prev_en,
        next_en: cur.sentence.next_en,
        tokens: cur.sentence.tokens,
        wordIdx: state.wordIdx,
      },
      ...(words ? { words } : {}),
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
    const wrow = database.prepare("SELECT id FROM words WHERE lower(word) = lower(?)").get(word) as { id: number } | undefined;
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
    // T045：新掌握词（前端掌握特效）
    const masteredWordIds = completeSentence(database, state.sessionId, req.session.userId!, sentenceId, wordResults);
    const masteryCount = getMasteryCount(database, req.session.userId!);

    state.idx += 1;
    state.wordIdx = 0;
    state.typed = "";
    const done = state.idx >= state.sentenceIds.length;
    if (done) {
      persistSession(database, state.sessionId, state.sentenceIds.length, elapsedMs(state));
      clearSession(req.session.userId!);
      // T053b：升级测试通过判定（句子正确率 ≥60% → 解锁下一级）
      let levelUp = false;
      let newLevel: number | undefined;
      if (state.scope === "levelup" && isLevelUpPassed(database, state.sessionId)) {
        levelUp = true;
        const fromLevel = getUserLevel(database, req.session.userId!);
        newLevel = fromLevel + 1;
        updateUserLevel(database, req.session.userId!, newLevel);
        // T053c：记录升级历史（足迹/勋章用）
        database
          .prepare("INSERT INTO levelup_history (user_id, from_level, to_level, time) VALUES (?, ?, ?, ?)")
          .run(req.session.userId!, fromLevel, newLevel, new Date().toISOString());
      }
      res.json({ done: true, masteredWordIds, masteryCount, levelUp, newLevel });
    } else {
      const cur = getSentenceWithTokens(database, state.sentenceIds[state.idx], req.session.userId!)!;
      skipNameWords(state, cur.tokens);
      // B0004：复习/测试模式继续跳过非生词，保持与前端 skipNonVocabWords 一致
      if (state.mode === "review" || state.mode === "test") {
        skipNonVocabWords(state, cur.tokens, state.mode);
      }
      res.json({
        done: false,
        masteredWordIds,
        masteryCount,
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
  // T069：听写——词间推进（无落库；拼对词不入本不记状态）
  router.post("/next", requireAuth, (req, res) => {
    const state = getSession(req.session.userId!);
    if (!state) {
      res.status(409).json({ error: "没有进行中的练习" });
      return;
    }
    state.idx += 1;
    state.wordIdx = 0;
    state.typed = "";
    if (state.idx >= state.sentenceIds.length) {
      res.json({ done: true });
      return;
    }
    const s = getSentenceWithTokens(database, state.sentenceIds[state.idx], req.session.userId!);
    res.json({ done: false, next: { ...s, wordIdx: 0 } });
  });

  // T069：听写结束——错误词统一入本（占位句），正确词无痕；清会话
  router.post("/complete-dictation", requireAuth, (req, res) => {
    const state = getSession(req.session.userId!);
    if (!state) {
      res.status(409).json({ error: "没有进行中的练习" });
      return;
    }
    const userId = req.session.userId!;
    const wrongWordIds: number[] = Array.isArray(req.body?.wrongWordIds) ? req.body.wrongWordIds : [];
    const now = new Date().toISOString();
    for (const wid of wrongWordIds) {
      const psid = getOrCreateWordSentence(database, wid); // 幂等
      database
        .prepare(
          "INSERT OR IGNORE INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status) VALUES (?, ?, ?, ?, 1, 0, ?, 'learning')"
        )
        .run(userId, wid, psid, now, addDays(1));
      database
        .prepare("INSERT INTO test_records (session_id, user_id, word_id, sentence_id, time, result) VALUES (?, ?, ?, ?, ?, 'hint')")
        .run(state.sessionId, userId, wid, psid, now);
    }
    clearSession(userId);
    res.json({ ok: true, added: wrongWordIds.length });
  });

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

  // T053b：升级测试状态（等级 + 邀请是否激活 + 规则）
  router.get("/levelup-status", requireAuth, (req, res) => {
    const level = getUserLevel(database, req.session.userId!);
    res.json({
      level,
      ready: isLevelTestReady(database, req.session.userId!),
      rule: "连续 3 轮练习正确率 ≥80% 可发起升级测试；测试 20 句、无提示、限时、正确率 ≥60% 通过",
    });
  });

  // 到期复习数量（T029，§4.1 登录到期横幅）
  // T069：听写时间参数（3s 二次播报 / 8s 三次+词义 / 12s 自动下一词）
  router.get("/dictation-timing", (req, res) => {
    res.json(DICTATION_TIMING);
  });

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
