// 逐词拼写判定（T009，纯函数无 DB）
// 规则（需求 §3.1.4）：逐字符输入、大小写一致、正确才前进；整词输完自动下一词。

export interface CheckResult {
  correct: boolean; // 已输入部分是否完全正确
  done: boolean; // 整词是否已完成
}

// 判定一个词当前输入状态
export function wordState(word: string, typed: string): CheckResult {
  if (typed.length > word.length) return { correct: false, done: false };
  const correct = typed === word.slice(0, typed.length);
  return { correct, done: typed === word };
}

// 整句是否完成：当前词是末词且已 done
export function sentenceDone(tokens: { word: string }[], currentWordIdx: number, typed: string): boolean {
  if (currentWordIdx !== tokens.length - 1) return false;
  return wordState(tokens[currentWordIdx].word, typed).done;
}