<script setup lang="ts">
// T070：单词查询结果页——搜索框 + 词详情 + 状态 + 关联句子 + 加入 SM
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";

const route = useRoute();
const router = useRouter();

const q = ref("");
const error = ref("");
const loading = ref(false);
const notFound = ref(false);
const result = ref<Awaited<ReturnType<typeof api.vocabLookup>> | null>(null);
const candidates = ref<{ word: string; meaning: string | null; phonetic: string | null }[]>([]);
const searchOpen = ref(false);
let searchTimer: number | undefined;
let audioEl: HTMLAudioElement | null = null;

// 防抖搜索（顶栏）
async function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    const kw = q.value.trim();
    if (!kw) {
      candidates.value = [];
      return;
    }
    try {
      const r = await api.vocabSearch(kw);
      candidates.value = r.matches;
      searchOpen.value = true;
    } catch {
      candidates.value = [];
    }
  }, 300);
}

function pickWord(word: string) {
  searchOpen.value = false;
  q.value = word;
  load(word);
}

async function load(word: string) {
  if (!word) return;
  loading.value = true;
  error.value = "";
  notFound.value = false;
  try {
    result.value = await api.vocabLookup(word);
  } catch (e: any) {
    if (e?.status === 404) {
      notFound.value = true;
      result.value = null;
    } else {
      error.value = (e as Error).message;
    }
  } finally {
    loading.value = false;
  }
}

function playWord() {
  if (!result.value?.word.word) return;
  try {
    if (!audioEl) audioEl = new Audio();
    audioEl.src = api.wordAudioUrl(result.value.word.word);
    audioEl.currentTime = 0;
    audioEl.play().catch(() => {});
  } catch {
    /* 静默 */
  }
}

function playSentence(sentenceId: number) {
  try {
    if (!audioEl) audioEl = new Audio();
    audioEl.src = api.audioUrl(sentenceId);
    audioEl.currentTime = 0;
    audioEl.play().catch(() => {});
  } catch {
    /* 静默 */
  }
}

