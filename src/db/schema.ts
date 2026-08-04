// 数据库表结构（对齐需求文档 §5 的 9 张表）
// 表名：words / sentences / sentence_words / audio / users / user_vocab
//       / word_status / practice_sessions / test_records / sentence_reports

export const TABLES = [
  "words",
  "sentences",
  "sentence_words",
  "audio",
  "users",
  "user_vocab",
  "word_status",
  "practice_sessions",
  "test_records",
  "sentence_reports",
] as const;

// 每表关键列（用于测试核对）
export const EXPECTED_COLUMNS: Record<string, string[]> = {
  words: ["id", "word", "freq", "is_name", "years"],
  sentences: ["id", "en", "zh", "round", "topic", "section", "source"],
  sentence_words: ["sentence_id", "word_id", "position", "is_bold"],
  audio: ["id", "sentence_id", "file_path", "duration_ms", "word_offsets"],
  users: ["id", "username", "password_hash", "nickname", "preferences"],
  user_vocab: ["user_id", "word_id", "sentence_id", "created_at"],
  word_status: ["user_id", "word_id", "status", "updated_at"],
  practice_sessions: ["id", "user_id", "target_count", "start_time", "end_time", "done_count", "total_ms"],
  test_records: ["id", "session_id", "user_id", "word_id", "sentence_id", "time", "result"],
  sentence_reports: ["id", "sentence_id", "user_id", "time", "status"],
};

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  freq INTEGER DEFAULT 0,
  is_name INTEGER DEFAULT 0,
  years TEXT
);

CREATE TABLE IF NOT EXISTS sentences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  en TEXT NOT NULL UNIQUE,
  zh TEXT NOT NULL,
  round TEXT,
  topic TEXT,
  section TEXT,
  source TEXT
);

CREATE TABLE IF NOT EXISTS sentence_words (
  sentence_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  is_bold INTEGER DEFAULT 0,
  PRIMARY KEY (sentence_id, position),
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE,
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sentence_words_word ON sentence_words(word_id);

CREATE TABLE IF NOT EXISTS audio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sentence_id INTEGER NOT NULL,
  file_path TEXT,
  duration_ms INTEGER,
  word_offsets TEXT,
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname TEXT,
  preferences TEXT
);

CREATE TABLE IF NOT EXISTS user_vocab (
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  sentence_id INTEGER NOT NULL,
  created_at TEXT,
  PRIMARY KEY (user_id, word_id, sentence_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE,
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS word_status (
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  status TEXT,
  updated_at TEXT,
  PRIMARY KEY (user_id, word_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS practice_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  target_count INTEGER,
  start_time TEXT,
  end_time TEXT,
  done_count INTEGER,
  total_ms INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS test_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  user_id INTEGER NOT NULL,
  word_id INTEGER,
  sentence_id INTEGER,
  time TEXT,
  result TEXT,
  FOREIGN KEY (session_id) REFERENCES practice_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE,
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sentence_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sentence_id INTEGER NOT NULL,
  user_id INTEGER,
  time TEXT,
  status TEXT,
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;
