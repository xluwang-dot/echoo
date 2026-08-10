// 会话配置（T007）
import session from "express-session";

const DEFAULT_SECRET = "echoo-dev-secret";
const SESSION_SECRET = process.env.SESSION_SECRET ?? DEFAULT_SECRET;

// T061：生产环境禁止默认 secret（可伪造 session）——拒绝启动
if (process.env.NODE_ENV === "production" && SESSION_SECRET === DEFAULT_SECRET) {
  throw new Error("生产环境必须设置 SESSION_SECRET 环境变量（当前为默认值，可被伪造会话）");
}

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

export function configureSession() {
  return session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 7 },
  });
}