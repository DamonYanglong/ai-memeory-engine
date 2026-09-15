#!/usr/bin/env node

/**
 * VM 引导服务 — 让虚拟机一条 curl 完成多机同步接入
 * @author longfei5
 * @date 2026/9/15
 *
 * 在 Mac（或任意一台已接入的机器）上启动：
 *   node dist/bin/bootstrap-server.js            # 默认 0.0.0.0:8770
 *   PORT=9000 node dist/bin/bootstrap-server.js  # 自定义端口
 *
 * 虚拟机上执行：
 *   curl -fsSL http://<本机IP>:8770/install.sh | bash
 *
 * 端点：
 *   GET /health          健康检查
 *   GET /install.sh      接入脚本（自动注入当前请求的主机地址）
 *   GET /setup-hooks.mjs 钩子更新脚本（install.sh 内部调用）
 *
 * 仅限局域网引导用途：服务只读不写、无鉴权，用完可关。
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

const PORT = parseInt(process.env.PORT ?? "8770", 10);
const BIND = process.env.BIND ?? "0.0.0.0";
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");

async function main() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }

      if (url.pathname === "/install.sh") {
        const tpl = await readFile(join(scriptsDir, "vm-install.sh"), "utf-8");
        // 把脚本里的占位符替换为本次请求的实际地址，脚本内部再拉 setup-hooks.mjs 时用相对路径
        const body = tpl.replaceAll("${BOOTSTRAP_BASE}", `http://${req.headers.host}`);
        res.writeHead(200, { "Content-Type": "text/x-shellscript; charset=utf-8" });
        res.end(body);
        return;
      }

      if (url.pathname === "/setup-hooks.mjs") {
        const body = await readFile(join(scriptsDir, "setup-hooks.mjs"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        res.end(body);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found\n");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`error: ${e instanceof Error ? e.message : e}\n`);
    }
  });

  server.listen(PORT, BIND, () => {
    console.log(`[ai-memory] 引导服务已启动: http://${BIND}:${PORT}`);
    console.log(`[ai-memory] 虚拟机接入命令: curl -fsSL http://<本机IP>:${PORT}/install.sh | bash`);
    console.log(`[ai-memory] 主机名: ${hostname()}（虚拟机需能访问本机该端口）`);
  });
}

main().catch((e) => {
  console.error("引导服务启动失败:", e);
  process.exit(1);
});
