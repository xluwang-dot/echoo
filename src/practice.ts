// 练习核心：抽取 + 会话 + 结果落库（T009）
// 数据层 + 业务逻辑（无 HTTP）；判定纯函数在 checker.ts。
import type { DatabaseSync } from "node:sqlite";
import { getVocabSentenceIds } from "./vocab.js"; // T071：生词本句集复用（同查询不写两遍）

export type WordResult = "mastered" | "hint" | "test_fail";

export interface SentenceWithTokens {
  id: number;
  en: string;
  zh: string;
  is_word_only: boolean; // T069：单词占位句（复习显示听音拼写）
  prev_en: string | null; // T058：课内上一句（对话语境提示）
  next_en: string | null; // T058：课内下一句（问句时提示答句）
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

// T069：含人名词（is_name=1）的句子——练习/复习/测试抽句统一过滤（人名不练拼写）
export function getNameSentenceIds(db: DatabaseSync): Set<number> {
  const rows = db
    .prepare(
      "SELECT DISTINCT sw.sentence_id FROM sentence_words sw JOIN words w ON w.id = sw.word_id WHERE w.is_name = 1"
    )
    .all() as { sentence_id: number }[];
  return new Set(rows.map((r) => r.sentence_id));
}

// T071：句子等级 map（一次查询，抽句多分支复用——避免 start 时 4 次全表扫）
function getSentenceLevelMap(db: DatabaseSync): Map<number, number | null> {
  const m = new Map<number, number | null>();
  for (const r of db.prepare("SELECT id, level FROM sentences").all() as { id: number; level: number | null }[]) {
    m.set(r.id, r.level);
  }
  return m;
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
// T071：与 vocab.getVocabSentenceIds 同查询——委托复用，避免两处实现漂移
export function getReviewSentenceIds(db: DatabaseSync, userId: number): number[] {
  return getVocabSentenceIds(db, userId);
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
export function addDays(days: number): string {
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
  status: "learning" | "candidate" | "mastered"; // T040：candidate=待测试验收
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
        status: r.status === "mastered" ? "mastered" : r.status === "candidate" ? "candidate" : "learning",
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
export type TestScope = "all" | "near" | "fail" | "mastered" | "levelup"; // T053b

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
    // T040：candidate（待测试验收）最高优先级，其次 near/fail/mastered(≤20%)/rest
    const candidate = pairs.filter((p) => p.status === "candidate");
    const near = pairs.filter((p) => p.status === "learning" && p.review_count >= MASTERY_THRESHOLD - 2);
    const fail = pairs.filter((p) => p.fail_count >= 2);
    const mastered = pairs.filter((p) => p.status === "mastered");
    const rest = pairs.filter(
      (p) => !candidate.includes(p) && !near.includes(p) && !fail.includes(p) && !mastered.includes(p)
    );
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
    push(sample(candidate, candidate.length));
    if (result.length < targetCount) push(sample(near, near.length));
    if (result.length < targetCount) push(sample(fail, fail.length));
    if (result.length < targetCount) push(sample(mastered, Math.min(mastered.length, Math.ceil(targetCount * 0.2))));
    if (result.length < targetCount) push(sample(rest, rest.length));
    return result.slice(0, targetCount);
  }
  // 指定 scope：过滤后去重句子随机抽
  const filtered = pairs.filter((p) => {
    if (scope === "near") return p.status === "candidate" || (p.status === "learning" && p.review_count >= MASTERY_THRESHOLD - 2);
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
  includeSentenceIds?: number[]; // T037：复习模式必含的句子（立即复习：当前练习入本句子）
  level?: number; // T053a：用户等级（1=纯1级；>1=与上一级混合 1:1）
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
  const named = getNameSentenceIds(db); // T069：人名句统一过滤
  const lvMap = getSentenceLevelMap(db); // T071：等级 map 一次查询（多分支复用）
  let untested = getUntestedSentenceIds(db, userId).filter((id) => !reported.has(id) && !named.has(id));
  const review = getReviewSentenceIds(db, userId).filter((id) => !reported.has(id) && !named.has(id));
  const tested = getTestedSentenceIds(db, userId).filter((id) => !reported.has(id) && !named.has(id));

  // T053a：按用户等级过滤未测试池（混合模式）
  const level = config.level ?? 0;
  if (level >= 1) {
    const lvOf = (id: number) => lvMap.get(id); // null=通用句（放行）
    const okLv = (id: number, lv: number) => lvOf(id) === null || lvOf(id) === lv;
    if (level === 1) {
      untested = untested.filter((id) => okLv(id, 1)); // 纯 1 级（含通用句）
    } else {
      // 混合：level-1 未测试句优先（1:1），耗尽转纯 level
      const prevUntested = untested.filter((id) => okLv(id, level - 1));
      const curUntested = untested.filter((id) => okLv(id, level));
      untested = [...prevUntested, ...curUntested]; // prev 优先，抽完自然转纯 level
    }
  }

  // 纯复习模式：只从生词本抽取（T027：到期优先；T037：include 必含）
  // T068：复习不规避报告句——词已入生词本必须能复习（报告规避只用于新句池，防抽到问题新内容）
  if (reviewOnly) {
    const reviewAll = getReviewSentenceIds(db, userId); // 生词本全量（含报告句）
    const due = getDueReviewSentenceIds(db, userId);
    // T037：include 句（在生词本内）必含——立即复习必须包含当前练习入本句子，即使未到期
    const include = (config.includeSentenceIds ?? []).filter((id) => reviewAll.includes(id));
    const result = include.slice(0, targetCount);
    // 再从到期队列补足（避免与 include 重复）
    for (const id of due) {
      if (result.length >= targetCount) break;
      if (!result.includes(id)) result.push(id);
    }
    // 不足时从生词本其余句子补齐
    if (result.length < targetCount) {
      const fill = reviewAll.filter((id) => !result.includes(id));
      for (const id of fill) {
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
  // T053a：混合模式 1:1 —— prev 未测试句与 cur 新句各取一半
  if (level > 1) {
    const lvOf = (id: number) => lvMap.get(id);
    const okLv = (id: number, lv: number) => lvOf(id) === null || lvOf(id) === lv;
    const prevHalf = sample(untested.filter((id) => okLv(id, level - 1)), Math.ceil(newCount / 2));
    const curHalf = sample(untested.filter((id) => okLv(id, level)), Math.floor(newCount / 2));
    if (prevHalf.length > 0) {
      // prev 未测试句充足 → 1:1 混合；不足则 cur 补满
      fromNew = [...prevHalf, ...curHalf].slice(0, newCount);
      if (prevHalf.length < Math.ceil(newCount / 2)) {
        const more = sample(untested.filter((id) => lvOf(id) === level && !fromNew.includes(id)), newCount - fromNew.length);
        fromNew = [...fromNew, ...more];
      }
    }
  }
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
  // T053a：补齐池同样按等级过滤（用户只练已解锁级别）
  const inLevelPool = level >= 1 ? (() => {
    const lvOf = (id: number) => lvMap.get(id); // T071：复用顶部一次查询
    const okLv = (id: number, lv: number) => lvOf(id) === null || lvOf(id) === lv;
    return {
      // 新句/生词本：混合级别（level-1 + level）
      mixed: (id: number) => (level === 1 ? okLv(id, 1) : okLv(id, level - 1) || okLv(id, level)),
      // 已测试补齐：仅当前级（T053a：上一级已测试句不重复练习，实现「1 级抽完转纯」）
      testedOnly: (id: number) => okLv(id, level),
    };
  })() : null;
  const filterLv = (ids: number[], fn?: (id: number) => boolean) =>
    inLevelPool ? ids.filter(fn ?? inLevelPool.mixed) : ids;
  const fillNew = filterLv(untested.filter((id) => !seen.has(id)));
  const fillReview = filterLv(review.filter((id) => !seen.has(id)));
  const fillTested = filterLv(tested.filter((id) => !seen.has(id)), inLevelPool ? inLevelPool.testedOnly : undefined);
  const fillReported = [...reported].filter((id) => !seen.has(id));
  for (const id of [...fillNew, ...fillReview, ...fillTested, ...fillReported]) {
    if (result.length >= targetCount) break;
    seen.add(id);
    result.push(id);
  }

  // 极端兜底：池总数仍不足 target 时循环复用（需求：不再出现无题可练）
  // T053a：等级模式下兜底不跨级（用户只练已解锁级别）
  let allPool = [
    ...new Set([
      ...untested,
      ...review,
      ...tested,
      ...(db.prepare("SELECT id FROM sentences").all() as { id: number }[]).map((r) => r.id),
    ]),
  ];
  if (inLevelPool) {
    // 兜底仅当前级（1 级已测试句不重复练习，实现「抽完转纯」）
    allPool = allPool.filter(inLevelPool.testedOnly);
  }
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
// T071：事务包裹（中途异常回滚，保证落库一致性）
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// T064：返回处理后 status（mastered 分支），供 completeSentence 判定掌握推进，避免重复查询
export function recordWord(
  db: DatabaseSync,
  sessionId: number,
  userId: number,
  wordId: number,
  sentenceId: number,
  result: WordResult
): string | null {
  const now = new Date().toISOString();
  // T069：真实句覆盖占位句（进度合并，删占位句记录）——占位句自身不触发
  const sentRow = db.prepare("SELECT is_word_only FROM sentences WHERE id=?").get(sentenceId) as { is_word_only: number } | undefined;
  if (sentRow && !sentRow.is_word_only) {
    mergePlaceholderToReal(db, userId, wordId, sentenceId);
  }
  // 结果流水：所有分支必写（T064 重构后提前 return 也不丢失）
  db.prepare(
    "INSERT INTO test_records (session_id, user_id, word_id, sentence_id, time, result) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(sessionId, userId, wordId, sentenceId, now, result);
  if (result === "mastered") {
    const pair = db
      .prepare("SELECT interval, review_count, status, next_review FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?")
      .get(userId, wordId, sentenceId) as { interval: number; review_count: number; status: string; next_review: string | null } | undefined;
    if (pair) {
      if (pair.status === "candidate") {
        // T040：待测试候选 → 测试模式验收通过 → 掌握（间隔不推进）
        db.prepare("UPDATE user_vocab SET status='mastered' WHERE user_id=? AND word_id=? AND sentence_id=?")
          .run(userId, wordId, sentenceId);
        db.prepare(
          "INSERT INTO word_status (user_id, word_id, status, updated_at) VALUES (?, ?, 'mastered', ?)"
            + " ON CONFLICT(user_id, word_id) DO UPDATE SET status='mastered', updated_at=excluded.updated_at"
        ).run(userId, wordId, now);
        return "mastered";
      } else {
        // T039：到期复习成功才推进（SM 时间语义）；未到期/同日重复只巩固、不推进
        const due = pair.next_review === null || pair.next_review <= todayStr();
        if (due) {
          const { interval, reviewCount } = advanceInterval(pair.review_count, true);
          // T040：达阈值 → candidate（待测试验收），不再直接 mastered
          const status = reviewCount >= MASTERY_THRESHOLD ? "candidate" : "learning";
          db.prepare(
            "UPDATE user_vocab SET interval=?, review_count=?, next_review=?, status=? WHERE user_id=? AND word_id=? AND sentence_id=?"
          ).run(interval, reviewCount, addDays(interval), status, userId, wordId, sentenceId);
          db.prepare(
            "INSERT INTO word_status (user_id, word_id, status, updated_at) VALUES (?, ?, ?, ?)"
              + " ON CONFLICT(user_id, word_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at"
          ).run(userId, wordId, status, now);
          return status;
        }
        // 未到期：不推进（但结果仍记统计——word_status 'mastered'）
        db.prepare(
          "INSERT INTO word_status (user_id, word_id, status, updated_at) VALUES (?, ?, 'mastered', ?)"
            + " ON CONFLICT(user_id, word_id) DO UPDATE SET status='mastered', updated_at=excluded.updated_at"
        ).run(userId, wordId, now);
        return pair.status;
      }
    }
    // 无词句对记录（理论上 mastered 结果必有记录）：仍记 word_status
    db.prepare(
      "INSERT INTO word_status (user_id, word_id, status, updated_at) VALUES (?, ?, 'mastered', ?)"
        + " ON CONFLICT(user_id, word_id) DO UPDATE SET status='mastered', updated_at=excluded.updated_at"
    ).run(userId, wordId, now);
    return null;
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
  return null;
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
): number[] {
  // T045：返回本次新标记 mastered 的词（candidate → mastered，用于前端掌握特效）
  const masteredWordIds: number[] = [];
  return withTransaction(db, () => {
    for (const o of outcomes) {
      const after = recordWord(db, sessionId, userId, o.wordId, sentenceId, o.result);
      // T064：recordWord 已返回处理后 status——candidate → mastered 视为本次新掌握
      if (o.result === "mastered" && after === "mastered") masteredWordIds.push(o.wordId);
    }
    return masteredWordIds;
  });
}

// T045：当前已掌握词句对总数（里程碑判定用）
export function getMasteryCount(db: DatabaseSync, userId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM user_vocab WHERE user_id=? AND status='mastered'")
    .get(userId) as { c: number };
  return row.c;
}

// 取句子 + tokens（供前端渲染与判定）
// userId 可选：传入时计算每个词的 in_vocab 状态（复习模式用）
export function getSentenceWithTokens(db: DatabaseSync, sentenceId: number, userId?: number): SentenceWithTokens | undefined {
  const s = db.prepare("SELECT id, en, zh, prev_en, next_en, is_word_only FROM sentences WHERE id = ?").get(sentenceId) as
    | { id: number; en: string; zh: string; prev_en: string | null; next_en: string | null; is_word_only: number | null }
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

  // 句子原文词（保留大小写，如 I'm/English——words 表统一小写关联）
  const enTokens = s.en.match(/[a-zA-Z]+(?:['’][a-zA-Z]+)*['’]*/g) ?? [];
  return {
    id: s.id,
    en: s.en,
    zh: s.zh,
    is_word_only: s.is_word_only === 1, // T069
    prev_en: s.prev_en, // T058：上一句（对话语境提示）
    next_en: s.next_en, // T058：下一句
    tokens: rows.map((r) => ({
      word_id: r.word_id,
      word: enTokens[r.position] ?? r.word, // B0009：用原文大小写（I'm 而非 i'm）
      is_name: r.is_name,
      is_bold: r.is_bold,
      in_vocab: vocabWordIds.has(r.word_id),
    })),
  };
}
// ---------- 句子级别派生（T047b：句中最高词级）----------
export function computeSentenceLevel(db: DatabaseSync, sentenceId: number): number | null {
  const row = db
    .prepare(
      `SELECT MAX(w.level) AS lv FROM sentence_words sw JOIN words w ON w.id = sw.word_id
       WHERE sw.sentence_id = ?`
    )
    .get(sentenceId) as { lv: number | null } | undefined;
  return row?.lv ?? null;
}

// 全量重算所有句子的 level（词级别变更/新句导入后调用）
export function recomputeAllSentenceLevels(db: DatabaseSync): number {
  const rows = db
    .prepare(
      `SELECT sw.sentence_id, MAX(w.level) AS lv FROM sentence_words sw
       JOIN words w ON w.id = sw.word_id GROUP BY sw.sentence_id`
    )
    .all() as { sentence_id: number; lv: number }[];
  const upd = db.prepare("UPDATE sentences SET level = ? WHERE id = ?");
  for (const r of rows) upd.run(r.lv, r.sentence_id);
  return rows.length;
}

// ---------- 用户等级（T053a）----------
export function getUserLevel(db: DatabaseSync, userId: number): number {
  const row = db.prepare("SELECT level FROM users WHERE id = ?").get(userId) as { level: number } | undefined;
  return row?.level ?? 1;
}

// 升级解锁：level 1~4
export function updateUserLevel(db: DatabaseSync, userId: number, level: number): void {
  db.prepare("UPDATE users SET level = ? WHERE id = ?").run(level, userId);
}

// ---------- 升级测试（T053b）----------
// 最近 N 轮练习（mode=practice）的句子正确率：句子正确 = 句内所有词 result=mastered
export function getRecentPracticeAccuracy(db: DatabaseSync, userId: number, rounds = 3): number[] {
  const sessions = db
    .prepare(
      "SELECT id FROM practice_sessions WHERE user_id=? AND mode='practice' ORDER BY id DESC LIMIT ?"
    )
    .all(userId, rounds) as { id: number }[];
  const accs: number[] = [];
  for (const s of sessions.reverse()) {
    const recs = db
      .prepare("SELECT sentence_id, result FROM test_records WHERE session_id=?")
      .all(s.id) as { sentence_id: number; result: string }[];
    const bySent = new Map<number, string[]>();
    for (const r of recs) {
      const arr = bySent.get(r.sentence_id) ?? [];
      arr.push(r.result);
      bySent.set(r.sentence_id, arr);
    }
    const correct = [...bySent.values()].filter((rs) => rs.every((x) => x === "mastered")).length;
    accs.push(bySent.size ? correct / bySent.size : 0);
  }
  return accs;
}

// 升级测试邀请：最近 3 轮全部 ≥80%
export function isLevelTestReady(db: DatabaseSync, userId: number, rounds = 3, threshold = 0.8): boolean {
  const accs = getRecentPracticeAccuracy(db, userId, rounds);
  return accs.length >= rounds && accs.every((a) => a >= threshold);
}

// 升级测试抽句：①当前级未练习 → ②未掌握词句对 → ③全掌握自动解锁下一级并抽下一级
export function drawLevelupSentenceIds(
  db: DatabaseSync,
  userId: number,
  targetCount: number
): { sentenceIds: number[]; autoLevelUp: boolean } {
  const level = getUserLevel(db, userId);
  const lvMap = getSentenceLevelMap(db); // T071：一次查询
  const lvOf = (id: number) => lvMap.get(id) ?? null;
  // ① 当前级未练习句
  const untested = getUntestedSentenceIds(db, userId).filter((id) => lvOf(id) === level);
  if (untested.length > 0) {
    return { sentenceIds: sample(untested, targetCount), autoLevelUp: false };
  }
  // ② 当前级未掌握词句对（user_vocab learning）
  const learning = db
    .prepare(
      `SELECT DISTINCT v.sentence_id FROM user_vocab v
       JOIN words w ON w.id = v.word_id
       WHERE v.user_id=? AND v.status='learning' AND w.level=?`
    )
    .all(userId, level) as { sentence_id: number }[];
  if (learning.length > 0) {
    return { sentenceIds: sample(learning.map((r) => r.sentence_id), targetCount), autoLevelUp: false };
  }
  // ③ 全掌握 → 自动解锁下一级 + 抽下一级句
  if (level < 4) {
    updateUserLevel(db, userId, level + 1);
    const next = db
      .prepare("SELECT id FROM sentences WHERE level = ?")
      .all(level + 1) as { id: number }[];
    return { sentenceIds: sample(next.map((r) => r.id), targetCount), autoLevelUp: true };
  }
  return { sentenceIds: [], autoLevelUp: false };
}

// 升级测试通过判定：该 session 句子正确率 ≥60%
export function isLevelUpPassed(db: DatabaseSync, sessionId: number, threshold = 0.6): boolean {
  const recs = db
    .prepare("SELECT sentence_id, result FROM test_records WHERE session_id=?")
    .all(sessionId) as { sentence_id: number; result: string }[];
  const bySent = new Map<number, string[]>();
  for (const r of recs) {
    const arr = bySent.get(r.sentence_id) ?? [];
    arr.push(r.result);
    bySent.set(r.sentence_id, arr);
  }
  if (bySent.size === 0) return false;
  const correct = [...bySent.values()].filter((rs) => rs.every((x) => x === "mastered")).length;
  return correct / bySent.size >= threshold;
}

// ---------- T069 单词听写 ----------
// 用户等级 → 册课号范围（全局课号 1-276：册1=1-72 册2=73-168 册3=169-228 册4=229-276）
export const LEVEL_LESSON_RANGE: Record<number, [number, number]> = {
  1: [1, 72],
  2: [73, 168],
  3: [169, 228],
  4: [229, 276],
};

// 听写时间参数（可配置：env DICTATION_REPLAY2/REPLAY3/REVEAL，单位 ms）
export const DICTATION_TIMING = {
  replay2: Number(process.env.DICTATION_REPLAY2 ?? 10000), // 第二次播报 + 音标（10s）
  replay3: Number(process.env.DICTATION_REPLAY3 ?? 20000), // 第三次播报（20s）
  reveal: Number(process.env.DICTATION_REVEAL ?? 30000),   // 揭示拼写 + 标记不会（30s，此后等回车）
};

// 占位句幂等创建（en=单词, zh=词义, is_word_only=1）
export function getOrCreateWordSentence(db: DatabaseSync, wordId: number): number {
  const w = db
    .prepare("SELECT word, meaning, level FROM words WHERE id=?")
    .get(wordId) as { word: string; meaning: string | null; level: number | null } | undefined;
  if (!w) throw new Error(`词不存在 id=${wordId}`);
  const exist = db
    .prepare("SELECT id FROM sentences WHERE en=? AND is_word_only=1")
    .get(w.word) as { id: number } | undefined;
  if (exist) return exist.id;
  const sid = db
    .prepare("INSERT INTO sentences (en, zh, level, is_word_only) VALUES (?, ?, ?, 1)")
    .run(w.word, w.meaning ?? "", w.level ?? 5).lastInsertRowid as number;
  db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?, ?, 0, 0)").run(sid, wordId);
  return sid;
}

// 听写游标：扫描位置（课号 + 课内位置）
export function getDictationCursor(db: DatabaseSync, userId: number): { lessonNo: number; lessonPos: number } {
  const row = db
    .prepare("SELECT lesson_no, lesson_pos FROM dictation_cursor WHERE user_id=?")
    .get(userId) as { lesson_no: number; lesson_pos: number } | undefined;
  return row ? { lessonNo: row.lesson_no, lessonPos: row.lesson_pos } : { lessonNo: 0, lessonPos: 0 };
}

function saveDictationCursor(db: DatabaseSync, userId: number, lessonNo: number, lessonPos: number): void {
  db.prepare(
    "INSERT INTO dictation_cursor (user_id, lesson_no, lesson_pos, updated_at) VALUES (?, ?, ?, ?)" +
      " ON CONFLICT(user_id) DO UPDATE SET lesson_no=excluded.lesson_no, lesson_pos=excluded.lesson_pos, updated_at=excluded.updated_at"
  ).run(userId, lessonNo, lessonPos, new Date().toISOString());
}

// 新一轮：清已听写标记 + 游标归零
function resetDictationProgress(db: DatabaseSync, userId: number): void {
  db.prepare("DELETE FROM dictation_done WHERE user_id=?").run(userId);
  saveDictationCursor(db, userId, 0, 0);
}

// 抽听写词：游标后 + 册范围 + 未入本 + 未掌握 + 未听写 + 有音频 → 按课序
function fetchDictationWords(
  db: DatabaseSync,
  userId: number,
  level: number,
  cur: { lessonNo: number; lessonPos: number },
  count: number
): { id: number; lesson_no: number; lesson_pos: number }[] {
  return db
    .prepare(
      `SELECT id, lesson_no, lesson_pos FROM words
       WHERE level = ? AND is_name = 0 AND audio_path IS NOT NULL AND audio_path != ''
         AND meaning IS NOT NULL AND meaning != '' AND phonetic IS NOT NULL AND phonetic != ''
         AND (lesson_no > ? OR (lesson_no = ? AND lesson_pos > ?))
         AND NOT EXISTS (SELECT 1 FROM user_vocab uv WHERE uv.user_id = ? AND uv.word_id = words.id)
         AND NOT EXISTS (SELECT 1 FROM dictation_done dd WHERE dd.user_id = ? AND dd.word_id = words.id)
         AND NOT EXISTS (SELECT 1 FROM word_status ws WHERE ws.user_id = ? AND ws.word_id = words.id AND ws.status = 'mastered')
       ORDER BY lesson_no, lesson_pos
       LIMIT ?`
    )
    .all(level, cur.lessonNo, cur.lessonNo, cur.lessonPos, userId, userId, userId, count) as {
    id: number;
    lesson_no: number;
    lesson_pos: number;
  }[];
}

// 听写抽句：返回占位句 id 列表；全册扫完自动重置新一轮
export function drawDictationSentenceIds(db: DatabaseSync, userId: number, count: number, level: number = 1): number[] {
  let words = fetchDictationWords(db, userId, level, getDictationCursor(db, userId), count);
  if (words.length < count) {
    // 本轮扫完：重置（done 清空 + 游标归零）→ 从头再扫
    resetDictationProgress(db, userId);
    words = fetchDictationWords(db, userId, level, { lessonNo: 0, lessonPos: 0 }, count);
  }
  if (words.length > 0) {
    const last = words[words.length - 1];
    saveDictationCursor(db, userId, last.lesson_no, last.lesson_pos);
    for (const w of words) {
      db.prepare("INSERT OR IGNORE INTO dictation_done (user_id, word_id, time) VALUES (?, ?, ?)").run(
        userId, w.id, new Date().toISOString()
      );
    }
  }
  return words.map((w) => getOrCreateWordSentence(db, w.id));
}

// 真实句覆盖占位句：进度合并（取较优者），删占位句记录——两者永不共存
function mergePlaceholderToReal(db: DatabaseSync, userId: number, wordId: number, realSentenceId: number): void {
  const ph = db
    .prepare(
      `SELECT s.id AS sid, uv.interval, uv.review_count, uv.status, uv.next_review
       FROM sentences s
       JOIN sentence_words sw ON sw.sentence_id = s.id AND sw.word_id = ?
       JOIN user_vocab uv ON uv.sentence_id = s.id AND uv.user_id = ? AND uv.word_id = ?
       WHERE s.is_word_only = 1`
    )
    .get(wordId, userId, wordId) as
    | { sid: number; interval: number; review_count: number; status: string; next_review: string | null }
    | undefined;
  if (!ph) return;
  const real = db
    .prepare("SELECT interval, review_count, status, next_review FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?")
    .get(userId, wordId, realSentenceId) as
    | { interval: number; review_count: number; status: string; next_review: string | null }
    | undefined;
  const better = (a: string, b: string): string => (a === "mastered" ? a : b === "mastered" ? b : a === "candidate" ? a : b);
  if (real) {
    db.prepare(
      "UPDATE user_vocab SET interval=?, review_count=?, status=?, next_review=? WHERE user_id=? AND word_id=? AND sentence_id=?"
    ).run(
      Math.max(real.interval, ph.interval),
      Math.max(real.review_count, ph.review_count),
      better(real.status, ph.status),
      real.next_review ?? ph.next_review,
      userId, wordId, realSentenceId
    );
  } else {
    db.prepare(
      "INSERT INTO user_vocab (user_id, word_id, sentence_id, created_at, interval, review_count, next_review, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(userId, wordId, realSentenceId, new Date().toISOString(), ph.interval, ph.review_count, ph.next_review, ph.status);
  }
  db.prepare("DELETE FROM user_vocab WHERE user_id=? AND word_id=? AND sentence_id=?").run(userId, wordId, ph.sid);
}
