// 企业微信智能机器人客户端（API 模式-长连接）
// 通过 WebSocket 与 wss://openws.work.weixin.qq.com 建立长连接：
//   - aibot_subscribe 认证（BotID + Secret，无公网 IP 白名单）
//   - aibot_msg_callback 接收用户消息（JSON 帧，无 XML/AES 加解密）
//   - aibot_respond_msg + msgtype:"stream" 流式回复（打字机效果）
//   - 心跳 ping 保活；断线指数退避重连；单实例（多进程互踢）
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

// 优先使用 ws 库（直连，绕过 Node 原生 WebSocket 对系统代理的自动使用）
let WSImpl = null;
try {
  WSImpl = require("ws");
} catch {
  WSImpl = global.WebSocket || null;
}

class BotClient {
  /**
   * @param {object} cfg.bot 智能机器人配置
   * @param {object} log 日志器
   * @param {object} deps { runner, pusher, api }
   */
  constructor(cfg, log, deps) {
    this.cfg = cfg;
    this.log = log;
    this.deps = deps;
    this.ws = null;
    this.connected = false;
    this.subscribed = false;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.manualClose = false;
    this.pendingAck = 0; // 连续无 ack 次数
    this.pendingReplies = new Map(); // req_id -> { resolve }（请求-响应等待）
    this.userChats = new Map(); // userId -> chatId（多用户：各自对话目标）
    this.currentUserId = ""; // 最近操作的用户（权限确认等推送回发起者）
  }

  get available() {
    return this.connected && this.subscribed;
  }

  start() {
    this.manualClose = false;
    this.log.info("BotClient 启动", { wsUrl: this.cfg.wsUrl, botId: this.cfg.botId });
    this._connect();
  }

