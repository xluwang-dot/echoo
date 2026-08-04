<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";

const router = useRouter();
const mode = ref<"login" | "register">("login");
const username = ref("");
const password = ref("");
const nickname = ref("");
const error = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
  if (!username.value || !password.value) {
    error.value = "用户名与密码必填";
    return;
  }
  if (mode.value === "register" && !nickname.value) {
    error.value = "请填写昵称";
    return;
  }
  busy.value = true;
  try {
    if (mode.value === "register") {
      await api.register(username.value, password.value, nickname.value);
      await api.login(username.value, password.value);
    } else {
      await api.login(username.value, password.value);
    }
    router.push("/practice");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <h1>背单词平台</h1>
      <div class="tabs">
        <button :class="{ active: mode === 'login' }" @click="mode = 'login'">登录</button>
        <button :class="{ active: mode === 'register' }" @click="mode = 'register'">注册</button>
      </div>
      <div class="field">
        <input v-model="username" placeholder="用户名" @keyup.enter="submit" />
      </div>
      <div v-if="mode === 'register'" class="field">
        <input v-model="nickname" placeholder="昵称" @keyup.enter="submit" />
      </div>
      <div class="field">
        <input v-model="password" type="password" placeholder="密码" @keyup.enter="submit" />
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <button class="primary" :disabled="busy" @click="submit">
        {{ mode === "login" ? "登录" : "注册并登录" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.login-card {
  width: 320px;
  background: #fff;
  border-radius: 10px;
  padding: 28px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
}
h1 {
  text-align: center;
  font-size: 20px;
  margin-bottom: 16px;
}
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.tabs button {
  flex: 1;
  background: #e8ecf3;
  color: #1f2430;
}
.tabs button.active {
  background: #3b6ef6;
  color: #fff;
}
.field {
  margin-bottom: 12px;
}
.primary {
  width: 100%;
  margin-top: 8px;
}
.error {
  color: #d33;
  font-size: 13px;
  margin-bottom: 8px;
}
</style>
