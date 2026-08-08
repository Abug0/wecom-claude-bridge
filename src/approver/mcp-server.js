#!/usr/bin/env node
// 权限确认 MCP 服务（独立进程，由 claude --permission-prompt-tool 启动）
// 通过 HTTP 与本机桥接服务通信：
//   发起请求: POST http://127.0.0.1:{BRIDGE_PORT}/approval/request
//   轮询状态: GET  http://127.0.0.1:{BRIDGE_PORT}/approval/status/{id}
// 桥接服务负责推送企业微信并收集用户回复
const http = require("http");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const BRIDGE_HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8787);
const TIMEOUT_MS = Number(process.env.APPROVER_TIMEOUT_MS || 5 * 60 * 1000);
const POLL_INTERVAL = 2000;

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data || "{}"));
        } catch (e) {
          reject(new Error("解析响应失败: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("桥接请求超时")));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function requestApproval(payload) {
  return httpRequest(
    {
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: "/approval/request",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    payload
  );
}

async function pollStatus(id) {
  return httpRequest({
    hostname: BRIDGE_HOST,
    port: BRIDGE_PORT,
    path: `/approval/status/${encodeURIComponent(id)}`,
    method: "GET",
  });
}

const server = new McpServer({
  name: "wecom-approver",
  version: "0.1.0",
});

// approval_prompt 工具：返回 {"behavior":"allow"/"deny", ...}
server.tool(
  "approval_prompt",
  "权限确认工具：当 Claude 需要执行敏感操作时被调用。将权限请求转发给用户确认，用户回复后返回 allow 或 deny。",
  {
    tool_use_id: z.string().describe("工具调用ID"),
    tool_name: z.string().describe("需要权限的工具名，如 Bash/Write/Edit"),
    input: z.record(z.unknown()).describe("工具入参"),
  },
  async ({ tool_use_id, tool_name, input }) => {
    const startedAt = Date.now();
    try {
      // 1. 请求桥接发起确认
      const req = await requestApproval({
        tool_use_id,
        tool_name,
        input,
        timeoutMs: TIMEOUT_MS,
      });
      if (!req.ok || !req.id) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ behavior: "deny", message: req.error || "确认服务不可用" }),
            },
          ],
        };
      }
      const id = req.id;

      // 2. 轮询确认状态
      while (Date.now() - startedAt < TIMEOUT_MS) {
        const st = await pollStatus(id);
        if (st.status === "resolved") {
          const result = st.result; // { behavior, updatedInput?, message? }
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      }

      // 超时
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ behavior: "deny", message: "确认超时，已自动拒绝" }),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ behavior: "deny", message: "权限确认出错: " + e.message }),
          },
        ],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[wecom-approver] MCP 权限确认服务已启动\n");
}

main().catch((e) => {
  process.stderr.write("[wecom-approver] 启动失败: " + e.message + "\n");
  process.exit(1);
});
