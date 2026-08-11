#!/usr/bin/env bash
# word-typer 启动脚本：先停旧进程，再启动后端 + 前端（T019）
# 用法：
#   ./start.sh         默认生产环境：build（tsc + vite build）→ node dist/index.js，
#                      单端口 3008 同时服务前端静态 + API（局域网部署形态）
#   ./start.sh dev     开发环境：npm run dev（3008）+ npm run dev:web（5173，vite 代理 /api）
set -u
cd "$(dirname "$0")"

MODE="${1:-prod}" # prod（默认）/ dev

echo "==> 停止已启动的 word-typer 进程..."
# npm 父进程（dev 与 dev:web 均含 "npm run dev" 前缀；start / preview 同理）
pkill -f "npm run dev"     2>/dev/null && echo "    已停止 npm(dev)"      || true
pkill -f "npm run start"   2>/dev/null && echo "    已停止 npm(start)"    || true
pkill -f "npm run preview" 2>/dev/null && echo "    已停止 npm(preview)"  || true
# 后端进程（dev: tsx src/index.ts；prod: node dist/index.js）
pkill -f "src/index.ts"    2>/dev/null && echo "    已停止后端(dev)"      || true
pkill -f "dist/index.js"   2>/dev/null && echo "    已停止后端(prod)"     || true
# 前端进程（vite，dev 模式；ps 命令行形如 node …/web/node_modules/.bin/vite）
pkill -f "web/node_modules/.bin/vite" 2>/dev/null && echo "    已停止前端(vite)" || true
sleep 1
echo "    完成"

mkdir -p logs

if [ "$MODE" = "dev" ]; then
  echo "==> 启动开发环境"
  echo "    后端: npm run dev      → http://localhost:3008"
  echo "    前端: npm run dev:web  → http://localhost:5173 (vite 代理 /api)"
  nohup npm run dev     > logs/backend.log  2>&1 &
  nohup npm run dev:web > logs/frontend.log 2>&1 &
  sleep 5
  echo "==> 健康检查"
  # T069：迁移/回填可能耗时，最多等 15s
  ok=0
  for _ in $(seq 1 15); do
    if curl -s http://localhost:3008/health | grep -q '"ok":true'; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" = "1" ]; then
    echo "    后端 OK → http://localhost:3008"
  else
    echo "    ⚠️ 后端健康检查失败，请查看 logs/backend.log"
  fi
  curl -s -o /dev/null -w "    前端 http://localhost:5173 → HTTP %{http_code}\n" http://localhost:5173/
else
  echo "==> 构建生产产物（npm run build + 前端 vite build）"
  # T060：确保前端依赖已安装（web/node_modules 不入 git，clone 后为空）
  if [ ! -d web/node_modules ]; then
    echo "==> 安装前端依赖（web/npm install，首次）..."
    (cd web && npm install) || { echo "前端依赖安装失败，请检查网络"; exit 1; }
  fi
  npm run build && npm run build --prefix web || { echo "构建失败，请检查报错"; exit 1; }
  echo "==> 启动生产（node dist/index.js，单端口 3008）"
  nohup npm run start > logs/backend.log 2>&1 &
  echo "==> 健康检查"
  # T069：首次迁移/课序回填/人名重标可能耗时，最多等 15s
  ok=0
  for _ in $(seq 1 15); do
    if curl -s http://localhost:3008/health | grep -q '"ok":true'; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" = "1" ]; then
    echo "    后端 OK → http://localhost:3008"
  else
    echo "    ⚠️ 后端健康检查失败，请查看 logs/backend.log"
  fi
  curl -s -o /dev/null -w "    首页 http://localhost:3008 → HTTP %{http_code}\n" http://localhost:3008/
fi

echo ""
echo "日志: logs/backend.log$( [ -f logs/frontend.log ] && echo ' / logs/frontend.log' )"