  stop() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* 忽略 */
      }
      this.ws = null;
    }
    this.connected = false;
    this.subscribed = false;
    this.log.info("BotClient 已停止");
  }

  _connect() {
    if (this.manualClose) return;
    try {
      const ws = new WSImpl(this.cfg.wsUrl);
      this.ws = ws;
      const isWsLib = typeof ws.on === "function";

      const handleOpen = () => {
        this.log.info("WebSocket 已连接，发送 aibot_subscribe");
        this.connected = true;
        this.reconnectAttempt = 0;
        this._send({
          cmd: "aibot_subscribe",
          headers: { req_id: this._genReqId("aibot_subscribe") },
          body: { bot_id: this.cfg.botId, secret: this.cfg.botSecret },
        });
      };
      const handleMessage = (data) => this._onMessage(data);
      const handleClose = (code, reason) => {
        this.connected = false;
        this.subscribed = false;
        clearInterval(this.heartbeat);
        this.log.warn("WebSocket 关闭", { code, reason: String(reason) });
        this._scheduleReconnect();
      };
      const handleError = (err) => {
        this.log.error("WebSocket 错误", { err: err.message || String(err) });
      };
      // 协议层 pong：服务器可能对心跳回 WS 控制帧 pong（非 JSON），收到即视为心跳应答
      const handlePong = () => {
        this.pendingAck = 0;
      };

      if (isWsLib) {
        ws.on("open", handleOpen);
        ws.on("message", (data) => handleMessage(data));
        ws.on("close", handleClose);
        ws.on("error", handleError);
        ws.on("pong", handlePong); // ws 库支持
      } else {
        ws.onopen = handleOpen;
        ws.onmessage = (ev) => handleMessage(ev.data);
        ws.onclose = (ev) => handleClose(ev.code, ev.reason);
        ws.onerror = handleError;
      }
    } catch (e) {
      this.log.error("WebSocket 创建失败", { err: e.message });
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.manualClose) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), this.cfg.reconnectMaxMs);
    this.reconnectAttempt++;
    this.log.info(`计划重连，第 ${this.reconnectAttempt} 次，${delay}ms 后`);
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _send(obj) {
    const ws = this.ws;
    if (!ws) return false;
    // ws 库与原生 WebSocket 的 OPEN 静态常量均为 1；统一判断就绪状态
    const openState = WSImpl && WSImpl.OPEN !== undefined ? WSImpl.OPEN : 1;
    if (ws.readyState !== openState) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      this.log.error("发送失败", { err: e.message });
      return false;
    }
  }

  _onMessage(data) {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch (e) {
      this.log.warn("无法解析 WS 帧", { err: e.message });
      return;
    }
    const cmd = frame.cmd;
    const body = frame.body || {};
    // req_id 可能在 headers，也可能在顶层（不同服务器版本）
    const reqId = (frame.headers && frame.headers.req_id) || frame.req_id || "";
    if (reqId && this.pendingReplies.has(reqId)) {
      const { resolve } = this.pendingReplies.get(reqId);
      this.pendingReplies.delete(reqId);
      resolve(frame);
      return;
    }
    // 心跳 ack 兼容：cmd 为 pong 或 req_id 以 ping 开头，都视为心跳应答
    if (cmd === "pong" || reqId.startsWith("ping")) {
      this.pendingAck = 0;
      return;
    }

    // 订阅认证响应：无 cmd，凭 req_id 前缀 + errcode 识别
    if (reqId.startsWith("aibot_subscribe")) {
      if (frame.errcode === 0) {
        this.subscribed = true;
        this.log.info("订阅成功，智能机器人就绪");
        this._startHeartbeat();
      } else {
        this.log.error("订阅失败", { errcode: frame.errcode, errmsg: frame.errmsg });
        this.subscribed = false;
      }
      return;
    }

    // 心跳 ack：凭 req_id 前缀 ping 识别
    if (reqId.startsWith("ping")) {
      this.pendingAck = 0;
      return;
    }

    switch (cmd) {
      case "aibot_subscribe": {
        if (body.errcode === 0) {
          this.subscribed = true;
          this.log.info("订阅成功，智能机器人就绪");
          this._startHeartbeat();
        } else {
          this.log.error("订阅失败", { errcode: body.errcode, errmsg: body.errmsg });
          this.subscribed = false;
        }
        break;
      }
      case "pong": {
        this.pendingAck = 0;
        break;
      }
      case "aibot_msg_callback": {
        // req_id 在帧的 headers 里，需传给 handler 供流式回复复用
        this._handleUserMessage(body, reqId);
        break;
      }
      case "aibot_event_callback": {
        const event = body.event || body.event_type || "unknown";
        this.log.info("收到机器人事件", { event });
        if (event === "disconnected_event") {
          // 被新连接踢出：不自动重连（单实例），记录告警
          this.log.error("机器人连接被其他实例踢出（disconnected_event）");
          this.subscribed = false;
        }
        break;
      }
      default: {
        this.log.info("收到未知指令", { cmd, reqId, raw: JSON.stringify(frame).slice(0, 200) });
      }
    }
  }

  /** 生成企业微信风格的 req_id：{cmd}_{timestamp}_{random} */
  _genReqId(prefix) {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
  }

  _startHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.available) return;
      // 心跳帧需带 req_id（格式 ping_<ts>_<rand>），服务器按 req_id 前缀回 ack
      this._send({ cmd: "ping", headers: { req_id: this._genReqId("ping") } });
      // 服务器不一定回 ack（连接实际存活）。不因"无 ack"主动断开——
      // 连接死亡由 ws 的 close/error 事件或发送失败检测，避免误断开导致频繁重连丢消息。
      // 仅记录异常，供诊断。
      this.pendingAck++;
      if (this.pendingAck >= 6) {
        this.log.warn("心跳长时间无 ack（连接可能已死，等待 ws 事件处理）");
        this.pendingAck = 0;
      }
    }, 30000);
  }

  /**
   * 处理用户消息（aibot_msg_callback）
   * @param {object} body 消息体
   * @param {string} reqId 帧头 req_id（流式回复复用）
   */
  async _handleUserMessage(body, reqId) {
    const msgtype = body.msgtype;
    let content = "";
    let mediaNote = "";

    if (msgtype === "text") {
      content = body.text && body.text.content ? body.text.content : "";
    } else if (msgtype === "voice") {
      // 语音消息：content 已是转好的文字
      content = (body.voice && body.voice.content) || "";
      mediaNote = "[语音转文字] ";
    } else if (msgtype === "image") {
      const url = body.image && body.image.url;
      const aeskey = body.image && body.image.aeskey;
      if (url) {
        const saved = await this._downloadMedia(url, "image", aeskey);
        if (saved) {
          content = `用户发了一张图片，已保存到: ${saved}。请读取该图片文件并回应用户。`;
        } else {
          content = "（图片下载失败，请让用户重新发送）";
        }
        mediaNote = "[图片消息] ";
      } else {
        content = "（收到图片消息但无下载地址）";
        mediaNote = "[图片消息] ";
      }
    } else if (msgtype === "file") {
      const url = body.file && body.file.url;
      const aeskey = body.file && body.file.aeskey;
      if (url) {
        const saved = await this._downloadMedia(url, "file", aeskey);
        if (saved) {
          content = `用户发送了一个文件，已保存到: ${saved}。请读取该文件内容并回应用户。`;
        } else {
          content = "（文件下载失败，请让用户重新发送）";
        }
        mediaNote = "[文件消息] ";
      } else {
        content = "（收到文件消息但无下载地址）";
        mediaNote = "[文件消息] ";
      }
    } else {
      this.log.info("忽略未知机器人消息类型", { msgtype });
      return;
    }

    if (!content.trim()) {
      this.log.warn("机器人收到空消息", { msgtype });
      return;
    }
    content = mediaNote + content.trim();

    // 群聊：仅 @ 机器人的消息才响应（去掉 @提及后处理）
    const chattype = body.chattype || "single";
    if (chattype === "group") {
      const botName = this.cfg.botName || "Claude code";
      const raw = content;
      const mentioned = raw.includes("@") || raw.includes(botName);
      if (!mentioned) {
        this.log.info("群消息未 @ 机器人，忽略", { from: (body.from && body.from.userid) || "" });
        return;
      }
      // 去掉 @提及（@名字/@机器人 等）
      content = raw.replace(/@[^\s@，。]+/g, "").trim() || raw.replace(/@/g, "").trim();
    }

    this.log.info("机器人收到消息", { from: (body.from && body.from.userid) || body.from_userid, content: content.slice(0, 100) });

    // 记录本次回调的 req_id，供流式回复复用（打字机原地刷新）
    this.lastReqId = reqId;
    // 单聊 from 是对象 {userid}，群聊有 chatid；主动推送用 chatid（单聊=userid）
    const fromUserId = (body.from && body.from.userid) || "";
    this.lastChatId = body.chatid || fromUserId || "";
    // 多用户：记录该用户的对话目标，并标记为当前操作用户
    if (fromUserId) {
      this.userChats.set(fromUserId, this.lastChatId);
      this.currentUserId = fromUserId;
    }
    this.log.info("记录 lastChatId", { chatId: this.lastChatId, chattype: body.chattype, fromUserId });

    // 组装成与自建应用回调一致的 msg 结构，走统一命令分发
    const msg = {
      MsgType: "text",
      Content: content,
      FromUserName: fromUserId || body.from_userid || "",
      ChatId: body.chatid || fromUserId || "", // 聊天域（群聊=chatid，单聊=userid）
      MsgId: body.msgid || crypto.randomUUID(),
    };

    const { runner, approver } = this.deps;
    try {
      // 先尝试消费为权限确认回复
      if (approver && (await approver.handleReply(content))) {
        return;
      }
      await runner.handleIncoming({ msg, api: this.deps.api, registry: this.deps.registry, approver });
    } catch (e) {
      this.log.error("机器人消息处理失败", { err: e.message });
    }
  }

  /**
   * 下载图片/文件媒体到本地（~/.claude/wecom-bridge/media/）
   * 加密模式下带 aeskey → AES-256-CBC 解密（key=base64(aeskey)，IV=key前16字节，PKCS#7 32字节块）
   * @param {string} url 媒体地址
   * @param {string} kind image | file
   * @param {string} [aeskey] 可选加密密钥
   * @returns {Promise<string|null>} 保存路径或 null
   */
  _downloadMedia(url, kind, aeskey) {
    return new Promise((resolve) => {
      let mediaDir;
      try {
        mediaDir = path.join(
          process.env.USERPROFILE || process.env.HOME || "",
          ".claude",
          "wecom-bridge",
          "media"
        );
        if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
      } catch (e) {
        this.log.error("媒体目录创建失败", { err: e.message });
        return resolve(null);
      }
      const ext = kind === "image" ? ".img" : ".bin";
      const file = path.join(mediaDir, `${kind}_${Date.now()}${ext}`);
      const req = https.get(url, (res) => {
        // 跟随重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          this._downloadMedia(res.headers.location, kind, aeskey).then(resolve);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          this.log.warn("媒体下载非 200", { url, code: res.statusCode });
          return resolve(null);
        }
        // 收集完整 Buffer（可能需解密）
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            let data = Buffer.concat(chunks);
            if (aeskey) data = this._decryptMedia(data, aeskey);
            fs.writeFileSync(file, data);
            this.log.info("媒体保存完成", { kind, file, encrypted: !!aeskey });
            resolve(file);
          } catch (e) {
            this.log.error("媒体解密/写入失败", { err: e.message });
            resolve(null);
          }
        });
        res.on("error", (e) => {
          this.log.error("媒体下载错误", { err: e.message });
          resolve(null);
        });
      });
      req.on("error", (e) => {
        this.log.error("媒体下载失败", { err: e.message });
        resolve(null);
      });
      req.setTimeout(20000, () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  /**
   * AES-256-CBC 解密媒体内容（企业微信智能机器人加密模式）
   * key = base64(aeskey)；IV = key 前 16 字节；PKCS#7 padding 按 32 字节块
   */
  _decryptMedia(buffer, aeskey) {
    const crypto = require("crypto");
    const key = Buffer.from(aeskey, "base64");
    const iv = key.subarray(0, 16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    decipher.setAutoPadding(false); // 手动去 PKCS#7（32 字节块，非标准 16）
    let decrypted = Buffer.concat([decipher.update(buffer), decipher.final()]);
    const padLen = decrypted[decrypted.length - 1];
    if (padLen < 1 || padLen > 32 || padLen > decrypted.length) {
      throw new Error(`Invalid PKCS#7 padding: ${padLen}`);
    }
    for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
      if (decrypted[i] !== padLen) {
        throw new Error("Invalid PKCS#7 padding bytes");
      }
    }
    decrypted = decrypted.subarray(0, decrypted.length - padLen);
    return decrypted;
  }

  /**
   * 主动推送（aibot_send_msg）——需用户先给机器人发过消息
   * @param {string} chatId 单聊为 userid，群聊为群 chatid
   * @param {object} payload { msgtype, [text/markdown]: {...} }
   */
  sendActive(chatId, payload) {
    return this._send({
      cmd: "aibot_send_msg",
      headers: { req_id: "aibot_send_msg_" + crypto.randomUUID() },
      body: { chatid: chatId, ...payload },
    });
  }

  /**
   * 发送请求帧并等待响应（按 req_id 匹配）
   * @param {string} cmd 命令名
   * @param {object} body 请求体
   * @param {number} [timeoutMs] 超时
   * @returns {Promise<object>} 响应帧
   */
  _sendReply(cmd, body, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const reqId = cmd + "_" + crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingReplies.delete(reqId);
        reject(new Error(cmd + " 响应超时"));
      }, timeoutMs);
      this.pendingReplies.set(reqId, {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
      const ok = this._send({ cmd, headers: { req_id: reqId }, body });
      if (!ok) {
        clearTimeout(timer);
        this.pendingReplies.delete(reqId);
        reject(new Error("发送失败（连接不可用）"));
      }
    });
  }

  /**
   * 上传媒体（分片）并发送文件消息
   * 流程：init → chunk(512KB 分片) → finish → aibot_send_msg(file)
   * @param {string} chatId 单聊 userid / 群聊 chatid
   * @param {string} filePath 本地文件路径
   * @returns {Promise<boolean>}
   */
  async sendFile(chatId, filePath) {
    try {
      const buf = fs.readFileSync(filePath);
      const md5 = crypto.createHash("md5").update(buf).digest("hex");
      const CHUNK = 512 * 1024;
      const totalChunks = Math.ceil(buf.length / CHUNK);
      if (totalChunks > 100) {
        this.log.error("文件过大（超过 100 分片 ≈ 50MB）", { filePath });
        return false;
      }
      // 1. init
      const initRes = await this._sendReply("aibot_upload_media_init", {
        type: "file",
        filename: path.basename(filePath),
        total_size: buf.length,
        total_chunks: totalChunks,
        md5,
      });
      const uploadId = initRes.body && initRes.body.upload_id;
      if (!uploadId) {
        this.log.error("上传初始化失败", { errmsg: initRes.errmsg });
        return false;
      }
      // 2. 分片上传
      for (let i = 0; i < totalChunks; i++) {
        const chunk = buf.slice(i * CHUNK, Math.min((i + 1) * CHUNK, buf.length));
        await this._sendReply("aibot_upload_media_chunk", {
          upload_id: uploadId,
          chunk_index: i,
          base64_data: chunk.toString("base64"),
        });
      }
      // 3. finish
      const finRes = await this._sendReply("aibot_upload_media_finish", {
        upload_id: uploadId,
      });
      const mediaId = finRes.body && finRes.body.media_id;
      if (!mediaId) {
        this.log.error("上传完成失败", { errmsg: finRes.errmsg });
        return false;
      }
      // 4. 发送文件消息
      const ok = this._send({
        cmd: "aibot_send_msg",
        headers: { req_id: "aibot_send_msg_" + crypto.randomUUID() },
        body: {
          chatid: chatId,
          msgtype: "file",
          file: { media_id: mediaId },
        },
      });
      this.log.info("文件已发送", { filePath, size: buf.length, mediaId: mediaId.slice(0, 8) });
      return ok;
    } catch (e) {
      this.log.error("发送文件失败", { filePath, err: e.message });
      return false;
    }
  }

  /**
   * 创建一条流式回复会话（打字机）
   * @param {string} reqId 复用回调的 req_id
   * @param {function} fallback 降级回调：收到完整文本时若流失败，用它补发
   * @returns {{append, finish, abort, fullText}}
   */
  createStream(reqId, fallback) {
    const streamId = crypto.randomUUID();
    const cfg = this.cfg;
    let buf = "";
    let finished = false;
    let idleTimer = null;
    let totalTimer = null;
    let abortFn = null; // 晚绑定 stream.abort，避免 TDZ

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      idleTimer = null;
      totalTimer = null;
    };

    const sendChunk = (text, finish) => {
      const ok = this._send({
        cmd: "aibot_respond_msg",
        headers: { req_id: reqId },
        body: {
          msgtype: "stream",
          stream: { id: streamId, content: text, finish },
        },
      });
      if (!ok) {
        // 发送失败（连接断了）→ 走降级
        this.log.warn("流式发送失败，触发降级", { streamId });
        if (fallback && buf) fallback(buf);
        if (abortFn) abortFn();
      }
      return ok;
    };

    // 空闲超时：一段时间无新分片 → 判定流卡住，降级补发
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        this.log.warn("流式空闲超时，触发降级", { streamId });
        if (!finished) {
          if (fallback && buf) fallback(buf);
          if (abortFn) abortFn();
        }
      }, cfg.streamIdleTimeoutMs);
    };

    const stream = {
      id: streamId,
      get fullText() {
        return buf;
      },
      // 供 pusher 判断流是否已中止/完成
      get isFinished() {
        return finished;
      },
      /**
       * 追加文本分片（finish:false，节流发送）
       * @param {string} text
       */
      append(text) {
        if (finished) return;
        buf += text;
        armIdle();
        // 节流：每 interval 发一次分片，减少请求频率
        if (!this._timer) {
          this._timer = setTimeout(() => {
            this._timer = null;
            if (finished) return;
            if (buf) sendChunk(buf, false);
          }, cfg.streamIntervalMs);
        }
      },
      /**
       * 结束流（finish:true 定型）
       * @param {string} text 最终完整内容
       */
      finish(text) {
        if (finished) return;
        finished = true;
        clearTimers();
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        // 追加尚未发送的剩余内容
        if (text !== undefined && text !== null) {
          if (buf) {
            // 已有分片，finish 推送完整文本定型
            sendChunk(text, true);
          } else {
            buf = text;
            sendChunk(text, true);
          }
        } else {
          sendChunk(buf, true);
        }
      },
      /**
       * 中止流（异常时）
       */
      abort() {
        finished = true;
        clearTimers();
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
      },
    };

    // 晚绑定 abort 引用，供 sendChunk/armIdle 降级时调用（箭头函数保留 this）
    abortFn = () => stream.abort();

    // 总超时：整个流超过时限仍未 finish → 强制定型
    totalTimer = setTimeout(() => {
      this.log.warn("流式总超时，强制结束", { streamId });
      if (!finished) stream.finish(buf);
    }, cfg.streamTotalTimeoutMs);

    return stream;
  }
}

module.exports = { BotClient };
