// P4 mock 闭环测试：本地模拟企业微信回调 → 命令解析 → claude 调用 → 推送
// 用内存 mock 替代真实企业微信 API
const assert = require("assert");
const http = require("http");
const { generateEncodingAESKey, encryptMessage, getSignature } = require("../src/wecom/crypto");
const { ProjectRegistry } = require("../src/projects");
const { ClaudeRunner } = require("../src/claude");
const { buildServer } = require("../src/server");

// ---- 最小配置 ----
const cfg = {
  bridge: { port: 8877, host: "127.0.0.1" },
  wecom: {
    corpId: "wwmockcorpid",
    agentId: 1000002,
    token: "mocktoken",
    encodingAESKey: generateEncodingAESKey(),
    touser: "mockuser",
  },
  claude: {
    bin: process.env.CLAUDE_BIN || "/home/user\\USER\\.local\\bin\\claude.exe",
    workdir: "/path\\projects\\PROJECT",
    sessionDir: process.env.SESSION_DIR || "/home/user\\USER\\.claude\\projects",
    permissionMode: "bypassPermissions", // mock 测试用绕过，避免权限确认
    gitBashPath: "D:\\devtools\\git\\Git\\bin\\bash.exe",
    permissionPromptTool: "",
    idleTimeoutMs: 120000,
    totalTimeoutMs: 60000,
  },
  pusher: { maxChunks: 6, maxBytes: 2048, tokenCacheMs: 60000, earlyRefreshMs: 10000 },
  registry: { file: null }, // 内存模式
  approver: { timeoutMs: 5000 },
  tunnel: { enabled: false },
};

// ---- 内存 mock ----
const sent = [];
const mockApi = {
  sendText: async (content) => {
    sent.push(content);
    console.log("\n[mock推送]\n" + content.slice(0, 300) + (content.length > 300 ? "…" : ""));
    return { errcode: 0 };
  },
};

const mockApprover = {
  handleReply: async () => false,
};

function sendCallback(body, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: cfg.bridge.port,
        path: path || "/wecom/callback",
        method: "POST",
        headers: { "Content-Type": "application/xml" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const registry = new ProjectRegistry(null);
  const runner = new ClaudeRunner(cfg, console, registry, {
    pushSectioned: async (name, text, ms) => mockApi.sendText(`[${name}] ${text}`),
  });
  const app = buildServer({ cfg, log: console, registry, runner, api: mockApi, approver: mockApprover });

  const server = app.listen(cfg.bridge.port, cfg.bridge.host, async () => {
    console.log("mock 桥接已启动");
    try {
      // 构造加密 POST
      const xml = `<xml>
  <ToUserName><![CDATA[wwmockcorpid]]></ToUserName>
  <FromUserName><![CDATA[mockuser]]></FromUserName>
  <CreateTime>1348831860</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[用一句话回答：1+1等于几？]]></Content>
  <MsgId>9990000001</MsgId>
  <AgentID>1000002</AgentID>
</xml>`;
      const cipher = encryptMessage(cfg.wecom.encodingAESKey, xml, cfg.wecom.corpId);
      const body = `<xml><ToUserName><![CDATA[${cfg.wecom.corpId}]]></ToUserName><AgentID><![CDATA[1000002]]></AgentID><Encrypt><![CDATA[${cipher}]]></Encrypt></xml>`;
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = "mocknonce";
      const sig = getSignature(cfg.wecom.token, ts, nonce, cipher);
      const url = `/wecom/callback?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`;

      const status = await sendCallback(body, url);
      console.log("回调返回 HTTP", status);
      assert.strictEqual(status, 200);

      // 等待 claude 执行完成
      await new Promise((r) => setTimeout(r, 30000));

      assert.ok(sent.length > 0, "应有推送消息");
      const last = sent[sent.length - 1];
      assert.ok(/\[mock\]|1\+1|结果/.test(last) || last.includes("1+1"), "结果应包含回答");
      console.log("\nPASS mock-callback: 完整链路闭环");
      server.close();
      process.exit(0);
    } catch (e) {
      console.error("FAIL:", e.message);
      server.close();
      process.exit(1);
    }
  });
}

main();
