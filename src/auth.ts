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

export function createUser(db: DatabaseSync, user: NewUser): number {
  const hash = hashPassword(user.password);
  const result = db
    .prepare("INSERT INTO users (username, password_hash, nickname) VALUES (?, ?, ?)")
    .run(user.username, hash, user.nickname ?? null);
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

export function toPublicUser(user: UserRow): { id: number; username: string; nickname: string | null } {
  return { id: user.id, username: user.username, nickname: user.nickname };
}