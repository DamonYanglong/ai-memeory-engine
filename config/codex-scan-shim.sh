#!/bin/sh
# 从环境变量或 stdin JSON 提取用户消息，供 scan.js 的 USER_PROMPT 使用。
# env 优先（Claude Code 通道）；否则读 stdin 解析 JSON（Codex 通道，兼容 prompt/user_prompt/input 字段名）。
# 2 秒超时保护：stdin 无输入时不挂起，输出空串（scan.js 对空输入安全跳过）。
if [ -n "$USER_PROMPT" ]; then
  printf '%s' "$USER_PROMPT"
  exit 0
fi
NODE_BIN=$(command -v node 2>/dev/null || printf '%s' /opt/homebrew/bin/node)
exec "$NODE_BIN" -e '
let s = "", done = false;
const emit = () => {
  if (done) return;
  done = true;
  try {
    const j = JSON.parse(s);
    const p = j.prompt ?? j.user_prompt ?? j.input ?? "";
    process.stdout.write(typeof p === "string" ? p : JSON.stringify(p));
  } catch { /* 非 JSON 负载，放弃 */ }
};
const t = setTimeout(emit, 2000);
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => { clearTimeout(t); emit(); });
'
