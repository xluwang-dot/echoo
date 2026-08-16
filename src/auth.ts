// 用户系统数据层（T007）
import bcrypt from "bcryptjs";
import type { DatabaseSync } from "node:sqlite";

const BCRYPT_ROUNDS = 10;

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  nickname: string | null;
  preferences: string | null;
  level: number; // T053a
  role: string; // T074：admin/user
  status: string; // T074：active/disabled
  must_change_password: number; // T074：首次登录强制改密
}

// T074：密码策略——≥8 位，且 数字/特殊/小写/大写 至少 3 类
export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return "密码至少 8 位";
  const kinds = [
    /[0-9]/.test(pw),
    /[^A-Za-z0-9]/.test(pw),
    /[a-z]/.test(pw),
    /[A-Z]/.test(pw),
  ].filter(Boolean).length;
  if (kinds < 3) return "密码需包含 数字/特殊字符/小写/大写 中至少 3 种";
  return null;
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export interface NewUser {
  username: string;
  password: string;
  nickname?: string;
}

export function createUser(db: DatabaseSync, user: NewUser & { role?: string; mustChangePassword?: boolean }): number {
  const hash = hashPassword(user.password);
  const result = db
    .prepare("INSERT INTO users (username, password_hash, nickname, role, must_change_password) VALUES (?, ?, ?, ?, ?)")
    .run(user.username, hash, user.nickname ?? null, user.role ?? "user", user.mustChangePassword ? 1 : 0);
  return result.lastInsertRowid as number;
}

export function findUserByUsername(db: DatabaseSync, username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
}

export function findUserById(db: DatabaseSync, id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

// 登录：凭证正确返回 user，否则返回 null
export function login(db: DatabaseSync, username: string, password: string): UserRow | undefined {
  const user = findUserByUsername(db, username);
  if (!user) return undefined;
  if (!verifyPassword(password, user.password_hash)) return undefined;
  return user;
}

export function toPublicUser(user: UserRow): {
  id: number;
  username: string;
  nickname: string | null;
  preferences: Record<string, unknown>;
  role: string; // T074
  status: string;
  must_change_password: boolean;
} {
  let preferences: Record<string, unknown> = {};
  if (user.preferences) {
    try {
      preferences = JSON.parse(user.preferences) as Record<string, unknown>;
    } catch {
      preferences = {};
    }
  }
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    preferences,
    role: user.role, // T074
    status: user.status,
    must_change_password: user.must_change_password === 1,
  };
}

// T074：邀请码原子消费（存在/enabled/未用 → 标记 used；并发安全）
export function consumeInviteCode(db: DatabaseSync, code: string, userId: number): boolean {
  const r = db
    .prepare("UPDATE invite_codes SET used_by=?, used_at=? WHERE code=? AND enabled=1 AND used_by IS NULL")
    .run(userId, new Date().toISOString(), code);
  return r.changes > 0;
}

// T074：改密（新密码需合规；成功后清强制改密标记）
export function changePassword(db: DatabaseSync, userId: number, newPassword: string): void {
  const hash = hashPassword(newPassword);
  db.prepare("UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?").run(hash, userId);
}

// 更新用户偏好（T029：users.preferences JSON 整体替换）
export function updatePreferences(db: DatabaseSync, userId: number, prefs: Record<string, unknown>): void {
  db.prepare("UPDATE users SET preferences = ? WHERE id = ?").run(JSON.stringify(prefs), userId);
}