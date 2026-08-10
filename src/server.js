// 回调 HTTP 服务：企业微信回调 + healthz
// GET  /wecom/callback  回调验证（1秒内返回明文）
// POST /wecom/callback  消息回调（验签解密后立即回200，异步处理）
// GET  /healthz         健康检查
// POST /bridge/send-file  MCP send_file 工具转发：把本地文件推送到微信
const express = require("express");
const fs = require("fs");
const path = require("path");
const { getSignature, decryptMessage } = require("./wecom/crypto");
const { extractEncrypt, extractMessage } = require("./wecom/xml");

// 幂等去重：MsgId LRU（防企业微信5秒重试导致重复执行）
class MsgDedup {
  constructor(capacity = 200, ttlMs = 10 * 60 * 1000) {
    this.cap = capacity;
    this.ttl = ttlMs;
    this.map = new Map(); // key -> timestamp
  }
  seen(key) {
    const now = Date.now();
    if (this.map.has(key)) {
      const ts = this.map.get(key);
      if (now - ts < this.ttl) return true;
      this.map.delete(key);
    }
    this.map.set(key, now);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return false;
  }
}

function buildServer({ cfg, log, registry, runner, api, approver }) {
  const app = express();
  const dedup = new MsgDedup();

  // 回调必须拿到原始 XML body（不做 json 解析）
  app.use("/wecom/callback", express.raw({ type: "*/*" }));
  app.use(express.json());

  // ---- 权限确认端点（供 MCP 权限服务调用）----
  app.post("/approval/request", async (req, res) => {
    try {
      const result = await approver.request(req.body || {});
      res.json(result);
    } catch (e) {
      log.error("approval/request 异常", { err: e.message });
      res.json({ ok: false, error: e.message });
    }
  });

  app.get("/approval/status/:id", (req, res) => {
    try {
      res.json(approver.status(req.params.id));
    } catch (e) {
      res.json({ status: "not_found" });
    }
  });

  // GET 回调验证：企业微信保存配置时立即触发
  app.get("/wecom/callback", (req, res) => {
    const { msg_signature, timestamp, nonce, echostr } = req.query;
    let echo = echostr || "";
    try {
      echo = decodeURIComponent(echo);
    } catch {
      /* 保留原样 */
    }
    if (getSignature(cfg.wecom.token, timestamp, nonce, echo) !== msg_signature) {
      log.warn("GET 验签失败");
      return res.send("");
    }
    try {
      const { message } = decryptMessage(cfg.wecom.encodingAESKey, echo);
      log.info("回调验证成功");
      return res.send(message); // 明文回显
    } catch (e) {
      log.error("GET 解密失败", { err: e.message });
      return res.send("");
    }
  });

  // POST 消息回调
  app.post("/wecom/callback", (req, res) => {
    const { msg_signature, timestamp, nonce } = req.query;
    const rawBody = req.body ? req.body.toString("utf8") : "";
    const encrypt = extractEncrypt(rawBody);

    if (getSignature(cfg.wecom.token, timestamp, nonce, encrypt) !== msg_signature) {
      log.warn("POST 验签失败");
      return res.send("");
    }

    let xml = "";
    try {
      const r = decryptMessage(cfg.wecom.encodingAESKey, encrypt);
      xml = r.message;
    } catch (e) {
      log.error("POST 解密失败", { err: e.message });
      return res.send("");
    }

    const msg = extractMessage(xml);
    if (msg.MsgType !== "text") {
      // 非文本消息（图片/语音/事件）暂不处理
      log.info("忽略非文本消息", { MsgType: msg.MsgType });
      return res.send("");
    }
    if (dedup.seen(msg.MsgId)) {
      log.info("重复 MsgId，忽略", { MsgId: msg.MsgId });
      return res.send("");
    }

    log.info("收到消息", { from: msg.FromUserName, content: msg.Content.slice(0, 100) });
    // 立即回 200，异步处理（5秒限制）
    res.send("");
    setImmediate(async () => {
      try {
        // 先尝试消费为权限确认回复
        if (approver && (await approver.handleReply(msg.Content))) {
          return;
        }
        await runner.handleIncoming({ msg, api, registry, approver });
      } catch (e) {
        log.error("消息处理失败", { err: e.message });
      }
    });
  });

  app.get("/healthz", (_req, res) => {
    const queueN = runner.queues
      ? [...runner.queues.values()].reduce((n, q) => n + q.length, 0)
      : 0;
    res.json({ ok: true, queue: queueN, running: runner.running ? runner.running.size : 0 });
  });

  // MCP send_file 工具转发：把本地文件推送到微信
  app.post("/bridge/send-file", async (req, res) => {
    try {
      const { file_path: filePath, chatid } = req.body || {};
      const bot = runner.pusher && runner.pusher.bot;
      if (!bot || typeof bot.sendFile !== "function") {
        return res.json({ ok: false, error: "智能机器人通道不可用" });
      }
      const target = chatid || bot.lastChatId;
      if (!target) return res.json({ ok: false, error: "无可用会话（先给机器人发条消息）" });
      if (!filePath || !fs.existsSync(filePath)) {
        return res.json({ ok: false, error: "文件不存在: " + (filePath || "") });
      }
      const ok = await bot.sendFile(target, filePath);
      res.json({ ok, path: filePath });
    } catch (e) {
      log.error("发送文件端点失败", { err: e.message });
      res.json({ ok: false, error: e.message });
    }
  });

  return app;
}

module.exports = { buildServer, MsgDedup };
