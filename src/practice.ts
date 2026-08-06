// 练习核心：抽取 + 会话 + 结果落库（T009）
// 数据层 + 业务逻辑（无 HTTP）；判定纯函数在 checker.ts。
import type { DatabaseSync } from "node:sqlite";

export type WordResult = "mastered" | "hint";

export interface SentenceWithTokens {
  id: number;
  en: string;
  zh: string;
  tokens: { word_id: number; word: string; is_name: number; is_bold: number; in_vocab: boolean }[];
}

// ---------- 抽取（需求 §3.3）----------

// 该用户已测试句子 id（test_records 去重）
export function getTestedSentenceIds(db: DatabaseSync, userId: number): number[] {
  const rows = db
    .prepare("SELECT DISTINCT sentence_id FROM test_records WHERE user_id = ? AND sentence_id IS NOT NULL")
    .all(userId) as { sentence_id: number }[];
  return rows.map((r) => r.sentence_id);
}

// 未测试句子 id = 全部 - 已测试
export function getUntestedSentenceIds(db: DatabaseSync, userId: number): number[] {
  const tested = getTestedSentenceIds(db, userId);
  const all = (db.prepare("SELECT id FROM sentences").all() as { id: number }[]).map((r) => r.id);
  const testedSet = new Set(tested);
  return all.filter((id) => !testedSet.has(id));
}

// 生词本涉及的句子 id
// 被报告句子 id（≥1 次报告即进入规避池；句子问题对所有用户一致）
export function getReportedSentenceIds(db: DatabaseSync): number[] {
  const rows = db
    .prepare("SELECT DISTINCT sentence_id FROM sentence_reports WHERE sentence_id IS NOT NULL")
    .all() as { sentence_id: number }[];
  return rows.map((r) => r.sentence_id);
}

// 生词本涉及的句子 id
export function getReviewSentenceIds(db: DatabaseSync, userId: number): number[] {
  const rows = db
    .prepare("SELECT DISTINCT sentence_id FROM user_vocab WHERE user_id = ?")
    .all(userId) as { sentence_id: number }[];
  return rows.map((r) => r.sentence_id);
}

// 随机抽 n 个不重复元素
function sample<T>(arr: T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

export interface DrawConfig {
  newRatio?: number;
  reviewRatio?: number;
  reviewOnly?: boolean; // 纯复习模式：只从生词本抽取
}

// 按比例抽取：U（未测试）: R（生词本复习）= 3:7，不足从已测试补齐（§3.3.4）
// reviewOnly=true 时只从生词本抽取（复习模式）
export function drawSession(
  db: DatabaseSync,
  userId: number,
  targetCount: number,
  config: DrawConfig = {}
): number[] {
  const { newRatio = 3, reviewRatio = 7, reviewOnly = false } = config;
  // 被报告句子：常规池剔除、放兜底末尾（§3.6 优先规避）
  const reported = new Set(getReportedSentenceIds(db));
  const untested = getUntestedSentenceIds(db, userId).filter((id) => !reported.has(id));
  const review = getReviewSentenceIds(db, userId).filter((id) => !reported.has(id));
  const tested = getTestedSentenceIds(db, userId).filter((id) => !reported.has(id));

  // 纯复习模式：只从生词本抽取
  if (reviewOnly) {
    const result = sample(review, targetCount);
    // 不足时从已测试补齐
    if (result.length < targetCount) {
      const fill = tested.filter((id) => !result.includes(id));
      for (const id of fill) {
        if (result.length >= targetCount) break;
        result.push(id);
      }
    }
    // 仍不足：被报告句子兜底（常规池耗尽才用）
    if (result.length < targetCount) {
      const fillReported = [...reported].filter((id) => !result.includes(id));
      for (const id of fillReported) {
        if (result.length >= targetCount) break;
        result.push(id);
      }
    }
    return result;
  }

  const totalRatio = newRatio + reviewRatio;
  const newCount = Math.round((targetCount * newRatio) / totalRatio);
  const reviewCount = Math.round((targetCount * reviewRatio) / totalRatio);

  let fromNew = sample(untested, newCount);
  let fromReview = sample(review.filter((id) => !fromNew.includes(id)), reviewCount);

  // 补充未满部分，优先未测试 → 生词本 → 已测试（不重复）
  const result: number[] = [];
  const seen = new Set<number>();
  const push = (ids: number[]) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
  };
  push(fromNew);
  push(fromReview);

  // 补齐顺序：未测试剩余 → 生词本剩余 → 已测试剩余 → 被报告句子（§3.6 优先规避，常规池耗尽才用）
  const fillNew = untested.filter((id) => !seen.has(id));
  const fillReview = review.filter((id) => !seen.has(id));
  const fillTested = tested.filter((id) => !seen.has(id));
  const fillReported = [...reported].filter((id) => !seen.has(id));
  for (const id of [...fillNew, ...fillReview, ...fillTested, ...fillReported]) {
    if (result.length >= targetCount) break;
    seen.add(id);
    result.push(id);
  }

  // 极端兜底：池总数仍不足 target 时循环复用（需求：不再出现无题可练）
  const allPool = [
    ...new Set([
      ...untested,
      ...review,
      ...tested,
      ...(db.prepare("SELECT id FROM sentences").all() as { id: number }[]).map((r) => r.id),
    ]),
  ];
  while (result.length < targetCount && allPool.length > 0) {
    // 循环追加，重复允许（池耗尽但需凑满 target）
    const from = Math.floor(Math.random() * allPool.length);
    result.push(allPool[from]);
  }
  return result.slice(0, targetCount);
}

