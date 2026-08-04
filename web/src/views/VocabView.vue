<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api, type VocabEntry, type VocabStats } from "../api";

const router = useRouter();
const vocab = ref<VocabEntry[]>([]);
const stats = ref<VocabStats>({ vocabCount: 0, masteredCount: 0, sentenceCount: 0 });
const loading = ref(true);
const error = ref("");

async function loadData() {
  loading.value = true;
  error.value = "";
  try {
    const [v, s] = await Promise.all([api.getVocab(), api.getVocabStats()]);
    vocab.value = v.vocab;
    stats.value = s;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function remove(wordId: number, sentenceId: number) {
  try {
    await api.deleteVocab(wordId, sentenceId);
    vocab.value = vocab.value.filter((v) => !(v.word_id === wordId && v.sentence_id === sentenceId));
    stats.value.vocabCount--;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(loadData);
</script>

<template>
  <div class="vocab-page">
    <div class="vocab-header">
      <button class="back" @click="router.push('/practice')">← 返回</button>
      <h1>生词本</h1>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <span class="num">{{ stats.vocabCount }}</span>
        <span class="label">生词数</span>
      </div>
      <div class="stat-card">
        <span class="num">{{ stats.masteredCount }}</span>
        <span class="label">已掌握</span>
      </div>
      <div class="stat-card">
        <span class="num">{{ stats.sentenceCount }}</span>
        <span class="label">涉及句子</span>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="loading" class="empty">加载中…</div>

    <div v-else-if="vocab.length === 0" class="empty">
      <p>生词本为空</p>
      <p class="hint">练习中点击「提示」即可将生词加入此处</p>
    </div>

    <div v-else class="vocab-list">
      <div v-for="item in vocab" :key="item.word_id + '-' + item.sentence_id" class="vocab-item">
        <div class="word">{{ item.word }}</div>
        <div class="sentence">
          <div class="en">{{ item.en }}</div>
          <div class="zh">{{ item.zh }}</div>
        </div>
        <button class="del" @click="remove(item.word_id, item.sentence_id)">×</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vocab-page {
  min-height: 100vh;
  background: #f2f4f8;
  padding: 24px;
  max-width: 720px;
  margin: 0 auto;
}
.vocab-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}
.vocab-header h1 {
  font-size: 22px;
  font-weight: 700;
}
.back {
  background: transparent;
  color: #3b6ef6;
  font-size: 15px;
  padding: 6px 12px;
  border: 1px solid #3b6ef6;
  border-radius: 6px;
}
.stats-row {
  display: flex;
  gap: 16px;
  margin-bottom: 24px;
}
.stat-card {
  flex: 1;
  background: #fff;
  border-radius: 12px;
  padding: 20px;
  text-align: center;
  box-shadow: 0 2px 8px rgba(0,0,0,0.04);
}
.stat-card .num {
  display: block;
  font-size: 32px;
  font-weight: 700;
  color: #3b6ef6;
}
.stat-card .label {
  display: block;
  margin-top: 4px;
  color: #6b7382;
  font-size: 13px;
}
.empty {
  text-align: center;
  padding: 48px 0;
  color: #9aa1af;
  font-size: 16px;
}
.empty .hint {
  font-size: 13px;
  margin-top: 8px;
}
.error {
  color: #d33;
  text-align: center;
  margin-bottom: 16px;
}
.vocab-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.vocab-item {
  display: flex;
  align-items: center;
  gap: 14px;
  background: #fff;
  border-radius: 10px;
  padding: 14px 16px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.04);
}
.vocab-item .word {
  font-size: 18px;
  font-weight: 700;
  color: #1f2430;
  min-width: 80px;
}
.vocab-item .sentence {
  flex: 1;
  min-width: 0;
}
.vocab-item .sentence .en {
  font-size: 14px;
  color: #333a46;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vocab-item .sentence .zh {
  font-size: 13px;
  color: #6b7382;
  margin-top: 2px;
}
.del {
  background: transparent;
  color: #ccc;
  font-size: 20px;
  padding: 4px 8px;
  border: none;
  cursor: pointer;
  line-height: 1;
}
.del:hover {
  color: #e33;
}
</style>
