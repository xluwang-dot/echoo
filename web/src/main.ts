import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import "./style.css";

import LoginView from "./views/LoginView.vue";
import PracticeView from "./views/PracticeView.vue";
import { api } from "./api";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/practice" },
    { path: "/login", component: LoginView },
    { path: "/practice", component: PracticeView },
  ],
});

// 守卫：/practice 需登录
router.beforeEach(async (to) => {
  if (to.path === "/practice") {
    try {
      await api.me();
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
