// 后端入口：启动时初始化数据库并起 HTTP 服务
import express from "express";
import { DB_PATH, initDb } from "./db.js";
import { seedIfEmpty } from "./db/seed.js";
import { configureSession } from "./sessionStore.js";
import { authRouter } from "./routes/auth.js";
import { practiceRouter } from "./routes/practice.js";
import { audioRouter } from "./routes/audio.js";

const PORT = Number(process.env.PORT ?? 3000);

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

app.listen(PORT, () => {
  console.log(`word-typer 服务已启动: http://localhost:${PORT}`);
});
