import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./style.css";

import LoginView from "./views/LoginView.vue";
import PracticeView from "./views/PracticeView.vue";
import VocabView from "./views/VocabView.vue";
import SettingsView from "./views/SettingsView.vue";
import DictationView from "./views/DictationView.vue";
import LookupView from "./views/LookupView.vue";
import AdminView from "./views/AdminView.vue";
import { api } from "./api";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/practice" },
    { path: "/login", component: LoginView },
    { path: "/practice", component: PracticeView },
    { path: "/vocab", component: VocabView },
    { path: "/settings", component: SettingsView },
    { path: "/dictation", component: DictationView }, // T069
    { path: "/lookup", component: LookupView }, // T070 单词查询
    { path: "/admin", component: AdminView }, // T075 管理后台
  ],
});

// 守卫：需登录的页面
const authPaths = ["/practice", "/vocab", "/settings", "/dictation", "/lookup", "/admin"]; // T075
router.beforeEach(async (to) => {
  if (authPaths.includes(to.path)) {
    try {
      const me = await api.me();
      if (to.path === "/admin" && me.role !== "admin") return "/practice";
    } catch {
      return "/login";
    }
  }
  if (to.path === "/login") {
    try {
      await api.me();
      return "/practice";
    } catch {
      // 未登录留在登录页
    }
  }
});

createApp(App).use(router).mount("#app");
