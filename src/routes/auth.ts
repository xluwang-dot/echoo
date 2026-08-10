// 认证路由（T007）
import { Router, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { createUser, findUserById, findUserByUsername, login, toPublicUser, updatePreferences } from "../auth.js";
import { getDb } from "../db.js";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: "未登录" });
    return;
  }
  next();
}

export function authRouter(db?: DatabaseSync): Router {
  const router = Router();
  const database = db ?? getDb();

  router.post("/register", (req, res) => {
    const { username, password, nickname } = req.body ?? {};
    if (typeof username !== "string" || username.trim().length === 0) {
      res.status(400).json({ error: "用户名不能为空" });
      return;
    }
    if (typeof password !== "string" || password.length < 6) {
      res.status(400).json({ error: "密码至少 6 位" });
      return;
    }
    const db = database;
    if (findUserByUsername(db, username.trim())) {
      res.status(409).json({ error: "用户名已存在" });
      return;
    }
    const id = createUser(db, { username: username.trim(), password, nickname });
    const user = findUserById(db, id)!;
    req.session.userId = user.id;
    res.status(201).json(toPublicUser(user));
  });

  router.post("/login", (req, res) => {
    const { username, password } = req.body ?? {};
    const user = login(database, String(username ?? ""), String(password ?? ""));
    if (!user) {
      res.status(401).json({ error: "用户名或密码错误" });
      return;
    }
    req.session.userId = user.id;
    res.json(toPublicUser(user));
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.json({ ok: true });
    });
  });

  router.get("/me", requireAuth, (req, res) => {
    const user = findUserById(database, req.session.userId!);
    if (!user) {
      res.status(401).json({ error: "用户不存在" });
      return;
    }
    res.json(toPublicUser(user));
  });

  // 更新偏好（T029：整体替换 users.preferences JSON）
  router.post("/preferences", requireAuth, (req, res) => {
    const prefs = req.body ?? {};
    if (typeof prefs !== "object" || prefs === null) {
      res.status(400).json({ error: "preferences 需为对象" });
      return;
    }
    updatePreferences(database, req.session.userId!, prefs as Record<string, unknown>);
    const user = findUserById(database, req.session.userId!)!;
    res.json(toPublicUser(user));
  });

// T053c：足迹（过去 7 天操作记录）+ 基本信息 + 勋章等级
  router.get("/footprint", requireAuth, (req, res) => {
    const userId = req.session.userId!;
    const since = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10); // 含今天共 7 天
    const sessions = database
      .prepare("SELECT mode, start_time FROM practice_sessions WHERE user_id=? AND start_time >= ?")
      .all(userId, since) as { mode: string; start_time: string }[];
    const ups = database
      .prepare("SELECT from_level, to_level, time FROM levelup_history WHERE user_id=? AND time >= ?")
      .all(userId, since) as { from_level: number; to_level: number; time: string }[];
    const days: Record<string, { practice: number; review: number; test: number; levelup: number }> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days[d] = { practice: 0, review: 0, test: 0, levelup: 0 };
    }
    for (const s of sessions) {
      const d = s.start_time.slice(0, 10);
      if (days[d]) days[d][s.mode === "review" ? "review" : s.mode === "test" ? "test" : "practice"] += 1;
    }
    for (const u of ups) {
      const d = u.time.slice(0, 10);
      if (days[d]) days[d].levelup += 1;
    }
    const user = findUserById(database, userId);
    const vocabCount = database.prepare("SELECT COUNT(*) AS c FROM user_vocab WHERE user_id=?").get(userId) as { c: number };
    const masteredCount = database.prepare("SELECT COUNT(*) AS c FROM user_vocab WHERE user_id=? AND status='mastered'").get(userId) as { c: number };
    res.json({
      user: { username: user?.username, nickname: user?.nickname, level: user?.level ?? 1 },
      days,
      stats: { vocabCount: vocabCount.c, masteredCount: masteredCount.c },
    });
  });

  return router;
}

