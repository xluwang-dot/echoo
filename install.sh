#!/usr/bin/env bash
# echoo 一键安装脚本（T075）：环境检查 → 依赖 → 音频检查 → 管理员设置 → 启动
# 用法：./install.sh
set -u
cd "$(dirname "$0")"

echo "========================================"
echo "  echoo 在线背单词 · 一键安装"
echo "========================================"

# ---------- 1. 环境检查 ----------
echo "==> 检查运行环境..."
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
if [ -z "$NODE_MAJOR" ]; then
  echo "❌ 未安装 Node.js（要求 ≥22，内置 node:sqlite）"
  exit 1
fi
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "❌ Node.js 版本过低：$NODE_MAJOR（要求 ≥22）"
  exit 1
fi
echo "  ✅ Node.js v$(node -v | sed 's/^v//')"
command -v npm >/dev/null || { echo "❌ 未安装 npm"; exit 1; }
command -v git >/dev/null || { echo "❌ 未安装 git"; exit 1; }

# ---------- 2. 安装依赖 ----------
echo "==> 安装后端依赖..."
npm install || { echo "❌ 后端依赖安装失败"; exit 1; }
echo "==> 安装前端依赖..."
(cd web && npm install) || { echo "❌ 前端依赖安装失败"; exit 1; }
echo "==> 编译后端（迁移/管理员设置需要 dist/）..."
npm run build >/dev/null 2>&1 || { echo "❌ 后端编译失败"; exit 1; }

# ---------- 3. 音频文件检查 ----------
echo "==> 检查语音文件..."
SENT_AUDIO=$(ls data/audio/*.mp3 data/audio/*.wav 2>/dev/null | wc -l)
WORD_AUDIO=$(ls data/nce/audio/*.mp3 2>/dev/null | wc -l)
echo "  句音频: $SENT_AUDIO 个；词音频: $WORD_AUDIO 个"
if [ "$SENT_AUDIO" -eq 0 ]; then
  echo "  ⚠️ 未检测到句音频——请从内容机拷贝 data/audio/ 目录（5525 句）"
  read -rp "  继续安装？[y/N] " c
  [ "$c" = "y" ] || exit 1
fi

# ---------- 4. 管理员设置 ----------
echo "==> 设置管理员账户（数据库迁移自动执行）..."
# 先跑一次迁移（建表/补列）
node -e "
const { initDb } = require('./dist/db.js');
initDb('data/word_typer.db');
console.log('  数据库迁移完成');
"

# 交互式设置管理员（用户名 + 密码；密码策略 ≥8 位 + 3 类字符）
ADMIN_USER="${ADMIN_USER:-xluwang}"
read -rp "  管理员用户名 [${ADMIN_USER}]：" input_user
if [ -n "$input_user" ]; then ADMIN_USER="$input_user"; fi

while true; do
  read -rsp "  管理员密码（≥8 位，含数字/特殊/大小写字母中至少 3 类）：" ADMIN_PASS
  echo ""
  if [ -z "$ADMIN_PASS" ]; then continue; fi
  read -rsp "  再次输入密码：" ADMIN_PASS2
  echo ""
  [ "$ADMIN_PASS" != "$ADMIN_PASS2" ] && { echo "  ⚠️ 两次输入不一致"; continue; }
  node -e "
const { validatePassword } = require('./dist/auth.js');
const err = validatePassword(process.argv[1]);
if (err) { console.log('  ⚠️ ' + err); process.exit(1); }
" "$ADMIN_PASS" && break
done

# 创建/升级管理员（密码哈希后落库；已存在则更新 role+密码）
node -e "
const { initDb } = require('./dist/db.js');
const { hashPassword } = require('./dist/auth.js');
const db = initDb('data/word_typer.db');
const user = process.argv[1];
const pass = process.argv[2];
const exist = db.prepare('SELECT id FROM users WHERE username=?').get(user);
if (exist) {
  db.prepare(\"UPDATE users SET role='admin', status='active', password_hash=? WHERE id=?\").run(hashPassword(pass), exist.id);
  console.log('  ✅ 已升级为管理员：' + user);
} else {
  db.prepare(\"INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')\").run(user, hashPassword(pass));
  console.log('  ✅ 已创建管理员：' + user);
}
db.close();
" "$ADMIN_USER" "$ADMIN_PASS"

# ---------- 5. 启动 ----------
echo "==> 启动系统..."
./start.sh
