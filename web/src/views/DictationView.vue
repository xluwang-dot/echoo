<script setup lang="ts">
// T069：单词听写——NCE 课序扫描，识别不会的词
// 流程：0s 播语音 → 10s 播+音标 → 20s 播 → 30s 揭示拼写+标记不会（停止计时）
//       拼对显示词义+音标，回车进入下一词（不催促）
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { api, type Sentence } from "../api";

const router = useRouter();

const phase = ref<"loading" | "running" | "done">("loading");
const words = ref<{ wordId: number; word: string; meaning: string; phonetic: string; ok: boolean; done: boolean }[]>([]);
const idx = ref(0);
const typed = ref("");
const error = ref("");
const timing = ref({ replay2: 10000, replay3: 20000, reveal: 30000 });
const total = ref(0);
const wrongIds = ref<number[]>([]);
const showPhonetic = ref(false); // 10s 后显示音标
const revealWord = ref(false); // 30s 后显示拼写（标记不会）

const current = computed(() => words.value[idx.value]);
const currentWord = computed(() => current.value?.word ?? "");
const progress = computed(() => `${Math.min(idx.value + 1, total.value)}/${total.value}`);
// 输入完成状态：拼对 或 30s 揭示后（此时等回车）
const wordDone = computed(() => current.value?.done ?? false);

// 音频
let audio: HTMLAudioElement | null = null;
function playWord() {
  if (!currentWord.value) return;
  try {
    if (audio) audio.pause();
    audio = new Audio(api.wordAudioUrl(currentWord.value));
    audio.play().catch(() => {});
  } catch {
    /* 音频失败容错 */
  }
}

// 定时器
let t2: number | undefined;
let t3: number | undefined;
let tR: number | undefined;
function clearTimers() {
  if (t2) clearTimeout(t2);
  if (t3) clearTimeout(t3);
  if (tR) clearTimeout(tR);
  t2 = t3 = tR = undefined;
}
function startTimers() {
  clearTimers();
  showPhonetic.value = false;
  revealWord.value = false;
  playWord(); // 第 1 次
  t2 = window.setTimeout(() => {
    showPhonetic.value = true; // 10s：音标提示
    playWord(); // 第 2 次
  }, timing.value.replay2);
  t3 = window.setTimeout(() => {
    playWord(); // 20s：第 3 次
  }, timing.value.replay3);
  tR = window.setTimeout(() => {
    // 30s：揭示拼写 + 标记不会（停止计时，等回车）
    revealWord.value = true;
    markWrong();
  }, timing.value.reveal);
}

function markWrong() {
  const i = idx.value;
  if (!words.value[i].ok) {
    words.value[i].ok = false;
    wrongIds.value.push(words.value[i].wordId);
  }
}

// 进入下一词（回车触发）
async function enterNext() {
  clearTimers();
  typed.value = "";
  idx.value += 1;
  if (idx.value >= words.value.length) {
    finish();
    return;
  }
  // 推进服务端 state（check 判定依赖当前词）
  try {
    await api.dictationNext();
  } catch {
    /* 忽略 */
  }
  startTimers();
}

