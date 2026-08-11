<script setup lang="ts">
// T069：单词听写——NCE 课序扫描，识别不会的词
// 正确词不入本；错误词以占位句入生词本；游标推进不重复
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { api, type Sentence } from "../api";

const router = useRouter();

const phase = ref<"loading" | "running" | "done">("loading");
const words = ref<{ wordId: number; word: string; meaning: string; phonetic: string; ok: boolean }[]>([]);
const idx = ref(0);
const typed = ref("");
const error = ref("");
const timing = ref({ replay2: 3000, replay3: 8000, autoNext: 12000 });
const total = ref(0);
const wrongIds = ref<number[]>([]);

// 当前词
const current = computed(() => words.value[idx.value]);
const currentWord = computed(() => current.value?.word ?? "");
const progress = computed(() => `${Math.min(idx.value + 1, total.value)}/${total.value}`);
const showZh = ref(false); // 8s 后显示词义

// 音频
let audio: HTMLAudioElement | null = null;
function playWord() {
  if (!currentWord.value) return;
  try {
    if (audio) audio.pause();
    audio = new Audio(api.wordAudioUrl(currentWord.value));
    audio.play().catch(() => { /* 自动播放限制：已由用户点击开始触发 */ });
  } catch {
    /* 音频失败容错 */
  }
}

// 定时器
let t2: number | undefined;
let t3: number | undefined;
let t12: number | undefined;
function clearTimers() {
  if (t2) clearTimeout(t2);
  if (t3) clearTimeout(t3);
  if (t12) clearTimeout(t12);
  t2 = t3 = t12 = undefined;
}
function startTimers() {
  clearTimers();
  showZh.value = false;
  playWord();
  t2 = window.setTimeout(() => playWord(), timing.value.replay2); // 3s 第二次
  t3 = window.setTimeout(() => {
    showZh.value = true; // 8s 第三次 + 显示词义
    playWord();
  }, timing.value.replay3);
  t12 = window.setTimeout(() => onTimeout(), timing.value.autoNext); // 12s 自动下一词
}

function nextWord(doneOk: boolean) {
  clearTimers();
  typed.value = "";
  const i = idx.value;
  words.value[i].ok = doneOk;
  if (!doneOk) wrongIds.value.push(words.value[i].wordId);
  idx.value += 1;
  if (idx.value >= words.value.length) {
    finish();
    return;
  }
  startTimers();
}

async function onTimeout() {
  // 12s 未完成 → 算错入本
  error.value = "";
  await nextWord(false);
}

async function onChar(ch: string) {
  if (phase.value !== "running") return;
  if (!/[A-Za-z0-9'-]/.test(ch)) return;
  error.value = "";
  try {
    const r = await api.check(ch);
    if (r.correct) {
      typed.value += ch;
      if (r.sentenceDone) {
        await nextWord(true); // 拼对立即跳
      }
    } else {
      error.value = "拼写错误";
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (phase.value !== "running") return;
  if (e.key === "Backspace") {
    typed.value = typed.value.slice(0, -1);
    api.backspace().catch(() => {});
  } else if (e.key.length === 1) {
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
  // 新一轮：重新 start（游标已推进）
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
    // T069：后端一次性返回全部词（前端不推进服务端 state）
    const list: Sentence[] = r.words ?? [r.current];
    words.value = list.map((s) => ({
      wordId: s.tokens[0]?.word_id ?? 0,
      word: s.tokens[0]?.word ?? s.en,
      meaning: s.zh ?? "",
      phonetic: "",
      ok: false,
    }));
    // 音标/词义来自占位句 zh；phonetic 前端无接口 → 用空白（结果页显示词义即可）
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

      <!-- 听写中 -->
      <div v-else-if="phase === 'running'" class="dict-center">
        <div class="dict-word">
          <span class="dict-blank">{{ typed }}</span>
          <span class="dict-caret">▍</span>
        </div>
        <p v-if="showZh" class="dict-zh">{{ current.meaning }}</p>
        <p class="dict-tip">
          听发音，拼写单词；<code>'</code> <code>-</code> 直接敲。
          {{ timing.replay2 / 1000 }}s/{{ timing.replay3 / 1000 }}s 重播，{{ timing.autoNext / 1000 }}s 未完成自动跳过
        </p>
        <p v-if="error" class="dict-error">{{ error }}</p>
        <button class="ghost" @click="playWord">🔊 重播</button>
      </div>

      <!-- 结果 -->
      <div v-else class="dict-result">
        <h3>听写完成 🎉</h3>
        <table>
          <thead>
            <tr><th>结果</th><th>单词</th><th>词义</th></tr>
          </thead>
          <tbody>
            <tr v-for="w in words" :key="w.wordId">
              <td>{{ w.ok ? "✅" : "❌" }}</td>
              <td class="dict-w">{{ w.word }}</td>
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
.dict-word {
  display: flex;
  align-items: center;
  font-size: 44px;
  font-weight: 700;
  min-height: 60px;
  letter-spacing: 2px;
}
.dict-blank {
  color: #1e293b;
}
.dict-caret {
  color: #2563eb;
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}
.dict-zh {
  font-size: 20px;
  color: #475569;
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
.dict-m {
  color: #64748b;
}
.dict-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}
</style>
