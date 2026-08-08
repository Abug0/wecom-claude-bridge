// VSCode claude 进程包装器
// 作用：把 VSCode 扩展启动 claude 时的 --permission-prompt-tool stdio 改写为
//       mcp__wecom_approver__approval_prompt，让授权确认转到企业微信。
// 用法：VSCode settings 配置 claudeCode.claudeProcessWrapper 指向本脚本。
// 风险：若 wecom_approver MCP 不可用（桥接未运行），授权会卡住。此时请改回 stdio。
const { spawn } = require("child_process");

const args = process.argv.slice(2);
if (!args.length) {
  console.error("[vscode-wrapper] 用法: node vscode-wrapper.cjs <claude二进制> <参数...>");
  process.exit(1);
}
const target = args[0];
const rest = args.slice(1);

// 改写权限确认工具
const idx = rest.indexOf("--permission-prompt-tool");
if (idx !== -1) {
  if (rest[idx + 1] === "stdio") {
    rest[idx + 1] = "mcp__wecom_approver__approval_prompt";
  }
} else {
  rest.push("--permission-prompt-tool", "mcp__wecom_approver__approval_prompt");
}

const child = spawn(target, rest, { stdio: "inherit", env: process.env });
child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code === null ? 1 : code);
});
child.on("error", (e) => {
  console.error("[vscode-wrapper] 启动 claude 失败:", e.message);
  process.exit(1);
});
