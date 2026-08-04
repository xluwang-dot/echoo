<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { api, type Sentence, type Token } from "../api";

const router = useRouter();

// 阶段：setup（设句数）→ running（拼写）→ done（完成）
const phase = ref<"setup" | "running" | "done">("setup");
const targetCount = ref(20);
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
  if (seg.ti! < wordIdx.value) return t.word; // 已完成
  if (seg.ti === wordIdx.value) {
    if (hintSet.value.has(seg.ti)) return t.word; // 提示词显示原文
    return typed.value + "_".repeat(Math.max(0, t.word.length - typed.value.length));
  }
  return "_".repeat(t.word.length); // 未到
}

function renderSegClass(seg: Seg): string {
  if (seg.type === "text") return "punct";
  const t = sentence.value!.tokens[seg.ti!];
  if (t.is_name === 1) return "name";
  if (seg.ti! < wordIdx.value) return "done";
  if (seg.ti === wordIdx.value) {
    if (hintSet.value.has(seg.ti)) return "hint";
    return "active";
  }
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
  typed.value = typed.value.slice(0, -1);
}

async function onHint() {
  if (phase.value !== "running" || busy.value) return;
  const t = sentence.value!.tokens[wordIdx.value];
  if (!t || t.is_name === 1) return;
  if (hintSet.value.has(wordIdx.value)) return; // 已提示
  busy.value = true;
  try {
    await api.hint();
    hintSet.value.add(wordIdx.value);
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
  if (r.done) {
    finishDone.value = true;
    phase.value = "done";
  } else {
    sentence.value = r.next!;
    wordIdx.value = 0;
    typed.value = "";
    hintSet.value = new Set();
  }
}

// ---------- 开始/结束 ----------
async function onStart() {
  error.value = "";
  busy.value = true;
  try {
    const r = await api.start(targetCount.value);
    total.value = r.total;
    sentence.value = r.current;
    wordIdx.value = 0;
    typed.value = "";
    hintSet.value = new Set();
    todayList.value = [];
    finishDone.value = false;
    phase.value = "running";
    startMs.value = Date.now();
    elapsed.value = 0;
    if (timerId) clearInterval(timerId);
    timerId = window.setInterval(() => {
      elapsed.value = Date.now() - startMs.value;
      elapsedText.value = (elapsed.value / 1000).toFixed(1) + "s";
    }, 100);
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
    <!-- 左侧 80%：拼写区 -->
    <div class="main">
      <div class="topbar">
        <span class="title">背单词 · 听写</span>
        <button class="ghost" @click="onLogout">退出</button>
      </div>

      <!-- 设置页 -->
      <div v-if="phase === 'setup'" class="setup">
        <h2>开始练习</h2>
        <label>
          本次练习句子数量
          <input v-model.number="targetCount" type="number" min="1" max="50" />
        </label>
        <button :disabled="busy" @click="onStart">开始</button>
        <p v-if="error" class="error">{{ error }}</p>
      </div>

      <!-- 拼写 -->
      <div v-else-if="phase === 'running'" class="spell-wrap">
        <div class="progress">
          第 {{ todayList.length + 1 }}/{{ total }} 句 · 用时 {{ elapsedText }}
        </div>
        <div class="zh">{{ sentence?.zh }}</div>
        <div class="en" :class="{ flash: flashError }">
          <span v-for="(seg, i) in segments" :key="i" :class="renderSegClass(seg)">
            {{ renderWord(seg) }}
          </span>
        </div>
        <div class="actions">
          <button :disabled="busy" @click="playSentence">朗读</button>
          <button :disabled="busy" @click="onHint">提示词</button>
          <button disabled title="待接入">报告句子有误</button>
          <button class="danger" @click="onFinish">结束</button>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
        <p class="tip">逐字输入英文；<code>'</code> 与 <code>-</code> 直接敲。</p>
      </div>

      <!-- 完成 -->
      <div v-else class="done">
        <h2>练习完成</h2>
        <p>完成 {{ todayList.length }} 句，用时 {{ elapsedText }}</p>
        <button @click="phase = 'setup'; sentence = null">再来一轮</button>
      </div>
    </div>

    <!-- 右侧 20%：当日已测 -->
    <div class="side">
      <h3>今日已测</h3>
      <ul class="today">
        <li v-for="(it, i) in todayList" :key="i">
          <span class="sen">{{ it.en }}</span>
          <span class="ms">{{ (it.ms / 1000).toFixed(1) }}s</span>
        </li>
      </ul>
      <p v-if="todayList.length === 0" class="empty">练习中…</p>
    </div>
  </div>
</template>

<style scoped>
.practice {
  display: flex;
  min-height: 100vh;
}
.main {
  flex: 4;
  padding: 20px 28px;
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
  font-size: 18px;
  font-weight: 600;
}
.ghost {
  background: transparent;
  color: #3b6ef6;
  border: 1px solid #3b6ef6;
}
.setup {
  margin: auto;
  width: 300px;
  background: #fff;
  padding: 24px;
  border-radius: 10px;
}
.setup label {
  display: block;
  margin-bottom: 12px;
}
.setup button {
  width: 100%;
}
.progress {
  color: #6b7382;
  margin-bottom: 8px;
}
.zh {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 24px;
}
.en {
  font-size: 30px;
  line-height: 2;
  font-family: "Courier New", monospace;
  word-spacing: 10px;
  letter-spacing: 2px;
  min-height: 80px;
}
.en .punct {
  color: #9aa1af;
}
.en .name {
  color: #1f2430;
  font-weight: 600;
}
.en .done {
  color: #1d9e54;
}
.en .hint {
  color: #888;
  background: #e8e8ec;
}
.en .active {
  background: #e6f0ff;
  border-bottom: 3px solid #3b6ef6;
}
.en .todo {
  color: #b8c0cf;
}
.en.flash .active {
  border-bottom-color: #e33;
  color: #e33;
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}
.danger {
  background: #d66;
  margin-left: auto;
}
.tip {
  margin-top: 12px;
  color: #9aa1af;
  font-size: 13px;
}
.error {
  color: #d33;
  margin-top: 10px;
}
.side {
  flex: 1;
  background: #fff;
  border-left: 1px solid #e4e8f0;
  padding: 20px;
  max-height: 100vh;
  overflow-y: auto;
}
.side h3 {
  margin-bottom: 12px;
}
.today {
  list-style: none;
}
.today li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px dashed #eef1f6;
  font-size: 13px;
}
.today .sen {
  flex: 1;
  color: #333a46;
}
.today .ms {
  color: #9aa1af;
  white-space: nowrap;
}
.empty {
  color: #b8c0cf;
  font-size: 13px;
}
</style>
