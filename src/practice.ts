// 练习核心：抽取 + 会话 + 结果落库（T009）
// 数据层 + 业务逻辑（无 HTTP）；判定纯函数在 checker.ts。
import type { DatabaseSync } from "node:sqlite";

export type WordResult = "mastered" | "hint" | "test_fail";

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

// ---------- 复习调度（T027：SM-2 间隔重复，需求 §3.2.3/§3.3）----------
export const REVIEW_INTERVALS = [1, 3, 7, 16, 35]; // 间隔序列（天）
export const MASTERY_THRESHOLD = 5; // 掌握阈值：连续成功次数

// 日期 YYYY-MM-DD（本地时区）
function dateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function todayStr(): string {
  return dateStr(new Date());
}
function addDays(days: number): string {
  return dateStr(new Date(Date.now() + days * 86400000));
}

// 间隔推进：ok=拼对（按序列前进、连续成功 +1）；失败/提示 → 重置 1 天、清零
export function advanceInterval(reviewCount: number, ok: boolean): { interval: number; reviewCount: number } {
  if (!ok) return { interval: 1, reviewCount: 0 };
  const next = reviewCount + 1;
  const interval = REVIEW_INTERVALS[Math.min(next - 1, REVIEW_INTERVALS.length - 1)];
  return { interval, reviewCount: next };
}

// 到期词句对所在句子（learning 且 next_review ≤ 今日）
export function getDueReviewSentenceIds(db: DatabaseSync, userId: number): number[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT sentence_id FROM user_vocab WHERE user_id=? AND status='learning' AND next_review IS NOT NULL AND next_review <= ?"
    )
    .all(userId, todayStr()) as { sentence_id: number }[];
  return rows.map((r) => r.sentence_id);
}

// 到期复习数量（§4.1 登录到期横幅）：learning 且 next_review ≤ 今日的词句对数
export function getDueCount(db: DatabaseSync, userId: number): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM user_vocab WHERE user_id=? AND status='learning' AND next_review IS NOT NULL AND next_review <= ?"
    )
    .get(userId, todayStr()) as { c: number };
  return row.c;
}

// ---------- 单词状态聚合（T031：总结表格/查看单词弹窗）----------
export interface VocabState {
  wordId: number;
  word: string;
  interval: number;
  status: "learning" | "mastered";
  review_count: number;
}

interface VocabRow {
  wordId: number;
  word: string;
  interval: number;
  status: string;
  review_count: number;
}

// 同词多词句对聚合：interval 取最大、任一 mastered 则 status=mastered、review_count 取最大
function aggregateVocabRows(rows: VocabRow[]): VocabState[] {
  const map = new Map<number, VocabState>();
  for (const r of rows) {
    const cur = map.get(r.wordId);
    if (!cur) {
      map.set(r.wordId, {
        wordId: r.wordId,
        word: r.word,
        interval: r.interval,
        status: r.status === "mastered" ? "mastered" : "learning",
        review_count: r.review_count,
      });
    } else {
      cur.interval = Math.max(cur.interval, r.interval);
      if (r.status === "mastered") cur.status = "mastered";
      cur.review_count = Math.max(cur.review_count, r.review_count);
    }
  }
  return [...map.values()];
}

