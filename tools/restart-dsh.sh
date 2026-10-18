#!/usr/bin/env bash
# 开发用：只重启本项目的 DSH 网页版（按命令行精确匹配 PID，不碰别的 node 进程）；--stop 只停不启
# 密钥按普通用户的方式放在 DSH 主目录的 .env（.dsh-home/.env）；.dev.env 只放开发用的环境变量（DSH_GAME_DDLC_DIR 等）
cd "$(dirname "$0")/.."
for pid in $(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*dsh-game\.runtime*dsh*bin.js web*' -or \$_.CommandLine -like '*.runtime\node_modules\.bin/../@deepseek-ai/dsh/lib/bin.js web*' } | ForEach-Object { \$_.ProcessId }"); do
  taskkill //PID "$pid" //T //F >/dev/null 2>&1 && echo "stopped $pid"
done
[ "${1:-}" = "--stop" ] && exit 0
if [ -f .dev.env ]; then set -a; . ./.dev.env; set +a; fi
export PATH="$(pwd)/tools/node:$PATH" DSH_HOME="$(cygpath -w "$(pwd)/.dsh-home")"
nohup ./.runtime/node_modules/.bin/dsh web --no-open --port 3090 > .dsh-home/web.log 2>&1 &
for i in $(seq 1 40); do grep -q "dsh web:" .dsh-home/web.log 2>/dev/null && break; sleep 2; done
grep -o "http://127.0.0.1:3090/?token=[A-Za-z0-9_-]*" .dsh-home/web.log | head -1