async function addToSm(sentenceId: number, wordId: number) {
  try {
    await api.vocabAdd(wordId, sentenceId);
    // 刷新状态
    await load(result.value!.word.word);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

const statusText: Record<string, string> = {
  learning: "学习中",
  candidate: "待测试",
  mastered: "已掌握",
};

onMounted(() => {
  const w = String(route.query.word ?? "").trim();
  if (w) {
    q.value = w;
    load(w);
  }
});
</script>

<template>
  <div class="lookup">
    <div class="lookup-card">
      <!-- 返回主页 -->
      <div class="lookup-back">
        <button class="ghost" @click="router.push('/practice')">← 返回主页</button>
      </div>
      <!-- 搜索框 -->
      <div class="lookup-search">
        <input
          v-model="q"
          class="lookup-input"
          placeholder="🔍 输入英文单词查询…"
          @input="onSearchInput"
          @keydown.enter="searchOpen = false; load(q.trim())"
        />
        <div v-if="searchOpen && candidates.length" class="lookup-drop">
          <div v-for="c in candidates" :key="c.word" class="lookup-item" @click="pickWord(c.word)">
            <span class="li-word">{{ c.word }}</span>
            <span class="li-meaning">{{ c.meaning ?? "—" }}</span>
          </div>
        </div>
      </div>

      <!-- 加载 / 错误 -->
      <div v-if="loading" class="lookup-state">查询中…</div>
      <div v-else-if="error" class="lookup-state lookup-error">{{ error }}</div>
      <div v-else-if="notFound" class="lookup-state">
        <p>「{{ q }}」未收录</p>
        <p class="lookup-tip">试试相近拼写（如 you're → you re 的变体）</p>
      </div>

      <!-- 结果 -->
      <div v-else-if="result" class="lookup-result">
        <!-- 词详情 -->
        <div class="word-head">
          <span class="word-title">{{ result.word.word }}</span>
          <span v-if="result.word.phonetic" class="word-phonetic">{{ result.word.phonetic }}</span>
          <button class="speaker" @click="playWord" title="播放发音">🔊</button>
        </div>
        <p class="word-meaning">{{ result.word.meaning ?? "—" }}</p>
        <p class="word-meta">
          <span v-if="result.word.level">级别 {{ result.word.level }}</span>
          <span v-if="result.word.lesson_no"> · NCE 课 {{ result.word.lesson_no }}</span>
        </p>

        <!-- 当前状态 -->
        <div class="status-box">
          <h4>当前状态</h4>
          <div class="status-row">
            <span class="status-tag" :class="result.dictation.done ? 'tag-ok' : 'tag-off'">
              听写{{ result.dictation.done ? "已扫描 ✓" : "未扫描" }}
            </span>
            <span class="status-tag" :class="result.sm.length ? 'tag-ok' : 'tag-off'">
              SM {{ result.sm.length ? `${result.sm.length} 条记录` : "未入 SM" }}
            </span>
          </div>
          <div v-if="result.sm.length" class="sm-list">
            <div v-for="r in result.sm" :key="r.sentence_id" class="sm-row">
              <span class="sm-status" :class="'st-' + r.status">{{ statusText[r.status] ?? r.status }}</span>
              <span class="sm-en">{{ r.en }}</span>
              <span v-if="r.next_review" class="sm-next">下次 {{ r.next_review }}</span>
            </div>
          </div>
        </div>

        <!-- 关联句子 -->
        <div class="sent-box">
          <h4>关联句子（{{ result.sentences.length }}）</h4>
          <div v-if="!result.sentences.length" class="lookup-tip">该词暂无关联句子</div>
          <div v-for="s in result.sentences" :key="s.id" class="sent-row">
            <div class="sent-line">
              <span class="sent-en">{{ s.en }}</span>
              <span class="sent-ops">
                <button class="speaker small" @click="playSentence(s.id)" title="播放句子">🔊</button>
                <button v-if="!s.in_vocab" class="add-btn" @click="addToSm(s.id, result.word.id)" title="加入生词本">＋</button>
                <span v-else class="added">已入本</span>
              </span>
            </div>
            <div class="sent-zh">{{ s.zh }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lookup {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  padding: 30px 16px;
}
.lookup-card {
  width: min(720px, 96vw);
}
.lookup-back {
  margin-bottom: 10px;
}
.speaker {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  padding: 2px 4px;
  color: #64748b;
}
.speaker.small {
  font-size: 13px;
}
.sent-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.sent-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.add-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 18px;
  color: #2563eb;
  padding: 0 4px;
  line-height: 1;
}
.add-btn:hover {
  color: #1d4ed8;
}
.added {
  font-size: 12px;
  color: #94a3b8;
}
.lookup-search {
  position: relative;
  margin-bottom: 18px;
}
.lookup-input {
  width: 100%;
  padding: 12px 18px;
  font-size: 17px;
  border: 2px solid #e2e8f0;
  border-radius: 12px;
  outline: none;
}
.lookup-input:focus {
  border-color: #2563eb;
}
.lookup-drop {
  position: absolute;
  top: 52px;
  left: 0;
  right: 0;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  z-index: 20;
  overflow: hidden;
}
.lookup-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  cursor: pointer;
}
.lookup-item:hover {
  background: #f1f5f9;
}
.li-word {
  font-weight: 600;
}
.li-meaning {
  color: #64748b;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lookup-state {
  text-align: center;
  color: #64748b;
  padding: 40px 0;
}
.lookup-error {
  color: #dc2626;
}
.lookup-tip {
  font-size: 13px;
  color: #94a3b8;
  margin-top: 8px;
}
.lookup-result {
  background: #fff;
  border-radius: 16px;
  padding: 24px 28px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);
}
.word-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.word-title {
  font-size: 30px;
  font-weight: 700;
}
.word-phonetic {
  color: #2563eb;
  font-size: 17px;
  font-family: "DejaVu Sans", sans-serif;
}
.word-meaning {
  font-size: 17px;
  color: #334155;
  margin: 6px 0;
}
.word-meta {
  font-size: 13px;
  color: #94a3b8;
}
.status-box,
.sent-box {
  margin-top: 20px;
  border-top: 1px solid #e2e8f0;
  padding-top: 14px;
}
.status-box h4,
.sent-box h4 {
  font-size: 14px;
  color: #64748b;
  margin-bottom: 10px;
}
.status-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.status-tag {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 13px;
}
.tag-ok {
  background: #dcfce7;
  color: #15803d;
}
.tag-off {
  background: #f1f5f9;
  color: #64748b;
}
.sm-list {
  margin-top: 10px;
}
.sm-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  font-size: 14px;
}
.sm-status {
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  flex-shrink: 0;
}
.st-learning {
  background: #fef9c3;
  color: #a16207;
}
.st-candidate {
  background: #e0e7ff;
  color: #4338ca;
}
.st-mastered {
  background: #fef3c7;
  color: #b45309;
}
.sm-en {
  color: #334155;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-next {
  color: #94a3b8;
  font-size: 12px;
  flex-shrink: 0;
}
.sent-row {
  padding: 10px 0;
  border-bottom: 1px solid #f1f5f9;
}
.sent-en {
  font-size: 15px;
  font-weight: 500;
}
.sent-zh {
  color: #64748b;
  font-size: 14px;
  margin-top: 2px;
}
.sent-op {
  margin-top: 8px;
}
.primary.small {
  padding: 5px 12px;
  font-size: 13px;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  border: none;
  cursor: pointer;
}
</style>
