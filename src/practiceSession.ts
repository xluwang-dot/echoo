// 练习会话状态机（T010，内存存储）
// 每个登录用户同时只有一个进行中的练习会话。
import type { DatabaseSync } from "node:sqlite";
import { drawSession, startSession, type DrawConfig } from "./practice.js";

export interface SessionState {
  sessionId: number;
  targetCount: number;
  sentenceIds: number[];
  idx: number; // 当前句子下标
  wordIdx: number; // 当前词下标
  typed: string; // 当前词已输入字符
  startedAt: number; // Date.now()
  mode: "practice" | "review"; // 练习/复习模式
}

const store = new Map<number, SessionState>();

export function resetSessionStore(): void {
  store.clear();
}

export function getSession(userId: number): SessionState | undefined {
  return store.get(userId);
}

export function clearSession(userId: number): void {
  store.delete(userId);
}

// 创建会话：抽取句子 + 建 practice_sessions
export function createSession(db: DatabaseSync, userId: number, targetCount: number, config?: DrawConfig & { mode?: "practice" | "review" }): SessionState {
  const { mode = "practice", ...drawConfig } = config ?? {};
  const sentenceIds = drawSession(db, userId, targetCount, drawConfig);
  const sessionId = startSession(db, userId, targetCount);
  const state: SessionState = {
    sessionId,
    targetCount,
    sentenceIds,
    idx: 0,
    wordIdx: 0,
    typed: "",
    startedAt: Date.now(),
    mode,
  };
  store.set(userId, state);
  return state;
}

export function elapsedMs(state: SessionState): number {
  return Date.now() - state.startedAt;
}
