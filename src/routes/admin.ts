// 管理接口（T075）：用户管理 / 报告与句子管理 / 邀请码管理
// 所有接口 requireAdmin（role=admin 后端强制——前端守卫只是体验层）
import { Router, Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { requireAuth, authRouter } from "./auth.js";
import { findUserById } from "../auth.js";

// T075：管理员中间件（requireAuth 之后校验 role）
export function requireAdmin(db?: DatabaseSync) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session.userId) {
      res.status(401).json({ error: "未登录" });
      return;
    }
    const d = db ?? getDb();
    const user = findUserById(d, req.session.userId);
    if (!user || user.role !== "admin") {
      res.status(403).json({ error: "需要管理员权限" });
      return;
    }
    next();
  };
}

// 上传（T075：句子音频替换——只 mp3，<1MB；服务端生成文件名防路径注入）
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.resolve(process.cwd(), "data", "audio");
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, _file, cb) => {
      cb(null, `upd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`);
    },
  }),
  limits: { fileSize: 1024 * 1024 }, // <1MB
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === "audio/mpeg" || file.mimetype === "audio/mp3" || /\.mp3$/i.test(file.originalname);
    if (ok) cb(null, true);
    else cb(new Error("仅支持 mp3"));
  },
});

// 分词（与 getSentenceWithTokens 同正则）
function tokenizeEn(en: string): string[] {
  return en.match(/[a-zA-Z]+(?:['’][a-zA-Z]+)*['’]*/g) ?? [];
}

// 重建 sentence_words：删旧 → 分词 → 找/建词 → 关联
function rebuildSentenceWords(db: DatabaseSync, sentenceId: number, en: string): void {
  db.prepare("DELETE FROM sentence_words WHERE sentence_id=?").run(sentenceId);
  const tokens = tokenizeEn(en);
  tokens.forEach((tok, i) => {
    const w = tok.toLowerCase();
    let wid = (db.prepare("SELECT id FROM words WHERE word=?").get(w) as { id: number } | undefined)?.id;
    if (!wid) {
      const row = db.prepare("SELECT level FROM sentences WHERE id=?").get(sentenceId) as { level: number | null } | undefined;
      wid = db
        .prepare("INSERT INTO words (word, level) VALUES (?, ?)")
        .run(w, row?.level ?? 5).lastInsertRowid as number;
    }
    db.prepare("INSERT INTO sentence_words (sentence_id, word_id, position, is_bold) VALUES (?, ?, ?, 0)").run(sentenceId, wid, i);
  });
}

export function adminRouter(db?: DatabaseSync): Router {
  const router = Router();
  const database = db ?? getDb();

  // ---------- 用户管理 ----------
  router.get("/users", requireAuth(database), requireAdmin(database), (req, res) => {
    const users = database
      .prepare(
        `SELECT u.id, u.username, u.nickname, u.role, u.status, u.level
         FROM users u ORDER BY u.id`
      )
      .all() as unknown[];
    res.json({ users });
  });

  router.post("/users/:id/disable", requireAuth(database), requireAdmin(database), (req, res) => {
    database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(Number(req.params.id));
    res.json({ ok: true });
  });

  router.post("/users/:id/enable", requireAuth(database), requireAdmin(database), (req, res) => {
    database.prepare("UPDATE users SET status='active' WHERE id=?").run(Number(req.params.id));
    res.json({ ok: true });
  });

  // T075：删除用户级联清数据（生词本/记录/报告/足迹/听写进度）
  router.post("/users/:id/delete", requireAuth(database), requireAdmin(database), (req, res) => {
    const uid = Number(req.params.id);
    if (uid === req.session.userId) {
      res.status(400).json({ error: "不能删除自己" });
      return;
    }
    database.exec("BEGIN");
    try {
      database.prepare("DELETE FROM user_vocab WHERE user_id=?").run(uid);
      database.prepare("DELETE FROM word_status WHERE user_id=?").run(uid);
      database.prepare("DELETE FROM test_records WHERE user_id=?").run(uid);
      database.prepare("DELETE FROM practice_sessions WHERE user_id=?").run(uid);
      database.prepare("DELETE FROM sentence_reports WHERE user_id=?").run(uid);
      database.prepare("DELETE FROM levelup_history WHERE user_id=?").run(uid);
      database.prepare("DELETE FROM dictation_cursor WHERE user_id=?").run(uid);
      database.prepare("DELETE FROM dictation_done WHERE user_id=?").run(uid);
      database.prepare("UPDATE invite_codes SET used_by=NULL WHERE used_by=?").run(uid);
      database.prepare("DELETE FROM users WHERE id=?").run(uid);
      database.exec("COMMIT");
      res.json({ ok: true });
    } catch (e) {
      database.exec("ROLLBACK");
      throw e;
    }
  });

  // ---------- 报告与句子管理 ----------
  router.get("/reports", requireAuth(database), requireAdmin(database), (req, res) => {
    const reports = database
      .prepare(
        `SELECT r.id, r.sentence_id, r.time, r.status, r.description,
                s.en, s.zh, s.is_word_only, u.username
         FROM sentence_reports r
         JOIN sentences s ON s.id = r.sentence_id
         LEFT JOIN users u ON u.id = r.user_id
         ORDER BY r.time DESC`
      )
      .all() as unknown[];
    res.json({ reports });
  });

  router.post("/reports/:id/handle", requireAuth(database), requireAdmin(database), (req, res) => {
    database.prepare("UPDATE sentence_reports SET status='handled' WHERE id=?").run(Number(req.params.id));
    res.json({ ok: true });
  });

  // T075：句子更新（en/zh 可编辑 + 可选 mp3 上传替换音频）——重建 sentence_words + 标记报告 handled
  router.post("/sentences/:id/update", requireAuth(database), requireAdmin(database), upload.single("file"), (req, res) => {
    const sid = Number(req.params.id);
    const row = database.prepare("SELECT en FROM sentences WHERE id=?").get(sid) as { en: string } | undefined;
    if (!row) {
      res.status(404).json({ error: "句子不存在" });
      return;
    }
    const en = typeof req.body?.en === "string" && req.body.en.trim() ? req.body.en.trim() : row.en;
    const zh = typeof req.body?.zh === "string" ? req.body.zh.trim() : undefined;
    database.exec("BEGIN");
    try {
      // 更新句子
      if (zh !== undefined) {
        database.prepare("UPDATE sentences SET en=?, zh=? WHERE id=?").run(en, zh, sid);
      } else {
        database.prepare("UPDATE sentences SET en=? WHERE id=?").run(en, sid);
      }
      // 重建词关联
      rebuildSentenceWords(database, sid, en);
      // 音频替换（可选）
      if (req.file) {
        const rel = `data/audio/${req.file.filename}`;
        // 删旧音频文件
        const old = database.prepare("SELECT file_path FROM audio WHERE sentence_id=?").get(sid) as { file_path: string } | undefined;
        if (old?.file_path) {
          const oldAbs = path.isAbsolute(old.file_path) ? old.file_path : path.resolve(process.cwd(), old.file_path);
          if (fs.existsSync(oldAbs) && path.basename(oldAbs) !== req.file.filename) {
            try { fs.unlinkSync(oldAbs); } catch { /* 忽略 */ }
          }
        }
        // 更新/插入 audio 记录
        database
          .prepare("INSERT INTO audio (sentence_id, file_path, duration_ms) VALUES (?, ?, NULL) ON CONFLICT(sentence_id) DO UPDATE SET file_path=excluded.file_path")
          .run(sid, rel);
      }
      // 该句 pending 报告 → handled
      database.prepare("UPDATE sentence_reports SET status='handled' WHERE sentence_id=? AND status='pending'").run(sid);
      database.exec("COMMIT");
      res.json({ ok: true });
    } catch (e) {
      database.exec("ROLLBACK");
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* 忽略 */ } }
      throw e;
    }
  });

  // T075：句子删除级联（sentence_words/user_vocab/test_records/audio/报告/磁盘文件）
  router.post("/sentences/:id/delete", requireAuth(database), requireAdmin(database), (req, res) => {
    const sid = Number(req.params.id);
    const row = database.prepare("SELECT id FROM sentences WHERE id=?").get(sid);
    if (!row) {
      res.status(404).json({ error: "句子不存在" });
      return;
    }
    // 删音频文件
    const a = database.prepare("SELECT file_path FROM audio WHERE sentence_id=?").get(sid) as { file_path: string } | undefined;
    if (a?.file_path) {
      const abs = path.isAbsolute(a.file_path) ? a.file_path : path.resolve(process.cwd(), a.file_path);
      if (fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch { /* 忽略 */ } }
    }
    database.exec("BEGIN");
    try {
      database.prepare("DELETE FROM sentence_words WHERE sentence_id=?").run(sid);
      database.prepare("DELETE FROM user_vocab WHERE sentence_id=?").run(sid);
      database.prepare("DELETE FROM test_records WHERE sentence_id=?").run(sid);
      database.prepare("DELETE FROM audio WHERE sentence_id=?").run(sid);
      database.prepare("DELETE FROM sentence_reports WHERE sentence_id=?").run(sid);
      database.prepare("DELETE FROM sentences WHERE id=?").run(sid);
      database.exec("COMMIT");
      res.json({ ok: true });
    } catch (e) {
      database.exec("ROLLBACK");
      throw e;
    }
  });

  // ---------- 邀请码管理 ----------
  router.get("/invites", requireAuth(database), requireAdmin(database), (req, res) => {
    const invites = database
      .prepare(
        `SELECT i.id, i.code, i.enabled, i.used_by, i.used_at, i.created_at, u.username AS used_by_name
         FROM invite_codes i LEFT JOIN users u ON u.id = i.used_by
         ORDER BY i.id DESC`
      )
      .all() as unknown[];
    res.json({ invites });
  });

  router.post("/invites", requireAuth(database), requireAdmin(database), (req, res) => {
    const code = `ECHOO-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const id = database
      .prepare("INSERT INTO invite_codes (code, created_at) VALUES (?, ?)")
      .run(code, new Date().toISOString()).lastInsertRowid as number;
    res.json({ ok: true, id, code });
  });

  router.post("/invites/:id/toggle", requireAuth(database), requireAdmin(database), (req, res) => {
    const id = Number(req.params.id);
    const row = database.prepare("SELECT enabled FROM invite_codes WHERE id=?").get(id) as { enabled: number } | undefined;
    if (!row) {
      res.status(404).json({ error: "邀请码不存在" });
      return;
    }
    database.prepare("UPDATE invite_codes SET enabled=? WHERE id=?").run(row.enabled ? 0 : 1, id);
    res.json({ ok: true });
  });

  return router;
}
