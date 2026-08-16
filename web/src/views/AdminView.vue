<script setup lang="ts">
// T075：管理页（仅 admin 角色）——用户 / 错误句子 / 邀请码
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";

const router = useRouter();
const tab = ref<"users" | "sentences" | "invites">("users");
const error = ref("");
const busy = ref(false);

// 用户
const users = ref<Awaited<ReturnType<typeof api.adminUsers>>["users"]>([]);
async function loadUsers() {
  try {
    users.value = (await api.adminUsers()).users;
  } catch (e) { error.value = (e as Error).message; }
}
async function userAction(u: any, action: "disable" | "enable" | "delete") {
  if (action === "delete" && !confirm(`确认删除用户 ${u.username}？（其生词本/记录/报告将一并删除）`)) return;
  busy.value = true;
  try {
    await api.adminUserAction(u.id, action);
    await loadUsers();
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}

// 报告/句子
const reports = ref<Awaited<ReturnType<typeof api.adminReports>>["reports"]>([]);
const openId = ref<number | null>(null);
const editEn = ref("");
const editZh = ref("");
const editFile = ref<File | null>(null);
async function loadReports() {
  try {
    reports.value = (await api.adminReports()).reports;
  } catch (e) { error.value = (e as Error).message; }
}
function expand(r: any) {
  openId.value = openId.value === r.id ? null : r.id;
  editEn.value = r.en;
  editZh.value = r.zh;
  editFile.value = null;
}
async function handleReport(id: number) {
  await api.adminHandleReport(id);
  await loadReports();
}
function onFile(e: Event) {
  const el = e.target as HTMLInputElement;
  editFile.value = el.files?.[0] ?? null;
}
async function saveSentence(r: any) {
  if (!editEn.value.trim()) { error.value = "句子不能为空"; return; }
  busy.value = true;
  try {
    await api.adminUpdateSentence(r.sentence_id, { en: editEn.value, zh: editZh.value, file: editFile.value ?? undefined });
    await loadReports();
    openId.value = null;
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function deleteSentence(r: any) {
  if (!confirm(`确认删除句子「${r.en}」？（词句对/记录/音频一并删除）`)) return;
  busy.value = true;
  try {
    await api.adminDeleteSentence(r.sentence_id);
    await loadReports();
    openId.value = null;
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}

// 邀请码
const invites = ref<Awaited<ReturnType<typeof api.adminInvites>>["invites"]>([]);
async function loadInvites() {
  try {
    invites.value = (await api.adminInvites()).invites;
  } catch (e) { error.value = (e as Error).message; }
}
async function createInvite() {
  await api.adminCreateInvite();
  await loadInvites();
}
async function toggleInvite(id: number) {
  await api.adminToggleInvite(id);
  await loadInvites();
}

function playSentence(sid: number) {
  const a = new Audio(api.audioUrl(sid));
  a.play().catch(() => {});
}

onMounted(async () => {
  loadUsers();
  loadReports();
  loadInvites();
});
</script>

<template>
  <div class="admin">
    <div class="admin-card">
      <div class="admin-top">
        <span class="admin-title">🛠 管理后台</span>
        <button class="ghost" @click="router.push('/practice')">← 返回</button>
      </div>
      <p v-if="error" class="admin-error">{{ error }}</p>

      <div class="admin-tabs">
        <button :class="{ active: tab === 'users' }" @click="tab = 'users'">用户管理</button>
        <button :class="{ active: tab === 'sentences' }" @click="tab = 'sentences'">错误句子</button>
        <button :class="{ active: tab === 'invites' }" @click="tab = 'invites'">邀请码</button>
      </div>

      <!-- 用户管理 -->
      <div v-if="tab === 'users'">
        <table class="admin-table">
          <thead>
            <tr><th>ID</th><th>用户名</th><th>角色</th><th>状态</th><th>等级</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td>{{ u.id }}</td>
              <td>{{ u.username }}</td>
              <td>{{ u.role === 'admin' ? '管理员' : '用户' }}</td>
              <td>
                <span :class="u.status === 'active' ? 'st-ok' : 'st-off'">{{ u.status === 'active' ? '正常' : '停用' }}</span>
              </td>
              <td>{{ u.level }}</td>
              <td class="ops">
                <button v-if="u.status === 'active'" class="plain" @click="userAction(u, 'disable')">停用</button>
                <button v-else class="plain" @click="userAction(u, 'enable')">启用</button>
                <button v-if="u.role !== 'admin'" class="danger-plain" @click="userAction(u, 'delete')">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 错误句子 -->
      <div v-else-if="tab === 'sentences'">
        <div v-if="!reports.length" class="admin-empty">暂无报告</div>
        <div v-for="r in reports" :key="r.id" class="report-item">
          <div class="report-line" @click="expand(r)">
            <span class="rep-status" :class="r.status === 'pending' ? 'st-off' : 'st-ok'">{{ r.status === 'pending' ? '待处理' : '已处理' }}</span>
            <span class="rep-en">{{ r.en }}</span>
            <span class="rep-meta">{{ r.username ?? '已删用户' }} · {{ r.time?.slice(0, 10) }}</span>
          </div>
          <div v-if="openId === r.id" class="report-detail">
            <p class="rep-zh">{{ r.zh }}</p>
            <p v-if="r.description" class="rep-desc">📌 {{ r.description }}</p>
            <div class="rep-edit">
              <input v-model="editEn" class="edit-input" placeholder="英文" />
              <input v-model="editZh" class="edit-input" placeholder="中文" />
              <input type="file" accept=".mp3" class="edit-file" @change="onFile" />
            </div>
            <div class="rep-ops">
              <button class="ghost" @click="playSentence(r.sentence_id)">🔊 播放</button>
              <button class="primary small" :disabled="busy" @click="saveSentence(r)">💾 更新+替换音频</button>
              <button class="ghost" @click="handleReport(r.id)">✔ 标记已处理</button>
              <button class="danger-plain" @click="deleteSentence(r)">🗑 删除句子</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 邀请码 -->
      <div v-else-if="tab === 'invites'">
        <div class="invite-create">
          <button class="primary small" @click="createInvite">＋ 生成邀请码</button>
        </div>
        <table class="admin-table">
          <thead>
            <tr><th>邀请码</th><th>状态</th><th>使用者</th><th>使用时间</th><th>创建时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="i in invites" :key="i.id">
              <td class="code">{{ i.code }}</td>
              <td>
                <span :class="i.enabled ? 'st-ok' : 'st-off'">{{ i.enabled ? (i.used_by ? '已使用' : '可用') : '停用' }}</span>
              </td>
              <td>{{ i.used_by_name ?? '—' }}</td>
              <td>{{ i.used_at?.slice(0, 10) ?? '—' }}</td>
              <td>{{ i.created_at?.slice(0, 10) }}</td>
              <td><button class="plain" @click="toggleInvite(i.id)">{{ i.enabled ? '停用' : '启用' }}</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.admin {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  padding: 24px 16px;
}
.admin-card {
  width: min(860px, 96vw);
  background: #fff;
  border-radius: 16px;
  padding: 24px 28px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);
}
.admin-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.admin-title {
  font-size: 20px;
  font-weight: 800;
}
.admin-error {
  color: #dc2626;
  font-size: 14px;
}
.admin-tabs {
  display: flex;
  gap: 8px;
  border-bottom: 2px solid #e2e8f0;
  margin-bottom: 16px;
}
.admin-tabs button {
  padding: 8px 16px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  color: #64748b;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
}
.admin-tabs button.active {
  color: #2563eb;
  border-bottom-color: #2563eb;
  font-weight: 600;
}
.admin-table {
  width: 100%;
  border-collapse: collapse;
}
.admin-table th,
.admin-table td {
  padding: 8px 10px;
  border-bottom: 1px solid #f1f5f9;
  text-align: left;
  font-size: 14px;
}
.admin-table th {
  color: #94a3b8;
  font-size: 12px;
}
.st-ok { color: #15803d; background: #dcfce7; padding: 2px 8px; border-radius: 6px; font-size: 12px; }
.st-off { color: #b45309; background: #fef3c7; padding: 2px 8px; border-radius: 6px; font-size: 12px; }
.ops button { margin-right: 6px; }
.plain { background: none; border: none; color: #2563eb; cursor: pointer; font-size: 13px; }
.danger-plain { background: none; border: none; color: #dc2626; cursor: pointer; font-size: 13px; }
.admin-empty { color: #94a3b8; text-align: center; padding: 30px; }
.report-item { border-bottom: 1px solid #f1f5f9; }
.report-line {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  cursor: pointer;
}
.report-line:hover { background: #f8fafc; }
.rep-status { padding: 2px 8px; border-radius: 6px; font-size: 12px; flex-shrink: 0; }
.rep-en { flex: 1; font-weight: 500; }
.rep-meta { color: #94a3b8; font-size: 12px; flex-shrink: 0; }
.report-detail { padding: 10px 0 14px 4px; }
.rep-zh { color: #64748b; }
.rep-desc { color: #b45309; font-size: 13px; margin-top: 4px; }
.rep-edit { display: flex; gap: 8px; margin: 10px 0; flex-wrap: wrap; }
.edit-input {
  flex: 1;
  min-width: 200px;
  padding: 8px 12px;
  border: 1.5px solid #e2e8f0;
  border-radius: 8px;
  font-size: 14px;
}
.edit-file { font-size: 13px; }
.rep-ops { display: flex; gap: 8px; flex-wrap: wrap; }
.invite-create { margin-bottom: 12px; }
.code { font-family: monospace; font-weight: 600; }
</style>
