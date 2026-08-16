// 后端入口：启动时初始化数据库并起 HTTP 服务
import fs from "fs";
import path from "path";
import express from "express";
import helmet from "helmet";
import { DB_PATH, initDb } from "./db.js";
import { seedIfEmpty } from "./db/seed.js";
import { configureSession } from "./sessionStore.js";
import { authRouter } from "./routes/auth.js";
import { practiceRouter } from "./routes/practice.js";
import { audioRouter } from "./routes/audio.js";
import { vocabRouter } from "./routes/vocab.js";
import { adminRouter } from "./routes/admin.js";

const PORT = Number(process.env.PORT ?? 3008);

const db = initDb(DB_PATH);
// T006：空库自动 seed（句子池就绪即服务可用）
seedIfEmpty(db);

const app = express();
app.set("trust proxy", 1); // 反代部署：req.secure 依据 X-Forwarded-Proto（Nginx HTTPS → secure cookie 正常）
app.use(helmet()); // T074：安全响应头（X-Frame-Options/nosniff 等）
app.use(express.json());
app.use(configureSession());

app.get("/health", (_req, res) => {
  res.json({ ok: true, db: DB_PATH });
});

app.use("/api/auth", authRouter());
app.use("/api/practice", practiceRouter());
app.use("/api/audio", audioRouter());
app.use("/api/vocab", vocabRouter());
app.use("/api/admin", adminRouter()); // T075 管理

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

// T074：错误处理（不泄露堆栈；JSON 解析错误返回 400）
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (res.headersSent) return;
  // 请求体 JSON 解析失败 → 客户端错误 400（非服务器问题）
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "请求体格式错误" });
    return;
  }
  res.status(500).json({ error: process.env.NODE_ENV === "production" ? "服务器内部错误" : String(err?.message ?? err) });
});

app.listen(PORT, () => {
  console.log(`echoo 服务已启动: http://localhost:${PORT}`);
});
