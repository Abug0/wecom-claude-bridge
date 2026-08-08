// 配置加载与校验
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function loadConfig() {
  return {
    bridge: {
      port: Number(process.env.BRIDGE_PORT || 8787),
      host: "127.0.0.1",
    },
    wecom: {
      corpId: process.env.WECOM_CORP_ID,
      agentId: Number(process.env.WECOM_AGENT_ID),
      secret: process.env.WECOM_APP_SECRET,
      token: process.env.WECOM_TOKEN,
      encodingAESKey: process.env.WECOM_ENCODING_AES_KEY,
      touser: process.env.WECOM_TOUSER,
      // 云转发：推送走云服务器（源IP=云IP），解决企业微信可信IP校验
      sendViaCloud:
        process.env.SEND_VIA_CLOUD === "1"
          ? process.env.SEND_CLOUD_ENDPOINT || "https://www.your-domain.com/wecom/send"
          : null,
      bridgeSecret: process.env.BRIDGE_SECRET || null,
    },
    bot: {
      // 智能机器人通道（API 模式-长连接），作为对话流式默认通道
      enabled: process.env.WECOM_BOT_ENABLED === "1",
      botId: process.env.WECOM_BOT_ID || "",
      botSecret: process.env.WECOM_BOT_SECRET || "",
      wsUrl: process.env.WECOM_BOT_WS || "wss://openws.work.weixin.qq.com",
      // 流式分片间隔（毫秒）与超时兜底
      streamIntervalMs: Number(process.env.WECOM_BOT_STREAM_INTERVAL_MS || 800),
      streamIdleTimeoutMs: Number(process.env.WECOM_BOT_STREAM_IDLE_TIMEOUT_MS || 60000),
      streamTotalTimeoutMs: Number(process.env.WECOM_BOT_STREAM_TOTAL_TIMEOUT_MS || 120000),
      reconnectMaxMs: Number(process.env.WECOM_BOT_RECONNECT_MAX_MS || 30000),
    },
    claude: {
      bin: process.env.CLAUDE_BIN || "/home/user\\USER\\.local\\bin\\claude.exe",
      workdir: process.env.WORKDIR || "/path\\projects\\PROJECT",
      sessionDir: process.env.SESSION_DIR || "/home/user\\USER\\.claude\\projects",
      permissionMode: process.env.CLAUDE_PERMISSION_MODE || "default",
      gitBashPath:
        process.env.CLAUDE_CODE_GIT_BASH_PATH ||
        "D:\\devtools\\git\\Git\\bin\\bash.exe",
      permissionPromptTool: "mcp__wecom_approver__approval_prompt",
      idleTimeoutMs: Number(process.env.CLAUDE_IDLE_TIMEOUT_MS || 10 * 60 * 1000),
      totalTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS || 0),
    },
    approver: {
      port: Number(process.env.APPROVER_PORT || 8790),
      timeoutMs: Number(process.env.APPROVER_TIMEOUT_MS || 5 * 60 * 1000),
    },
    registry: {
      file:
        process.env.REGISTRY_FILE ||
        "/home/user\\USER\\.claude\\wecom-bridge\\sessions.json",
    },
    pusher: {
      maxChunks: 6,
      maxBytes: 2048,
      tokenCacheMs: 5 * 60 * 1000,
      earlyRefreshMs: 5 * 60 * 1000,
      heartbeatStartMs: 30 * 1000, // 长任务心跳启动阈值
      heartbeatIntervalMs: 20 * 1000, // 心跳间隔
      completeNotifyMs: 60 * 1000, // 超过该时长任务完成后补"完成"总结
    },
    tunnel: {
      enabled: process.env.ENABLE_TUNNEL === "1",
      remoteUser: process.env.SSH_REMOTE_USER,
      server: process.env.SSH_SERVER,
      key: process.env.SSH_KEY,
      remotePort: Number(process.env.SSH_REMOTE_PORT || 9000),
    },
  };
}

function assertValid(cfg) {
  const required = [
    ["WECOM_CORP_ID", cfg.wecom.corpId],
    ["WECOM_AGENT_ID", cfg.wecom.agentId],
    ["WECOM_APP_SECRET", cfg.wecom.secret],
    ["WECOM_TOKEN", cfg.wecom.token],
    ["WECOM_ENCODING_AES_KEY", cfg.wecom.encodingAESKey],
    ["WECOM_TOUSER", cfg.wecom.touser],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      "缺少必填配置: " + missing.join(", ") + "。请复制 .env.example 为 .env 并填写。"
    );
  }
  // EncodingAESKey 必须是 43 字符 base64
  if (cfg.wecom.encodingAESKey && cfg.wecom.encodingAESKey.length !== 43) {
    throw new Error("WECOM_ENCODING_AES_KEY 必须是 43 字符（企业微信随机生成的格式）");
  }
}

module.exports = { loadConfig, assertValid };
