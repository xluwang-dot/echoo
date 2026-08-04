// API 封装（登录 + 练习端点）
export interface Token {
  word_id: number;
  word: string;
  is_name: number;
  is_bold: number;
}

export interface Sentence {
  sentenceId: number;
  zh: string;
  en: string;
  tokens: Token[];
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

// 通用请求，带 session cookie
async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("未登录");
  }
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
  me: () => req<{ id: number; username: string; nickname: string }>("GET", "/api/auth/me"),

  start: (targetCount: number) => req<StartResult>("POST", "/api/practice/start", { targetCount }),
  check: (char: string) => req<CheckResult>("POST", "/api/practice/check", { char }),
  hint: () => req<{ word: string }>("POST", "/api/practice/hint", {}),
  complete: (wordResults: { wordId: number; result: string }[]) =>
    req<{ done: boolean; next?: Sentence }>("POST", "/api/practice/complete", { wordResults }),
  finish: () => req<{ ok: boolean; done: number }>("POST", "/api/practice/finish", {}),

  // 音频（无需登录，句子素材共享）
  audioUrl: (sentenceId: number) => `/api/audio/${sentenceId}`,
};