// ---------- 会话（需求 §3.5）----------

export function startSession(db: DatabaseSync, userId: number, targetCount: number): number {
  const result = db
    .prepare("INSERT INTO practice_sessions (user_id, target_count, start_time) VALUES (?, ?, ?)")
    .run(userId, targetCount, new Date().toISOString());
  return result.lastInsertRowid as number;
}

export function finishSession(db: DatabaseSync, sessionId: number, doneCount: number, totalMs: number): void {
  db.prepare(
    "UPDATE practice_sessions SET end_time = ?, done_count = ?, total_ms = ? WHERE id = ?"
  ).run(new Date().toISOString(), doneCount, totalMs, sessionId);
}

// 记录单词结果：mastered → 已掌握；hint → 入生词本（词+句）。始终写 test_records。
export function recordWord(
  db: DatabaseSync,
  sessionId: number,
  userId: number,
  wordId: number,
  sentenceId: number,
  result: WordResult
): void {
  if (result === "mastered") {
    db.prepare(
      `INSERT INTO word_status (user_id, word_id, status, updated_at) VALUES (?, ?, 'mastered', ?)
       ON CONFLICT(user_id, word_id) DO UPDATE SET status='mastered', updated_at=excluded.updated_at`
    ).run(userId, wordId, new Date().toISOString());
  } else {
    db.prepare(
      "INSERT OR IGNORE INTO user_vocab (user_id, word_id, sentence_id, created_at) VALUES (?, ?, ?, ?)"
    ).run(userId, wordId, sentenceId, new Date().toISOString());
  }
  db.prepare(
    "INSERT INTO test_records (session_id, user_id, word_id, sentence_id, time, result) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(sessionId, userId, wordId, sentenceId, new Date().toISOString(), result);
}

export interface WordOutcome {
  wordId: number;
  result: WordResult;
}

// 整句完成：逐词落库；若该句在生词本且全拼对 → 移除该句所有词句对（§3.2.3）
export function completeSentence(
  db: DatabaseSync,
  sessionId: number,
  userId: number,
  sentenceId: number,
  outcomes: WordOutcome[]
): void {
  for (const o of outcomes) {
    recordWord(db, sessionId, userId, o.wordId, sentenceId, o.result);
  }
  // 若该句在生词本且本次全部正确拼写（无 hint）→ 整句移除
  if (outcomes.length > 0 && outcomes.every((o) => o.result === "mastered")) {
    db.prepare("DELETE FROM user_vocab WHERE user_id = ? AND sentence_id = ?").run(userId, sentenceId);
  }
}

// 取句子 + tokens（供前端渲染与判定）
// userId 可选：传入时计算每个词的 in_vocab 状态（复习模式用）
export function getSentenceWithTokens(db: DatabaseSync, sentenceId: number, userId?: number): SentenceWithTokens | undefined {
  const s = db.prepare("SELECT id, en, zh FROM sentences WHERE id = ?").get(sentenceId) as
    | { id: number; en: string; zh: string }
    | undefined;
  if (!s) return undefined;
  const rows = db
    .prepare(
      `SELECT sw.position, w.id AS word_id, w.word, w.is_name, sw.is_bold
       FROM sentence_words sw JOIN words w ON w.id = sw.word_id
       WHERE sw.sentence_id = ? ORDER BY sw.position`
    )
    .all(sentenceId) as { position: number; word_id: number; word: string; is_name: number; is_bold: number }[];

  // 查询该句在用户生词本中的 word_id 集合
  const vocabWordIds = userId
    ? new Set(
        db
          .prepare("SELECT word_id FROM user_vocab WHERE user_id = ? AND sentence_id = ?")
          .all(userId, sentenceId)
          .map((r: any) => r.word_id)
      )
    : new Set<number>();

  return {
    id: s.id,
    en: s.en,
    zh: s.zh,
    tokens: rows.map((r) => ({
      word_id: r.word_id,
      word: r.word,
      is_name: r.is_name,
      is_bold: r.is_bold,
      in_vocab: vocabWordIds.has(r.word_id),
    })),
  };
}