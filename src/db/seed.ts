// 句子池落库（T006 实现）
import fs from "fs";
import type { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "../db.js";
import { SentencePool } from "../types.js";
import { SCHEMA_SQL } from "./schema.js";

export function needsSeed(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT COUNT(*) AS c FROM sentences").get() as { c: number };
  return row.c === 0;
}

export function seedFromJson(db: DatabaseSync, poolPath: string): number {
  const raw = JSON.parse(fs.readFileSync(poolPath, "utf-8")) as SentencePool;
  db.exec("BEGIN");
  try {
    // 整体重建（幂等）：清空关联与句子，词表只增不删
    db.exec("DELETE FROM sentence_words; DELETE FROM sentences;");
    // words：全量 token 去重建词，freq=出现句数，is_name 人名词标记
    const wordFreq = new Map<string, { freq: number; isName: boolean }>();
    for (const s of raw.sentences) {
      const seen = new Set<string>();
      for (const t of s.tokens) {
        if (seen.has(t.word)) continue;
        seen.add(t.word);
        const cur = wordFreq.get(t.word);
        if (cur) cur.freq += 1;
        else wordFreq.set(t.word, { freq: 1, isName: t.type === "name" });
      }
    }
    const insWord = db.prepare(
      "INSERT INTO words (word, freq, is_name) VALUES (?, ?, ?) ON CONFLICT(word) DO UPDATE SET freq = freq + excluded.freq, is_name = MAX(is_name, excluded.is_name)"
    );
    const wordIds = new Map<string, number>();
    for (const [w, info] of wordFreq) {
      insWord.run(w, info.freq, info.isName ? 1 : 0);
      const row = db.prepare("SELECT id FROM words WHERE word = ?").get(w) as { id: number };
      wordIds.set(w, row.id);
    }

    // sentences + sentence_words
    const insSent = db.prepare(
      "INSERT OR IGNORE INTO sentences (en, zh, round, topic, section, source) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insSW = db.prepare(
      "INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?, ?, ?, ?)"
    );
    let count = 0;
    for (const s of raw.sentences) {
      insSent.run(s.en, s.zh, s.round, s.topic, s.section, "grammar");
      const srow = db.prepare("SELECT id FROM sentences WHERE en = ?").get(s.en) as { id: number };
      const boldSet = new Set(s.bold);
      s.tokens.forEach((t, idx) => {
        insSW.run(srow.id, wordIds.get(t.word)!, idx, boldSet.has(t.word) ? 1 : 0);
      });
      count += 1;
    }
    db.exec("COMMIT");
    return count;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function seedIfEmpty(db: DatabaseSync, poolPath = "res/sentence_pool.json"): number {
  if (!needsSeed(db)) return 0;
  return seedFromJson(db, poolPath);
}
