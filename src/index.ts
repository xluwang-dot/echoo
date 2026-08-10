// 后端入口：启动时初始化数据库并起 HTTP 服务
import fs from "fs";
import path from "path";
import express from "express";
import { DB_PATH, initDb } from "./db.js";
import { seedIfEmpty } from "./db/seed.js";
import { configureSession } from "./sessionStore.js";
import { authRouter } from "./routes/auth.js";
import { practiceRouter } from "./routes/practice.js";
import { audioRouter } from "./routes/audio.js";
import { vocabRouter } from "./routes/vocab.js";

const PORT = Number(process.env.PORT ?? 3008);

const db = initDb(DB_PATH);
// T006：空库自动 seed（句子池就绪即服务可用）
seedIfEmpty(db);

const app = express();
app.use(express.json());
app.use(configureSession());

app.get("/health", (_req, res) => {
  res.json({ ok: true, db: DB_PATH });
});

app.use("/api/auth", authRouter());
app.use("/api/practice", practiceRouter());
app.use("/api/audio", audioRouter());
app.use("/api/vocab", vocabRouter());

// T019：生产静态托管（web/dist 存在时，单端口 3008 同时服务前端 + API）
const WEB_DIST = path.join(import.meta.dirname, "..", "web", "dist");
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  // history 路由回退：非 /api 的 GET 返回 index.html（如 /vocab）
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`echoo 服务已启动: http://localhost:${PORT}`);
});
