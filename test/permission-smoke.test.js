// P5 权限确认冒烟测试：验证 claude --permission-prompt-tool 能否通过 MCP 服务触发权限确认
// 场景：claude 需要运行 Bash → 触发 approval_prompt 工具 → MCP server 请求桥接 → 桥接推送(被mock) → 自动回复"允许"
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const BRIDGE_PORT = 8787;
const PROJECT_ROOT = path.join(__dirname, "..");

// ---- 1. 启动一个简易桥接服务（只含 approver 端点 + mock 推送）----
const { Approver } = require("../src/approver");

const sentApprovals = [];
const mockApi = {
  sendText: async (content) => {
    sentApprovals.push(content);
    console.log("[推送] " + content.split("\n")[0].slice(0, 60));
    return { errcode: 0 };
  },
};
const log = {
  info: (m) => console.log("[info] " + m),
  warn: (m) => console.log("[warn] " + m),
  error: (m) => console.log("[error] " + m),
};
const cfg = {
  approver: { timeoutMs: 60000 },
  pusher: { maxChunks: 6, maxBytes: 2048, tokenCacheMs: 60000, earlyRefreshMs: 10000 },
};
const approver = new Approver(
  cfg,
  mockApi,
  {
    pushSectioned: async (n, t) => mockApi.sendText(t),
    sendNotification: async (t) => mockApi.sendText(t),
  },
  log
);

const express = require("express");
const app = express();
app.use(express.json());
app.post("/approval/request", async (req, res) => {
  const r = await approver.request(req.body || {});
  res.json(r);
});
app.get("/approval/status/:id", (req, res) => {
  res.json(approver.status(req.params.id));
});

const server = app.listen(BRIDGE_PORT, "127.0.0.1", () => {
  console.log("冒烟测试桥接已启动 :" + BRIDGE_PORT);
  runClaudeTest();
});

// ---- 2. 启动 claude 触发权限 ----
function runClaudeTest() {
  const bin = process.env.CLAUDE_BIN || "claude";
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "default",
    "--permission-prompt-tool",
    "mcp__wecom_approver__approval_prompt",
    "用 Write 工具在当前工作目录创建一个文件 smoke-test-write.txt，内容写入 测试写文件 这几个字，然后告诉我你做了什么",
  ];
  console.log("启动 claude 触发权限确认…");
  const child = spawn(bin, args, {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH || "bash" },
    shell: false,
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => process.stderr.write(d));

  // 监控：等 approval 请求到达后自动回复"允许"
  const replyTimer = setInterval(() => {
    if (sentApprovals.length > 0 && approver.pending.size > 0) {
      // 找到第一个 pending
      for (const [id, p] of approver.pending) {
        if (!p.resolvedAt) {
          console.log("[测试] 自动回复允许 → " + id.slice(0, 8));
          p.resolvedAt = Date.now();
          p.result = { behavior: "allow", updatedInput: p.originalInput || {} };
          clearInterval(replyTimer);
          return;
        }
      }
    }
  }, 500);

  // 10 秒后未触发权限则判定失败
  const failTimer = setTimeout(() => {
    if (!sentApprovals.length) {
      console.error("FAIL: claude 未触发权限确认（可能静态规则已放行或工具未注册）");
      console.error("stdout:", out.slice(-500));
      server.close();
      process.exit(1);
    }
  }, 20000);

  child.on("close", (code) => {
    clearTimeout(failTimer);
    clearInterval(replyTimer);
    server.close();
    try {
      const lines = out.split("\n").filter((l) => l.trim());
      const result = JSON.parse(lines[lines.length - 1]);
      console.log("\n[claude 结果] " + (result.result || "").slice(0, 300));
      console.log("[权限确认次数]", sentApprovals.length);
      if (sentApprovals.length > 0 && !result.is_error) {
        console.log("\nPASS: claude --permission-prompt-tool 权限确认链路打通");
        process.exit(0);
      } else {
        console.error("FAIL: 权限链路未完全打通");
        process.exit(1);
      }
    } catch (e) {
      console.error("FAIL: 无法解析结果", e.message, out.slice(-300));
      process.exit(1);
    }
  });
}