// 指定词的聚合状态（复习总结表格）
export function aggregateVocabState(db: DatabaseSync, userId: number, wordIds: number[]): VocabState[] {
  if (wordIds.length === 0) return [];
  const marks = wordIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT w.id AS wordId, w.word, v.interval, v.status, v.review_count
       FROM user_vocab v JOIN words w ON w.id = v.word_id
       WHERE v.user_id = ? AND v.word_id IN (${marks})`
    )
    .all(userId, ...wordIds) as unknown as VocabRow[];
  return aggregateVocabRows(rows);
}

// 当前到期词聚合（查看单词弹窗）：learning 且 next_review ≤ 今日
export function getDueWords(db: DatabaseSync, userId: number): VocabState[] {
  const rows = db
    .prepare(
      `SELECT w.id AS wordId, w.word, v.interval, v.status, v.review_count
       FROM user_vocab v JOIN words w ON w.id = v.word_id
       WHERE v.user_id = ? AND v.status='learning' AND v.next_review IS NOT NULL AND v.next_review <= ?`
    )
    .all(userId, todayStr()) as unknown as VocabRow[];
  return aggregateVocabRows(rows);
}

// ---------- 测试模式（T028，需求 §3.3 测试模式）----------
export type TestScope = "all" | "near" | "fail" | "mastered";

interface VocabPair {
  word_id: number;
  sentence_id: number;
  review_count: number;
  fail_count: number;
  status: string;
}

// 测试内容池抽取：按 scope 过滤，层内随机、层间优先级（near → fail → mastered(≤20%) → 其余 learning）
export function drawTestSentenceIds(
  db: DatabaseSync,
  userId: number,
  targetCount: number,
  scope: TestScope = "all"
): number[] {
  const pairs = db
    .prepare("SELECT word_id, sentence_id, review_count, fail_count, status FROM user_vocab WHERE user_id=?")
    .all(userId) as unknown as VocabPair[];
  if (scope === "all") {
    const near = pairs.filter((p) => p.status === "learning" && p.review_count >= MASTERY_THRESHOLD - 2);
    const fail = pairs.filter((p) => p.fail_count >= 2);
    const mastered = pairs.filter((p) => p.status === "mastered");
    const rest = pairs.filter((p) => !near.includes(p) && !fail.includes(p) && !mastered.includes(p));
    // 层内按句子去重，层间优先级填充
    const result: number[] = [];
    const seen = new Set<number>();
    const push = (ps: VocabPair[]) => {
      for (const p of ps) {
        if (seen.has(p.sentence_id)) continue;
        seen.add(p.sentence_id);
        result.push(p.sentence_id);
        if (result.length >= targetCount) return;
      }
    };
    push(sample(near, near.length));
    if (result.length < targetCount) push(sample(fail, fail.length));
    if (result.length < targetCount) push(sample(mastered, Math.min(mastered.length, Math.ceil(targetCount * 0.2))));
    if (result.length < targetCount) push(sample(rest, rest.length));
    return result.slice(0, targetCount);
  }
  // 指定 scope：过滤后去重句子随机抽
  const filtered = pairs.filter((p) => {
    if (scope === "near") return p.status === "learning" && p.review_count >= MASTERY_THRESHOLD - 2;
    if (scope === "fail") return p.fail_count >= 2;
    if (scope === "mastered") return p.status === "mastered";
    return true;
  });
  const sids = [...new Set(filtered.map((p) => p.sentence_id))];
  return sample(sids, targetCount);
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

  // 纯复习模式：只从生词本抽取（T027：到期优先）
  if (reviewOnly) {
    const due = getDueReviewSentenceIds(db, userId).filter((id) => !reported.has(id));
    const result = sample(due, targetCount);
    // 不足时从生词本其余句子补齐
    if (result.length < targetCount) {
      const fill = review.filter((id) => !result.includes(id));
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

export function startSession(db: DatabaseSync, userId: number, targetCount: number, mode = "practice"): number {
  const result = db
    .prepare("INSERT INTO practice_sessions (user_id, target_count, start_time, mode) VALUES (?, ?, ?, ?)")
    .run(userId, targetCount, new Date().toISOString(), mode);
  return result.lastInsertRowid as number;
}

export function finishSession(db: DatabaseSync, sessionId: number, doneCount: number, totalMs: number): void {
  db.prepare(
    "UPDATE practice_sessions SET end_time = ?, done_count = ?, total_ms = ? WHERE id = ?"
  ).run(new Date().toISOString(), doneCount, totalMs, sessionId);
}

// 记录单词结果：mastered → 词句对间隔推进（达阈值标掌握）；hint → 入本/重置。始终写 test_records。
// T027：不再「整句拼对即移除」，掌握判定由词句对连续成功驱动（§3.2.3）
export function recordWord(
  db: DatabaseSync,
  sessionId: number,
  userId: number,
  wordId: number,
  sentenceId: number,
  result: WordResult
): void {
  const now = new Date().toISOString();
  if (result === "mastered") {
    const pair = db
      .prepare("SELECT interval, review_count, status FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?")
      .get(userId, wordId, sentenceId) as { interval: number; review_count: number; status: string } | undefined;
    if (pair) {
      // 词句对推进：间隔前进、连续成功 +1，达阈值标 mastered
      const { interval, reviewCount } = advanceInterval(pair.review_count, true);
      const mastered = reviewCount >= MASTERY_THRESHOLD;
      db.prepare(
        "UPDATE user_vocab SET interval=?, review_count=?, next_review=?, status=? WHERE user_id=? AND word_id=? AND sentence_id=?"
      ).run(interval, reviewCount, addDays(interval), mastered ? "mastered" : "learning", userId, wordId, sentenceId);
    }
    // 统计展示（word_status，与生词本判定独立）
    db.prepare(
      `INSERT INTO word_status (user_id, word_id, status, updated_at) VALUES (?, ?, 'mastered', ?)
       ON CONFLICT(user_id, word_id) DO UPDATE SET status='mastered', updated_at=excluded.updated_at`
    ).run(userId, wordId, now);
  } else if (result === "test_fail") {
    // 测试失败：降级（§3.2.5）——回 learning、间隔重置、错误频次 +1
    db.prepare(
      "UPDATE user_vocab SET status='learning', interval=1, review_count=0, fail_count=fail_count+1 WHERE user_id=? AND word_id=? AND sentence_id=?"
    ).run(userId, wordId, sentenceId);
  } else {
    // hint：入本（如不在）+ 重置间隔（失败语义，§3.2.3）
    db.prepare(
      "INSERT OR IGNORE INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status) VALUES (?, ?, ?, ?, 1, 0, ?, 'learning')"
    ).run(userId, wordId, sentenceId, now, addDays(1));
    db.prepare(
      "UPDATE user_vocab SET interval=1, review_count=0, next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?"
    ).run(addDays(1), userId, wordId, sentenceId);
  }
  db.prepare(
    "INSERT INTO test_records (session_id, user_id, word_id, sentence_id, time, result) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(sessionId, userId, wordId, sentenceId, now, result);
}

export interface WordOutcome {
  wordId: number;
  result: WordResult;
}

// 整句完成：逐词落库（recordWord 按词句对推进间隔/重置，达阈值标掌握）
// T027：掌握判定由词句对连续成功驱动，不再「整句拼对即整句删除」
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