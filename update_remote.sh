#!/usr/bin/env bash
# 远程库更新脚本（T069）：备份 → git pull → 构建重启（迁移自动补列/回填课序）
# 用法：在远程服务器项目根目录执行 ./update_remote.sh
set -e
cd "$(dirname "$0")"

TS=$(date +%Y%m%d_%H%M%S)
if [ -f data/word_typer.db ]; then
  cp data/word_typer.db "data/word_typer.db.bak_$TS"
  echo "✅ 已备份数据库: data/word_typer.db.bak_$TS"
fi

echo "==> git pull..."
git pull origin main

echo "==> 启动服务（迁移自动补列 + 课序回填）..."
./start.sh
