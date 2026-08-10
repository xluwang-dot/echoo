<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";

const router = useRouter();

interface FootprintDay {
  practice: number;
  review: number;
  test: number;
  levelup: number;
}
const info = ref<{ username: string; nickname: string | null; level: number } | null>(null);
const days = ref<Record<string, FootprintDay>>({});
const stats = ref<{ vocabCount: number; masteredCount: number }>({ vocabCount: 0, masteredCount: 0 });
const loading = ref(true);
const error = ref("");

// 勋章：I-IV 级（对应小学/初中/高中/大学）
const BADGES = [
  { level: 1, name: "I", label: "小学" },
  { level: 2, name: "II", label: "初中" },
  { level: 3, name: "III", label: "高中" },
  { level: 4, name: "IV", label: "大学" },
];

onMounted(async () => {
  try {
    const d = await api.footprint();
    info.value = d.user;
    days.value = d.days;
    stats.value = d.stats;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="settings-page">
    <div class="settings-header">
      <button class="back" @click="router.push('/practice')">← 返回</button>
      <h1>设置</h1>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-else-if="info">
      <!-- 基本信息 -->
      <div class="section">
        <h2>基本信息</h2>
        <div class="info-row"><span>用户名</span><b>{{ info.username }}</b></div>
        <div class="info-row"><span>昵称</span><b>{{ info.nickname || "未设置" }}</b></div>
        <div class="info-row"><span>等级</span><b>{{ info.level }} 级（{{ BADGES[info.level - 1]?.label || "编外" }}）</b></div>
        <div class="info-row"><span>生词本</span><b>{{ stats.vocabCount }} 词</b></div>
        <div class="info-row"><span>已掌握</span><b>{{ stats.masteredCount }} 词</b></div>
      </div>

      <!-- 勋章 -->
      <div class="section">
        <h2>勋章</h2>
        <div class="badge-row">
          <div v-for="b in BADGES" :key="b.level" class="badge-card" :class="{ lit: info.level >= b.level }">
            <div class="badge-icon">{{ info.level >= b.level ? "🏅" : "🏅" }}</div>
            <div class="badge-name">{{ b.name }}</div>
            <div class="badge-label">{{ b.label }}</div>
            <div class="badge-state">{{ info.level >= b.level ? "已解锁" : "未解锁" }}</div>
          </div>
        </div>
      </div>

      <!-- 足迹：过去一周 -->
      <div class="section">
        <h2>足迹（过去 7 天）</h2>
        <table class="foot-table">
          <thead>
            <tr><th>日期</th><th>练习</th><th>复习</th><th>测试</th><th>升级</th></tr>
          </thead>
          <tbody>
            <tr v-for="(d, date) in days" :key="date">
              <td>{{ date.slice(5) }}</td>
              <td>{{ d.practice }}</td>
              <td>{{ d.review }}</td>
              <td>{{ d.test }}</td>
              <td>{{ d.levelup }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.settings-page {
  min-height: 100vh;
  background: #f2f4f8;
  padding: 24px;
  max-width: 720px;
  margin: 0 auto;
}
.settings-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}
.back {
  background: transparent;
  color: #3b6ef6;
  font-size: 15px;
  padding: 6px 12px;
  border: 1px solid #3b6ef6;
  border-radius: 6px;
}
.section {
  background: #fff;
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}
.section h2 {
  font-size: 16px;
  margin: 0 0 12px;
}
.info-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  color: #6b7382;
}
.info-row b {
  color: #1f2430;
}
.badge-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.badge-card {
  text-align: center;
  padding: 14px 6px;
  border: 2px solid #dde2ea;
  border-radius: 10px;
  opacity: 0.45;
  filter: grayscale(1);
}
.badge-card.lit {
  border-color: #ffd700;
  opacity: 1;
  filter: none;
  background: linear-gradient(135deg, #fffbe6, #fff3c4);
}
.badge-icon {
  font-size: 26px;
}
.badge-name {
  font-weight: 800;
  font-size: 18px;
  color: #d48806;
  margin-top: 2px;
}
.badge-label {
  font-size: 12px;
  color: #6b7382;
}
.badge-state {
  font-size: 11px;
  margin-top: 2px;
  color: #999;
}
.foot-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.foot-table th,
.foot-table td {
  border: 1px solid #eee;
  padding: 6px 8px;
  text-align: center;
}
.foot-table th {
  background: #f7f8fa;
  color: #6b7382;
}
.error {
  color: #d33;
  text-align: center;
  margin-bottom: 16px;
}
.empty {
  text-align: center;
  padding: 48px 0;
  color: #9aa1af;
}
</style>
