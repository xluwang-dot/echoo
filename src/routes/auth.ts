// 认证路由（T007）
import { Router, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { createUser, findUserById, findUserByUsername, login, toPublicUser } from "../auth.js";
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

  return router;
}