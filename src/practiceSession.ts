// 练习会话状态机（T010，内存存储）
// 每个登录用户同时只有一个进行中的练习会话。
import type { DatabaseSync } from "node:sqlite";
import { drawSession, drawTestSentenceIds, startSession, drawLevelupSentenceIds, isLevelUpPassed, type DrawConfig, type TestScope } from "./practice.js";

export interface SessionState {
  sessionId: number;
  targetCount: number;
  sentenceIds: number[];
  idx: number; // 当前句子下标
  wordIdx: number; // 当前词下标
  typed: string; // 当前词已输入字符
  startedAt: number; // Date.now()
  lastActive: number; // T059：最后活动时间（滑动过期）
  mode: "practice" | "review" | "test"; // 练习/复习/测试模式（T028）
  scope?: TestScope; // 测试范围（T028）
}

// T059：会话滑动过期时长（2 小时——升级测试 20 句可能超 30 分钟）
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const store = new Map<number, SessionState>();

export function resetSessionStore(): void {
  store.clear();
}

// T059：读取时检查滑动过期——超 2h 未活动自动清理（防内存泄漏）
export function getSession(userId: number): SessionState | undefined {
  const st = store.get(userId);
  if (!st) return undefined;
  if (Date.now() - st.lastActive > SESSION_TTL_MS) {
    store.delete(userId);
    return undefined;
  }
  st.lastActive = Date.now();
  return st;
}

export function clearSession(userId: number): void {
  store.delete(userId);
}

// 创建会话：按模式抽取句子 + 建 practice_sessions（mode 落库）
export function createSession(
  db: DatabaseSync,
  userId: number,
  targetCount: number,
  config?: DrawConfig & { mode?: "practice" | "review" | "test"; scope?: TestScope }
): SessionState {
  const { mode = "practice", scope = "all", ...drawConfig } = config ?? {};
  const sentenceIds =
    mode === "test"
      ? scope === "levelup"
        ? drawLevelupSentenceIds(db, userId, targetCount).sentenceIds // T053b：升级测试
        : drawTestSentenceIds(db, userId, targetCount, scope)
      : drawSession(db, userId, targetCount, drawConfig);
  const sessionId = startSession(db, userId, targetCount, mode);
  const state: SessionState = {
    sessionId,
    targetCount,
    sentenceIds,
    idx: 0,
    wordIdx: 0,
    typed: "",
    startedAt: Date.now(),
    lastActive: Date.now(),
    mode,
    scope,
  };
  store.set(userId, state);
  return state;
}

export function elapsedMs(state: SessionState): number {
  return Date.now() - state.startedAt;
}