async function onChar(ch: string) {
  if (phase.value !== "running" || wordDone.value) return;
  if (!/[A-Za-z0-9'-]/.test(ch)) return;
  try {
    const r = await api.check(ch);
    if (r.correct) {
      typed.value += ch;
      if (r.sentenceDone) {
        // 拼对：显示词义+音标，等回车（不催促）
        words.value[idx.value].done = true;
        words.value[idx.value].ok = true;
        showPhonetic.value = true;
        clearTimers();
      }
      // 拼错：静默（不提示，不扰乱思考）
    }
  } catch {
    /* 网络错误静默 */
  }
}

function onKeydown(e: KeyboardEvent) {
  if (phase.value !== "running") return;
  if (e.key === "Backspace") {
    if (!wordDone.value) {
      typed.value = typed.value.slice(0, -1);
      api.backspace().catch(() => {});
    }
  } else if (e.key === "Enter") {
    if (wordDone.value) enterNext();
  } else if (e.key.length === 1 && !wordDone.value) {
    onChar(e.key);
  }
}

async function finish() {
  phase.value = "done";
  clearTimers();
  try {
    await api.completeDictation(wrongIds.value); // 错误词统一入本
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function startOver() {
  words.value = [];
  idx.value = 0;
  wrongIds.value = [];
  typed.value = "";
  phase.value = "loading";
  init();
}

async function init() {
  phase.value = "loading";
  try {
    const t = await api.dictationTiming();
    timing.value = t;
    const r = await api.start(10, "dictation");
    total.value = r.total;
    const list: (Sentence & { phonetic?: string | null })[] = r.words ?? [r.current];
    words.value = list.map((s) => ({
      wordId: s.tokens[0]?.word_id ?? 0,
      word: s.tokens[0]?.word ?? s.en,
      meaning: s.zh ?? "",
      phonetic: s.phonetic ?? "",
      ok: false,
      done: false,
    }));
    idx.value = 0;
    phase.value = "running";
    startTimers();
  } catch (e) {
    error.value = (e as Error).message;
    phase.value = "loading";
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  init();
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  clearTimers();
  if (audio) audio.pause();
});
</script>

<template>
  <div class="dictation">
    <div class="dict-card">
      <div class="dict-top">
        <span class="dict-title">📝 单词听写</span>
        <span class="dict-progress">{{ progress }}</span>
      </div>

      <!-- 加载/错误 -->
      <div v-if="phase === 'loading'" class="dict-center">
        <p v-if="error" class="dict-error">{{ error }}</p>
        <p v-else>正在抽取单词…</p>
        <button v-if="error" class="primary" @click="init">重试</button>
        <button class="ghost" @click="router.push('/practice')">返回</button>
      </div>

      <!-- 听写中：输入区固定（不随内容跳动） -->
      <div v-else-if="phase === 'running'" class="dict-center">
        <!-- 输入区（固定） -->
        <div class="dict-input">
          <span class="dict-blank">{{ typed }}</span><span class="dict-caret">▍</span>
        </div>
        <!-- 信息区（动态，不挤占输入区） -->
        <div class="dict-info">
          <p v-if="showPhonetic" class="dict-phonetic">{{ current.phonetic }}</p>
          <p v-if="revealWord" class="dict-reveal">
            答案：<strong>{{ current.word }}</strong>（已标记不会，抄写后回车）
          </p>
          <p v-if="wordDone" class="dict-done">
            ✅ <strong>{{ current.word }}</strong> · {{ current.phonetic }} · {{ current.meaning }}
            <span class="dict-hint">回车进入下一词</span>
          </p>
        </div>
        <div class="dict-actions-row">
          <button class="ghost" @click="playWord">🔊 重播</button>
        </div>
        <p class="dict-tip">
          听发音拼写；{{ timing.replay2 / 1000 }}s/{{ timing.replay3 / 1000 }}s 重播，{{ timing.reveal / 1000 }}s 后揭示答案
        </p>
      </div>

      <!-- 结果 -->
      <div v-else class="dict-result">
        <h3>听写完成 🎉</h3>
        <table>
          <thead>
            <tr><th>结果</th><th>单词</th><th>音标</th><th>词义</th></tr>
          </thead>
          <tbody>
            <tr v-for="w in words" :key="w.wordId">
              <td>{{ w.ok ? "✅" : "❌" }}</td>
              <td class="dict-w">{{ w.word }}</td>
              <td class="dict-p">{{ w.phonetic }}</td>
              <td class="dict-m">{{ w.meaning }}</td>
            </tr>
          </tbody>
        </table>
        <div class="dict-actions">
          <button class="primary" @click="startOver">再来一轮</button>
          <button class="ghost" @click="router.push('/practice')">返回</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dictation {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.dict-card {
  background: #fff;
  border-radius: 16px;
  padding: 28px 32px;
  width: min(640px, 92vw);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);
}
.dict-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}
.dict-title {
  font-size: 18px;
  font-weight: 700;
}
.dict-progress {
  color: #64748b;
  font-size: 14px;
}
.dict-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 30px 0;
}
/* 输入区固定高度（不随内容变化跳动） */
.dict-input {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 76px;
  font-size: 42px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #1e293b;
  border-bottom: 3px solid #e2e8f0;
}
.dict-caret {
  color: #2563eb;
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}
.dict-info {
  min-height: 72px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.dict-phonetic {
  font-size: 20px;
  color: #2563eb;
  font-family: "DejaVu Sans", sans-serif;
}
.dict-reveal {
  font-size: 18px;
  color: #dc2626;
}
.dict-done {
  font-size: 18px;
  color: #16a34a;
}
.dict-hint {
  font-size: 13px;
  color: #94a3b8;
  margin-left: 8px;
}
.dict-actions-row {
  min-height: 36px;
}
.dict-tip {
  font-size: 13px;
  color: #94a3b8;
}
.dict-error {
  color: #dc2626;
  font-size: 14px;
}
.dict-result table {
  width: 100%;
  border-collapse: collapse;
  margin: 14px 0;
}
.dict-result th,
.dict-result td {
  padding: 8px 10px;
  border-bottom: 1px solid #e2e8f0;
  text-align: left;
}
.dict-result th {
  color: #64748b;
  font-size: 13px;
}
.dict-w {
  font-weight: 600;
}
.dict-p {
  color: #2563eb;
  font-family: "DejaVu Sans", sans-serif;
}
.dict-m {
  color: #64748b;
}
.dict-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}
</style>
