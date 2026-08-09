// 生词本 + 已掌握 数据层（T008）
// 所有函数强制带 userId，SQL 必含 user_id 条件，杜绝跨用户访问。
import type { DatabaseSync } from "node:sqlite";

export interface VocabRow {
  user_id: number;
  word_id: number;
  sentence_id: number;
  word: string;
  en: string;
  zh: string;
  created_at: string | null;
}

// 入生词本（唯一途径：提示词）。幂等：同句同词不重复。
export function addVocab(db: DatabaseSync, userId: number, wordId: number, sentenceId: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO user_vocab (user_id, word_id, sentence_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(userId, wordId, sentenceId, new Date().toISOString());
}

// 移除该句下所有词句对（需求 §3.2.3：抽中句整句拼对 → 该句所有词句对一并移除）
export function removeVocabBySentence(db: DatabaseSync, userId: number, sentenceId: number): void {
  db.prepare("DELETE FROM user_vocab WHERE user_id = ? AND sentence_id = ?").run(userId, sentenceId);
}

// 移除单条词句对（按需）
export function removeVocab(db: DatabaseSync, userId: number, wordId: number, sentenceId: number): void {
  db.prepare("DELETE FROM user_vocab WHERE user_id = ? AND word_id = ? AND sentence_id = ?").run(
    userId, wordId, sentenceId
  );
}

// 该用户生词本全部条目（join 词与句，可展示）
export function getUserVocab(db: DatabaseSync, userId: number): VocabRow[] {
  return db
    .prepare(
      `SELECT uv.user_id, uv.word_id, uv.sentence_id, uv.created_at,
              w.word, s.en, s.zh
       FROM user_vocab uv
       JOIN words w ON w.id = uv.word_id
       JOIN sentences s ON s.id = uv.sentence_id
       WHERE uv.user_id = ?
       ORDER BY uv.created_at DESC, uv.word_id`
    )
    .all(userId) as unknown as VocabRow[];
}

// 生词本涉及的句子 id（去重），供抽取池使用
export function getVocabSentenceIds(db: DatabaseSync, userId: number): number[] {
  const rows = db
    .prepare("SELECT DISTINCT sentence_id FROM user_vocab WHERE user_id = ?")
    .all(userId) as { sentence_id: number }[];
  return rows.map((r) => r.sentence_id);
}

// 已掌握（upsert；仅统计展示，不参与抽取）
export function markMastered(db: DatabaseSync, userId: number, wordId: number): void {
  db.prepare(
    `INSERT INTO word_status (user_id, word_id, status, updated_at) VALUES (?, ?, 'mastered', ?)
     ON CONFLICT(user_id, word_id) DO UPDATE SET status='mastered', updated_at=excluded.updated_at`
  ).run(userId, wordId, new Date().toISOString());
}

export function getMastered(db: DatabaseSync, userId: number): { word_id: number }[] {
  return db
    .prepare("SELECT word_id FROM word_status WHERE user_id = ? AND status = 'mastered'")
    .all(userId) as { word_id: number }[];
}

export function getMasteredCount(db: DatabaseSync, userId: number): number {
  const r = db
    .prepare("SELECT COUNT(*) AS c FROM word_status WHERE user_id = ? AND status = 'mastered'")
    .get(userId) as { c: number };
  return r.c;
}
// T046：已掌握词句对（掌握词墙展示）
export function getMasteredVocab(db: DatabaseSync, userId: number): VocabRow[] {
  return db
    .prepare(
      `SELECT uv.user_id, uv.word_id, uv.sentence_id, uv.created_at,
              w.word, s.en, s.zh
       FROM user_vocab uv
       JOIN words w ON w.id = uv.word_id
       JOIN sentences s ON s.id = uv.sentence_id
       WHERE uv.user_id = ? AND uv.status = 'mastered'
       ORDER BY uv.created_at DESC, uv.word_id`
    )
    .all(userId) as unknown as VocabRow[];
}
