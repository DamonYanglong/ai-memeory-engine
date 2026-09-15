#!/usr/bin/env bash
# ai-memory-engine 虚拟机接入脚本
#
# 在每台虚拟机上执行（Mac 上跑 bootstrap-server 后）：
#   curl -fsSL http://<mac-ip>:8770/install.sh | bash
#
# 路径可用环境变量覆盖：ENGINE_DIR / MEMORY_DIR
set -euo pipefail

ENGINE_DIR="${ENGINE_DIR:-$HOME/ai-memory/ai-memory-engine}"
MEMORY_DIR="${MEMORY_DIR:-$HOME/ai-memory/memory}"
BOOTSTRAP_BASE="${BOOTSTRAP_BASE}"

echo "==> [1/4] 更新引擎 ($ENGINE_DIR)"
cd "$ENGINE_DIR"
git pull --ff-only
npm install --no-fund --no-audit --silent
npm run build

echo "==> [2/4] 迁移本机候选队列（必须在首次同步之前）"
MEMORY_DIR="$MEMORY_DIR" ENGINE_DIR="$ENGINE_DIR" node -e "
import(process.env.ENGINE_DIR + '/dist/core/storage/candidate-queue.js').then(async (m) => {
  const q = new m.CandidateQueue(process.env.MEMORY_DIR);
  const items = await q.getAll();
  console.log('    候选队列已迁移为本机私有，待提取候选数: ' + items.length);
});
"

echo "==> [3/4] 接入多机同步（保留现有 GitHub 远端）"
MEMORY_DIR="$MEMORY_DIR" node "$ENGINE_DIR/dist/bin/mem-sync.js" init
MEMORY_DIR="$MEMORY_DIR" node "$ENGINE_DIR/dist/bin/mem-sync.js" sync

echo "==> [4/4] 更新 Claude Code 钩子"
HOOKS_SCRIPT="$(mktemp /tmp/ai-memory-setup-hooks.XXXXXX.mjs)"
trap 'rm -f "$HOOKS_SCRIPT"' EXIT
curl -fsSL "$BOOTSTRAP_BASE/setup-hooks.mjs" -o "$HOOKS_SCRIPT"
ENGINE_DIR="$ENGINE_DIR" MEMORY_DIR="$MEMORY_DIR" node "$HOOKS_SCRIPT"

echo ""
echo "✅ 接入完成。开一个 Claude Code 会话说句话，会话结束后"
echo "   GitHub 记忆仓库应出现 ai-memory ($(hostname)) 的自动提交。"
