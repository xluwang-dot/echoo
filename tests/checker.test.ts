import { describe, it, expect } from "vitest";
import { checkChar, wordState, sentenceDone } from "../src/checker.js";

describe("T009 checker 逐字符判定", () => {
  it("正确字符 → correct=true, done=false", () => {
    const s = wordState("library", "l");
    expect(s.correct).toBe(true);
    expect(s.done).toBe(false);
  });

  it("错误字符（大小写不一致）→ correct=false 不前进", () => {
    const s = wordState("Library", "l");
    expect(s.correct).toBe(false);
  });

  it("整词正确输完 → done=true", () => {
    expect(wordState("cat", "cat").done).toBe(true);
    expect(wordState("cat", "ca").done).toBe(false);
  });

  it("逐字符推进：前缀正确后才可继续", () => {
    const w = "school";
    for (let i = 1; i <= w.length; i++) {
      const s = wordState(w, w.slice(0, i));
      expect(s.correct).toBe(true);
      if (i === w.length) expect(s.done).toBe(true);
      else expect(s.done).toBe(false);
    }
  });

  it("大小写敏感：World vs world", () => {
    expect(wordState("World", "World").done).toBe(true);
    expect(wordState("World", "world").correct).toBe(false);
  });

  it("缩写 don't：撇号是词内字符，需输 5 字符", () => {
    expect(wordState("don't", "don't").done).toBe(true);
    expect(wordState("don't", "dont").correct).toBe(false);
    expect(wordState("don't", "don").correct).toBe(true);
    expect(wordState("don't", "don'").correct).toBe(true);
  });

  it("连字符 high-speed 按整词", () => {
    expect(wordState("high-speed", "high-speed").done).toBe(true);
    expect(wordState("high-speed", "highspeed").correct).toBe(false);
  });

  it("sentenceDone：末词完成才整句完成", () => {
    const tokens = [{ word: "foo" }, { word: "bar" }];
    expect(sentenceDone(tokens, 0, "bar")).toBe(false); // 第 0 词完成，但还有下一词
    expect(sentenceDone(tokens, 1, "bar")).toBe(true); // 末词完成
  });

  it("输入超出长度 → 不 done 且正确与否不影响（多余字符判错）", () => {
    expect(wordState("cat", "cats").correct).toBe(false);
  });
});
