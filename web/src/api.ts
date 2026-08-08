// API 封装（登录 + 练习 + 生词本端点）
export interface Token {
  word_id: number;
  word: string;
  is_name: number;
  is_bold: number;
  in_vocab: boolean;
}

export interface Sentence {
  sentenceId: number;
  zh: string;
  en: string;
  tokens: Token[];
  wordIdx: number;
}

export interface StartResult {
  total: number;
  current: Sentence;
}

export interface CheckResult {
  correct: boolean;
  wordDone: boolean;
  sentenceDone: boolean;
}

export interface VocabEntry {
  user_id: number;
  word_id: number;
  sentence_id: number;
  word: string;
  en: string;
  zh: string;
  created_at: string | null;
}

export interface VocabStats {
  vocabCount: number;
  masteredCount: number;
  sentenceCount: number;
}

export interface VocabStateItem {
  wordId: number;
  word: string;
  interval: number;
  status: "learning" | "mastered";
  review_count: number;
}

// 通用请求，带 session cookie
async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    throw new Error("未登录");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `请求失败(${res.status})`);
  }
  return res.json() as Promise<T>;
}

// DELETE 请求
async function reqDelete<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE" });
  if (res.status === 401) throw new Error("未登录");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `请求失败(${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  register: (username: string, password: string, nickname: string) =>
    req<{ id: number }>("POST", "/api/auth/register", { username, password, nickname }),
  login: (username: string, password: string) =>
    req<{ id: number }>("POST", "/api/auth/login", { username, password }),
  logout: () => req<{ ok: boolean }>("POST", "/api/auth/logout", {}),
  me: () => req<{ id: number; username: string; nickname: string; preferences: Record<string, unknown> }>("GET", "/api/auth/me"),
  updatePreferences: (preferences: Record<string, unknown>) =>
    req<{ id: number; username: string; nickname: string; preferences: Record<string, unknown> }>("POST", "/api/auth/preferences", preferences),

  dueCount: () => req<{ due: number }>("GET", "/api/practice/due-count"),
  dueWords: () => req<{ words: VocabStateItem[] }>("GET", "/api/practice/due-words"),
  vocabState: (wordIds: number[]) => req<{ words: VocabStateItem[] }>("POST", "/api/practice/vocab-state", { wordIds }),

  start: (targetCount: number, mode?: "practice" | "review" | "test", scope?: string) =>
    req<StartResult>("POST", "/api/practice/start", { targetCount, mode, scope }),
  check: (char: string) => req<CheckResult>("POST", "/api/practice/check", { char }),
  hint: () => req<{ word: string; sentenceDone: boolean }>("POST", "/api/practice/hint", {}),
  backspace: () => req<{ typed: string }>("POST", "/api/practice/backspace", {}),
  complete: (wordResults: { wordId: number; result: string }[]) =>
    req<{ done: boolean; next?: Sentence }>("POST", "/api/practice/complete", { wordResults }),
  addVocab: (wordId: number) => req<{ ok: boolean }>("POST", "/api/practice/add-vocab", { wordId }),
  finish: () => req<{ ok: boolean; done: number }>("POST", "/api/practice/finish", {}),
  report: (sentenceId: number, description?: string) =>
    req<{ ok: boolean; reportId: number }>("POST", "/api/practice/report", { sentenceId, description }),

  // 音频（无需登录，句子素材共享）
  audioUrl: (sentenceId: number) => `/api/audio/${sentenceId}`,

  // 生词本
  getVocab: () => req<{ vocab: VocabEntry[]; count: number }>("GET", "/api/vocab"),
  getVocabStats: () => req<VocabStats>("GET", "/api/vocab/stats"),
  deleteVocab: (wordId: number, sentenceId: number) =>
    reqDelete<{ ok: boolean }>(`/api/vocab/${wordId}/${sentenceId}`),
};