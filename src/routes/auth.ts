// 认证路由（T007）
import { Router, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { createUser, findUserById, findUserByUsername, login, toPublicUser, updatePreferences, validatePassword, consumeInviteCode, changePassword, verifyPassword } from "../auth.js";
import { getDb } from "../db.js";

// T074：登录/注册限速（失败才计数：IP 5 次失败/分钟——成功不计数，避免误伤正常用户）
const loginAttempts = new Map<string, number[]>();
export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  // T074：测试环境不限速（vitest NODE_ENV=test——密集注册用例不误伤）
  if (process.env.NODE_ENV === "test") {
    next();
    return;
  }
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const arr = (loginAttempts.get(ip) ?? []).filter((t) => now - t < 60000);
  if (arr.length >= 5) {
    res.status(429).json({ error: "尝试过于频繁，请稍后再试" });
    return;
  }
  (req as Request & { _authFailed?: boolean })._authFailed = false;
  next();
}
// 记录失败（login/register 失败时调用）
export function recordFailure(req: Request): void {
  if (process.env.NODE_ENV === "test") return;
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const arr = (loginAttempts.get(ip) ?? []).filter((t) => now - t < 60000);
  arr.push(now);
  loginAttempts.set(ip, arr);
}

// T074：认证中间件（工厂：带 db 实时校验用户存在与状态——停用立即踢下线）
export function requireAuth(db?: DatabaseSync) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session.userId) {
      res.status(401).json({ error: "未登录" });
      return;
    }
    if (db) {
      const user = findUserById(db, req.session.userId);
      if (!user) {
        res.status(401).json({ error: "用户不存在" });
        return;
      }
      if (user.status !== "active") {
        res.status(403).json({ error: "账号已停用" });
        return;
      }
    }
    next();
  };
}

export function authRouter(db?: DatabaseSync): Router {
  const router = Router();
  const database = db ?? getDb();

  router.post("/register", rateLimit, (req, res) => {
    const { username, password, nickname, inviteCode } = req.body ?? {};
    if (typeof username !== "string" || username.trim().length === 0) {
      res.status(400).json({ error: "用户名不能为空" });
      return;
    }
    // T074：密码策略（≥8 位 + 3 类字符）
    const pwErr = validatePassword(String(password ?? ""));
    if (pwErr) {
      res.status(400).json({ error: pwErr });
      return;
    }
    // T074：邀请码必填（防滥用 + 版权合规）
    const code = String(inviteCode ?? "").trim();
    if (!code) {
      res.status(400).json({ error: "请填写邀请码" });
      return;
    }
    const codeRow = database.prepare("SELECT id FROM invite_codes WHERE code=? AND enabled=1 AND used_by IS NULL").get(code);
    if (!codeRow) {
      res.status(400).json({ error: "邀请码无效或已被使用" });
      return;
    }
    const db = database;
    if (findUserByUsername(db, username.trim())) {
      res.status(409).json({ error: "用户名已存在" });
      return;
    }
    // 原子消费邀请码 + 建用户（防并发重复使用）
    db.exec("BEGIN");
    try {
      const id = createUser(db, { username: username.trim(), password, nickname });
      const ok = consumeInviteCode(db, code, id);
      db.exec("COMMIT");
      if (!ok) {
        res.status(400).json({ error: "邀请码已被使用" });
        return;
      }
      const user = findUserById(db, id)!;
      req.session.userId = user.id;
      res.status(201).json(toPublicUser(user));
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });

  router.post("/login", rateLimit, (req, res) => {
    const { username, password } = req.body ?? {};
    const user = login(database, String(username ?? ""), String(password ?? ""));
    if (!user) {
      recordFailure(req); // T074：仅失败计数（防爆破不误伤）
      res.status(401).json({ error: "用户名或密码错误" });
      return;
    }
    // T074：停用用户拒绝登录（已登录的由 requireAuth 校验 status 立即踢下线）
    if (user.status !== "active") {
      res.status(403).json({ error: "账号已停用" });
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

  router.get("/me", requireAuth(database), (req, res) => {
    const user = findUserById(database, req.session.userId!);
    if (!user) {
      res.status(401).json({ error: "用户不存在" });
      return;
    }
    res.json(toPublicUser(user));
  });

  // 更新偏好（T029：整体替换 users.preferences JSON）
  router.post("/preferences", requireAuth(database), (req, res) => {
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
  // T074：修改密码（旧密码校验 + 新密码策略；成功后清强制改密标记）
  router.post("/change-password", requireAuth(database), (req, res) => {
    const { oldPassword, newPassword } = req.body ?? {};
    const user = findUserById(database, req.session.userId!);
    if (!user) {
      res.status(401).json({ error: "用户不存在" });
      return;
    }
    if (!verifyPassword(String(oldPassword ?? ""), user.password_hash)) {
      res.status(400).json({ error: "原密码错误" });
      return;
    }
    const pwErr = validatePassword(String(newPassword ?? ""));
    if (pwErr) {
      res.status(400).json({ error: pwErr });
      return;
    }
    changePassword(database, user.id, newPassword);
    res.json({ ok: true });
  });

  router.get("/footprint", requireAuth(database), (req, res) => {
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

