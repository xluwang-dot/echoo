// 数据库连接与初始化（平台启动时调用）
import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./db/schema.js";
import { WORD_LESSONS } from "./data/wordLessons.js";

export const DATA_DIR = path.join(import.meta.dirname, "..", "data");
export const DB_PATH = path.join(DATA_DIR, "word_typer.db");

let db: DatabaseSync | null = null;
let dbPath: string | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error("数据库未初始化，请先调用 initDb()");
  return db;
}

// 建库（幂等）：目录 + 建表 + 外键开启
// 轻量迁移：旧库缺失列时自动 ALTER 补列（幂等）
//   T020：sentence_reports.description
//   T026：user_vocab.interval/review_count/next_review/status；practice_sessions.mode
const MIGRATIONS: [string, string, string][] = [
  ["sentence_reports", "description", "TEXT"],
  ["user_vocab", "interval", "INTEGER DEFAULT 1"],
  ["user_vocab", "review_count", "INTEGER DEFAULT 0"],
  ["user_vocab", "next_review", "TEXT"],
  ["user_vocab", "status", "TEXT DEFAULT 'learning'"],
  ["user_vocab", "fail_count", "INTEGER DEFAULT 0"],
  ["practice_sessions", "mode", "TEXT DEFAULT 'practice'"],
  // T047a：内容分级与词语音字段
  ["words", "level", "INTEGER DEFAULT 5"],
  ["words", "meaning", "TEXT"],
  ["words", "phonetic", "TEXT"],
  ["words", "audio_path", "TEXT"],
  ["sentences", "level", "INTEGER"],
  // T053a：用户等级
  ["users", "level", "INTEGER DEFAULT 1"],
  ["sentences", "prev_en", "TEXT"], // T058
  ["sentences", "next_en", "TEXT"], // T058
  // T069：听写课序 + 占位句标记
  ["words", "lesson_no", "INTEGER"],
  ["words", "lesson_pos", "INTEGER"],
  ["sentences", "is_word_only", "INTEGER DEFAULT 0"],
  // T074：用户角色/状态/强制改密
  ["users", "role", "TEXT DEFAULT 'user'"],
  ["users", "status", "TEXT DEFAULT 'active'"],
  ["users", "must_change_password", "INTEGER DEFAULT 0"],
];

function migrate(db: DatabaseSync): void {
  for (const [table, col, ddl] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  }
  // T065：高频查询索引（须在 ALTER 补列之后，旧库缺列时建索引会失败）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_vocab_user_status ON user_vocab(user_id, status);
           CREATE INDEX IF NOT EXISTS idx_user_vocab_user_word ON user_vocab(user_id, word_id, sentence_id);
           CREATE INDEX IF NOT EXISTS idx_test_records_session ON test_records(session_id);
           CREATE INDEX IF NOT EXISTS idx_test_records_user ON test_records(user_id, sentence_id);`);
}

// 称呼白名单（词义无（人名）特征但属称呼——复习/听写跳过）
const TITLE_WORDS = ["mr", "mrs", "miss", "ms", "sir", "dr", "madam", "madame", "prof"];

// T069/T072：人名回填（幂等）。精确化：
//  - 正向：仅「词义开头 40 字符」含人名特征（避免多义词末尾人名义项误伤，如 parade「游行…（人名）」）
//  - 称呼白名单强制标记
//  - 反向：已标但词义开头无特征（且非称呼）→ 回滚（误标恢复普通词）
function backfillNames(db: DatabaseSync): void {
  db.exec(`UPDATE words SET is_name = 1
    WHERE is_name = 0 AND (
      substr(meaning, 1, 40) LIKE '%人名%' OR substr(meaning, 1, 40) LIKE '%姓名%'
      OR substr(meaning, 1, 40) LIKE '%姓氏%' OR substr(meaning, 1, 40) LIKE '%女子名%'
      OR substr(meaning, 1, 40) LIKE '%男子名%' OR substr(meaning, 1, 40) LIKE '%（人名）%'
      OR substr(meaning, 1, 40) LIKE '%公司%' OR substr(meaning, 1, 40) LIKE '%作家%'
      OR substr(meaning, 1, 40) LIKE '%歌手%'
    )`);
  db.exec(`UPDATE words SET is_name = 1
    WHERE is_name = 0 AND word IN (${TITLE_WORDS.map((w) => `'${w}'`).join(",")})`);
  db.exec(`UPDATE words SET is_name = 0
    WHERE is_name = 1 AND word NOT IN (${TITLE_WORDS.map((w) => `'${w}'`).join(",")})
      AND meaning IS NOT NULL AND meaning != ''
      AND substr(meaning, 1, 40) NOT LIKE '%人名%' AND substr(meaning, 1, 40) NOT LIKE '%姓名%'
      AND substr(meaning, 1, 40) NOT LIKE '%姓氏%' AND substr(meaning, 1, 40) NOT LIKE '%女子名%'
      AND substr(meaning, 1, 40) NOT LIKE '%男子名%' AND substr(meaning, 1, 40) NOT LIKE '%（人名）%'
      AND substr(meaning, 1, 40) NOT LIKE '%公司%' AND substr(meaning, 1, 40) NOT LIKE '%作家%'
      AND substr(meaning, 1, 40) NOT LIKE '%歌手%'`);
  // T072：真实人名/称呼首字母大写（符合英语习惯；取词按大写判断跳过）
  db.exec(`UPDATE words
    SET word = upper(substr(word, 1, 1)) || substr(word, 2)
    WHERE is_name = 1 AND word GLOB '[a-z]*'`);
}

// T069：课序回填（幂等：仅未设置时写入；数据内置，远程无 res/ 也可迁移）
function backfillLessonOrder(db: DatabaseSync): void {
  const missing = db
    .prepare("SELECT COUNT(*) AS c FROM words WHERE lesson_no IS NULL OR lesson_pos IS NULL")
    .get() as { c: number };
  if (missing.c === 0) return;
  const stmt = db.prepare("UPDATE words SET lesson_no=?, lesson_pos=? WHERE word=?");
  for (const [word, [ln, pos]] of Object.entries(WORD_LESSONS)) {
    stmt.run(ln, pos, word);
  }
}

export function initDb(databasePath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  if (db && dbPath === databasePath) return db;
  if (db) db.close();
  db = new DatabaseSync(databasePath);
  dbPath = databasePath;
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA_SQL);
  migrate(db);
  backfillLessonOrder(db); // T069：NCE 课序（听写顺序）
  backfillNames(db); // T069：人名重标（听写跳人名）
  return db;
}

// 仅供测试：强制用新路径重建句柄
export function resetDb(databasePath: string): DatabaseSync {
  if (db) db.close();
  db = null;
  dbPath = null;
  return initDb(databasePath);
}