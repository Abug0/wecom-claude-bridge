// 流式推送逻辑测试 v2：从 .env 读路径，验证 _run 的流式增量推送
const fs = require("fs");
const path = require("path");
const { ClaudeRunner } = require("../src/claude");
const { ProjectRegistry } = require("../src/projects");

// 从 .env 读取配置
const env = {};
for (const l of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const [k, ...v] = t.split("=");
  env[k.trim()] = v.join("=").trim();
}

const cfg = {
  claude: {
    bin: env.CLAUDE_BIN || "/home/user\\USER\\.local\\bin\\claude.exe",
    workdir: "/path\\projects\\PROJECT",
    sessionDir: "/home/user\\USER\\.claude\\projects",
    permissionMode: "bypassPermissions",
    gitBashPath: env.CLAUDE_CODE_GIT_BASH_PATH || "D:\\devtools\\git\\Git\\bin\\bash.exe",
    idleTimeoutMs: 180000,
    totalTimeoutMs: 180000,
  },
};

const pushes = [];
const mockPusher = {
  pushSectioned: async (name, text, ms) => {
    pushes.push({ at: Date.now(), text: String(text), kind: "sectioned" });
    console.log(`[推送 ${pushes.length}] ${String(text).slice(0, 60).replace(/\n/g, " ")}`);
  },
  pushStyled: async (name, text, kind, ms) => {
    pushes.push({ at: Date.now(), text: String(text), kind });
    console.log(`[推送 ${pushes.length}] (${kind}) ${String(text).slice(0, 60).replace(/\n/g, " ")}`);
  },
};

const runner = new ClaudeRunner(cfg, console, new ProjectRegistry(null), mockPusher);

const job = {
  taskName: "样式测试",
  sessionId: "00000000-0000-4000-8000-000000000000",
  cwd: "/path\\projects\\PROJECT",
  prompt: "用 Bash 运行 `echo 样式测试完成`，然后用一句话总结结果",
  isNew: false,
};

async function main() {
  await runner._run(job);
  console.log("\n=== 结果 ===");
  console.log("总推送次数:", pushes.length);
  for (const p of pushes) console.log(`  - [${p.kind}] ${JSON.stringify(p.text.slice(0, 45))}`);
  const kinds = new Set(pushes.map((p) => p.kind));
  console.log("出现的类型:", [...kinds].join(", "));
  console.log(kinds.has("reply") ? "✅ 有回复推送" : "⚠️ 无回复");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
