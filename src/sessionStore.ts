// 会话配置（T007）
import session from "express-session";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "echoo-dev-secret";

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