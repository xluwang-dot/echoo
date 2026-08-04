<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import { useRouter } from "vue-router";
import { api, type Sentence, type Token } from "../api";

const router = useRouter();

// 阶段：menu（三区首页）→ running（拼写）→ done（完成）→ menu
const phase = ref<"menu" | "running" | "done">("menu");
const targetCount = ref(10);
const practiceMode = ref<"practice" | "review">("practice");
const total = ref(0);
const sentence = ref<Sentence | null>(null);

// 会话推进状态
const wordIdx = ref(0); // 当前拼写词下标
const typed = ref(""); // 当前词已输入字符
const hintSet = ref<Set<number>>(new Set()); // 本句已提示词的 token 下标
const flashError = ref(false); // 错误红闪
const error = ref("");
const busy = ref(false);

// 计时
const startMs = ref(0);
const elapsed = ref(0);
const elapsedText = ref("0s");
let timerId: number | null = null;

// 当日已测（本次会话内完成句子 + 用时）
const todayList = ref<{ en: string; ms: number }[]>([]);
const finishDone = ref(false);

// 特效状态
const slideState = ref<"idle" | "exit" | "enter">("idle");
const streak = ref(0); // 连击：连续无提示完成的句子数

// 片段：词（对应 token 下标）或原样文本（标点/空格/数字/连字符）
interface Seg {
  type: "word" | "text";
  text: string;
  ti?: number; // word 时对应 token 下标
}
// 按 token 顺序在原文中定位（大小写不敏感、词边界）。tokens 来自词表分词，
// 粒度与原文不一致（如 warm-up 拆成 warm/up、25th 拆成 th），用 \b 顺序匹配可对齐。
function buildSegments(en: string, tokens: Token[]): Seg[] {
  const segs: Seg[] = [];
  let cursor = 0;
  for (let ti = 0; ti < tokens.length; ti++) {
    const word = tokens[ti].word;
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 边界用「前后非字母」而非 \b：\b 在撇号/连字符（非词字符）后接非词字符时无边界，
    // 会导致 students' 这类带撇号 token 匹配失败。非字母边界可覆盖撇号、数字后缀。
    const m = new RegExp(`(?<![A-Za-z])${esc}(?![A-Za-z])`, "i").exec(en.slice(cursor));
    if (!m) {
      // 原文中定位不到（异常数据），兜底输出原文
      continue;
    }
    const matchStart = cursor + m.index;
    if (matchStart > cursor) segs.push({ type: "text", text: en.slice(cursor, matchStart) });
    segs.push({ type: "word", text: m[0], ti });
    cursor = matchStart + m[0].length;
  }
  if (cursor < en.length) segs.push({ type: "text", text: en.slice(cursor) });
  return segs;
}

const segments = computed(() =>
  sentence.value ? buildSegments(sentence.value.en, sentence.value.tokens) : []
);

function renderWord(seg: Seg): string {
  if (seg.type === "text") return seg.text;
  const t = sentence.value!.tokens[seg.ti!];
  if (t.is_name === 1) return t.word;
  if (seg.ti! < wordIdx.value) return t.word; // 已完成（颜色由 class 决定）
  return t.word; // 当前/未到：由模板或透明渲染
}

// 是否为当前输入词（word 段且光标在该词）
function isActive(seg: Seg): boolean {
  return seg.type === "word" && seg.ti === wordIdx.value && !isName(seg);
}

// 当前词未输入部分（透明占位，保持等宽）
function blankRemain(seg: Seg): string {
  const t = sentence.value!.tokens[seg.ti!];
  return t.word.slice(typed.value.length);
}

function isName(seg: Seg): boolean {
  return seg.type === "word" && sentence.value!.tokens[seg.ti!].is_name === 1;
}

function renderSegClass(seg: Seg): string {
  if (seg.type === "text") return "punct";
  const t = sentence.value!.tokens[seg.ti!];
  if (t.is_name === 1) return "name";
  const hinted = hintSet.value.has(seg.ti!);
  if (seg.ti! < wordIdx.value) return hinted ? "hint-done" : "word-done";
  if (seg.ti === wordIdx.value) return hinted ? "hint-active" : "active";
  return "todo";
}

// ---------- 输入 ----------
async function onChar(ch: string) {
  if (phase.value !== "running" || busy.value) return;
  if (!/[A-Za-z0-9'-]/.test(ch)) return; // 只接受词内字符
  const t = sentence.value!.tokens[wordIdx.value];
  if (!t || t.is_name === 1) return;
  busy.value = true;
  try {
    const r = await api.check(ch);
    if (r.correct) {
      typed.value += ch;
      flashError.value = false;
      if (r.wordDone) {
        // 整词完成
        if (r.sentenceDone) {
          await finishSentence();
        } else {
          wordIdx.value += 1;
          typed.value = "";
        }
      }
    } else {
      flashError.value = true;
      setTimeout(() => (flashError.value = false), 300);
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function onBackspace() {
  if (phase.value !== "running" || busy.value) return;
  if (typed.value === "") return;
  busy.value = true;
  try {
    const r = await api.backspace();
    typed.value = r.typed;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function onHint() {
  if (phase.value !== "running" || busy.value) return;
  const t = sentence.value!.tokens[wordIdx.value];
  if (!t || t.is_name === 1) return;
  if (hintSet.value.has(wordIdx.value)) return; // 已提示
  busy.value = true;
  try {
    await api.hint();
    hintSet.value.add(wordIdx.value); // 浅色显示未输入部分，已输入部分保持原色
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

// 整句完成：提交全词结果，推进下一句或结束
async function finishSentence() {
  const tokens = sentence.value!.tokens;
  const wordResults = tokens
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.is_name !== 1)
    .map(({ t, i }) => ({
      wordId: t.word_id,
      result: hintSet.value.has(i) ? "hint" : "mastered",
    }));
  const ms = Date.now() - startMs.value;
  const r = await api.complete(wordResults);
  todayList.value.push({ en: sentence.value!.en, ms });

  // 连击：本句无提示 → +1，有提示 → 归零
  const hadHint = wordResults.some((w) => w.result === "hint");
  streak.value = hadHint ? 0 : streak.value + 1;

  // 奖励特效：纸屑 + 里程碑庆祝
  createConfetti(streak.value >= 5 && streak.value % 5 === 0 ? 80 : 40);

  // 滑动翻页：当前句向左滑出
  slideState.value = "exit";
  await new Promise((r) => setTimeout(r, 420));

  if (r.done) {
    finishDone.value = true;
    phase.value = "done";
  } else {
    // 替换句子，新句从右侧滑入
    sentence.value = r.next!;
    wordIdx.value = r.next!.wordIdx;
    typed.value = "";
    hintSet.value = new Set();
    await nextTick();
    slideState.value = "enter";
    await new Promise((r) => setTimeout(r, 420));
    slideState.value = "idle";
    playSentence();
  }
}

// ---------- 开始/结束 ----------
async function onStart(mode: "practice" | "review" = "practice") {
  error.value = "";
  busy.value = true;
  practiceMode.value = mode;
  slideState.value = "idle"; // 重置滑动状态，避免上一轮 slide-exit 残留
  try {
    const r = await api.start(targetCount.value, mode);
    total.value = r.total;
    sentence.value = r.current;
    wordIdx.value = r.current.wordIdx;
    typed.value = "";
    hintSet.value = new Set();
    todayList.value = [];
    finishDone.value = false;
    phase.value = "running";
    startMs.value = Date.now();
    elapsed.value = 0;
    if (timerId) clearInterval(timerId);
    timerId = window.setInterval(() => {
      elapsed.value = Math.floor((Date.now() - startMs.value) / 1000);
      elapsedText.value = elapsed.value + "s";
    }, 1000);
    playSentence();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function onFinish() {
  if (phase.value !== "running") return;
  try {
    await api.finish();
  } catch {
    // 忽略：会话可能已结束
  }
  if (timerId) clearInterval(timerId);
  phase.value = "done";
}

async function onLogout() {
  await api.logout();
  router.push("/login");
}

// 播放整句音频（T012：mimo 合成 + 后端静态服务）
let audioEl: HTMLAudioElement | null = null;
async function playSentence() {
  if (!sentence.value) return;
  const url = api.audioUrl(sentence.value.sentenceId);
  if (!audioEl) audioEl = new Audio();
  audioEl.src = url;
  audioEl.currentTime = 0;
  try {
    await audioEl.play();
  } catch {
    // 音频缺失或未生成时静默（按钮仍可用，后续提示）
  }
}

// 彩色纸屑奖励特效
const CONFETTI_COLORS = ["#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4", "#ffeaa7", "#dda0dd", "#ff9ff3", "#48dbfb", "#feca57"];
function createConfetti(count = 40) {
  const container = document.querySelector(".confetti-container");
  if (!container) return;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "confetti-particle";
    p.style.left = (40 + Math.random() * 20) + "%";
    p.style.top = "45%";
    p.style.backgroundColor = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    p.style.width = (4 + Math.random() * 5) + "px";
    p.style.height = (4 + Math.random() * 5) + "px";
    p.style.setProperty("--tx", ((Math.random() - 0.5) * 500) + "px");
    p.style.setProperty("--ty", (-(Math.random() * 400 + 100)) + "px");
    p.style.setProperty("--tr", (Math.random() * 1080) + "deg");
    p.style.setProperty("--dur", (0.8 + Math.random() * 0.8) + "s");
    p.style.setProperty("--del", (Math.random() * 0.15) + "s");
    container.appendChild(p);
    setTimeout(() => p.remove(), 2200);
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Backspace") {
    e.preventDefault();
    onBackspace();
    return;
  }
  if (e.key.length === 1) {
    e.preventDefault();
    onChar(e.key);
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  if (timerId) clearInterval(timerId);
});
</script>

<template>
  <div class="practice">
    <div class="confetti-container"></div>
    <div class="main">
      <div class="topbar">
        <span class="title">背单词 · 听写</span>
        <div class="topbar-right">
          <span v-if="streak >= 3" class="streak-badge">🔥 连击 ×{{ streak }}</span>
          <button class="ghost" @click="onLogout">退出</button>
        </div>
      </div>

      <!-- 设置页 -->
      <!-- 三区首页 -->
      <div v-if="phase === 'menu'" class="menu">
        <div class="menu-cards">
          <div class="menu-card" @click="onStart('practice')">
            <div class="card-icon">📝</div>
            <h2>练习</h2>
            <p>开始新的练习，默认10个句子</p>
          </div>
          <div class="menu-card" @click="onStart('review')">
            <div class="card-icon">🔄</div>
            <h2>复习</h2>
            <p>只复习生词本中的句子</p>
          </div>
          <div class="menu-card" @click="router.push('/vocab')">
            <div class="card-icon">📖</div>
            <h2>生词本</h2>
            <p>查看生词本中的句子</p>
          </div>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
      </div>

      <!-- 拼写 -->
      <div v-else-if="phase === 'running'" class="spell-wrap">
        <div class="progress">
          第 {{ todayList.length + 1 }}/{{ total }} 句 · 用时 {{ elapsedText }}
        </div>
        <div class="zh">{{ sentence?.zh }}</div>
        <div class="input-card">
          <div class="en" :class="{ flash: flashError, 'slide-exit': slideState === 'exit', 'slide-enter': slideState === 'enter' }">
            <span v-for="(seg, i) in segments" :key="i" :class="renderSegClass(seg)">
              <template v-if="seg.type === 'word' && isActive(seg)">
                <span class="typed">{{ typed }}</span><span class="blank">{{ blankRemain(seg) }}</span>
              </template>
              <template v-else>{{ renderWord(seg) }}</template>
            </span>
          </div>
          <div class="actions">
            <button :disabled="busy" @click="playSentence">朗读</button>
            <button :disabled="busy" @click="onHint">提示</button>
            <button disabled title="待接入">报告句子有误</button>
            <button class="danger" @click="onFinish">结束</button>
          </div>
          <p v-if="error" class="error">{{ error }}</p>
          <p class="tip">逐字输入英文；<code>'</code> 与 <code>-</code> 直接敲。</p>
        </div>
      </div>

      <!-- 完成 -->
      <div v-else class="done">
        <h2>练习完成</h2>
        <div class="stats">
          <div class="stat">
            <span class="num">{{ todayList.length }}</span>
            <span class="label">完成句子</span>
          </div>
          <div class="stat">
            <span class="num">{{ elapsedText }}</span>
            <span class="label">总用时</span>
          </div>
        </div>
        <div class="done-actions">
          <button @click="phase = 'menu'; sentence = null">返回首页</button>
          <button class="primary" @click="onStart(practiceMode)">再来一轮</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.practice {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.main {
  flex: 1;
  width: 100%;
  max-width: 860px;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
}
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
.title {
  font-size: 22px;
  font-weight: 700;
}
.ghost {
  background: transparent;
  color: #3b6ef6;
  border: 1px solid #3b6ef6;
}
.menu {
  margin: auto;
  width: 100%;
  max-width: 720px;
  text-align: center;
}
.menu-cards {
  display: flex;
  gap: 20px;
  justify-content: center;
}
.menu-card {
  flex: 1;
  background: #fff;
  border-radius: 16px;
  padding: 36px 20px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(31, 36, 48, 0.06);
  transition: transform 0.15s, box-shadow 0.15s;
}
.menu-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 24px rgba(31, 36, 48, 0.1);
}
.card-icon {
  font-size: 40px;
  margin-bottom: 12px;
}
.menu-card h2 {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 8px;
  color: #1f2430;
}
.menu-card p {
  font-size: 13px;
  color: #6b7382;
  line-height: 1.5;
}
.progress {
  color: #6b7382;
  margin-bottom: 12px;
  font-size: 15px;
  text-align: center;
}
.spell-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  transform: translateY(-12%);
}
.input-card {
  background: #fff;
  border-radius: 20px;
  box-shadow: 0 8px 30px rgba(31, 36, 48, 0.08);
  padding: 28px 36px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: fit-content;
  min-width: 360px;
}
.zh {
  font-size: 34px;
  font-weight: 700;
  margin-bottom: 28px;
  text-align: center;
}
.en {
  font-size: 28px;
  font-weight: 700;
  line-height: 2;
  font-family: "Courier New", monospace;
  min-height: 80px;
  text-align: center;
  white-space: pre-wrap;
  word-break: keep-all;
}
.en > span {
  display: inline-block;
  text-align: center;
}
.en > span + span {
  margin-left: 10px;
}
.en .punct {
  color: #9aa1af;
}
.en .name {
  color: #1f2430;
  font-weight: 700;
}
.en .word-done {
  color: #1d9e54;
}
.en .hint-done {
  color: #d66;
  font-weight: 700;
}
.en .hint-active {
  color: #bbb;
  background: #f0f0f4;
}
.en .hint-active .typed {
  color: #1f2430;
}
.en .hint-active .blank {
  color: #bbb;
}
.en .active {
  background: #e6f0ff;
  border-bottom: 4px solid #3b6ef6;
  animation: blink 1s step-end infinite;
}
.en .active .typed {
  color: #1f2430;
}
.en .active .blank {
  color: transparent;
}
.en .todo {
  color: transparent;
}
.en.flash .active {
  border-bottom-color: #e33;
  color: #e33;
  animation: none;
}
@keyframes blink {
  50% {
    border-bottom-color: transparent;
  }
}
.actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 16px;
}
.actions button {
  font-size: 15px;
  padding: 10px 22px;
}
.danger {
  background: #d66;
}
.tip {
  margin-top: 14px;
  color: #9aa1af;
  font-size: 14px;
  text-align: center;
}
.error {
  color: #d33;
  margin-top: 10px;
  text-align: center;
}
.done {
  margin: auto;
  text-align: center;
  background: #fff;
  padding: 36px 48px;
  border-radius: 12px;
}
.done h2 {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 24px;
}
.stats {
  display: flex;
  justify-content: center;
  gap: 48px;
  margin-bottom: 28px;
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.stat .num {
  font-size: 42px;
  font-weight: 700;
  color: #3b6ef6;
}
.stat .label {
  margin-top: 6px;
  color: #6b7382;
  font-size: 14px;
}
.done button {
  font-size: 16px;
  padding: 12px 32px;
}
.done-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}
.done-actions .primary {
  background: #3b6ef6;
  color: #fff;
}

/* ---- 顶栏右侧 ---- */
.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* ---- 连击徽章 ---- */
.streak-badge {
  background: linear-gradient(135deg, #ff6b6b, #ff9ff3);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  padding: 4px 14px;
  border-radius: 20px;
  animation: streak-pulse 1.2s ease-in-out infinite;
}
@keyframes streak-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}

/* ---- 滑动翻页 ---- */
.slide-exit {
  animation: slide-out 0.4s ease-in forwards;
}
.slide-enter {
  animation: slide-in 0.4s ease-out forwards;
}
@keyframes slide-out {
  0% { transform: translateX(0); opacity: 1; }
  100% { transform: translateX(-60px); opacity: 0; }
}
@keyframes slide-in {
  0% { transform: translateX(60px); opacity: 0; }
  100% { transform: translateX(0); opacity: 1; }
}

/* ---- 彩色纸屑 ---- */
.confetti-container {
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  pointer-events: none;
  z-index: 999;
  overflow: hidden;
}
.confetti-particle {
  position: absolute;
  border-radius: 2px;
  pointer-events: none;
  opacity: 0;
  animation: confetti-burst var(--dur) ease-out var(--del) forwards;
}
@keyframes confetti-burst {
  0% {
    transform: translate(0, 0) rotate(0deg);
    opacity: 1;
  }
  60% {
    opacity: 1;
  }
  100% {
    transform: translate(var(--tx), var(--ty)) rotate(var(--tr));
    opacity: 0;
  }
}
</style>
