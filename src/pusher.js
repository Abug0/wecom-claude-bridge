// 结果分片推送：按字节切分，不切坏中文
// 企业微信 text.content 最长 2048 字节（中文占3字节）

/**
 * 按字节切分文本（逐码点，避免切坏多字节字符）
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string[]}
 */
function splitByBytes(text, maxBytes) {
  const chunks = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (curBytes + b > maxBytes && curBytes > 0) {
      chunks.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * 跨端换行适配：企业微信智能机器人 markdown 在安卓端会把裸 \n 合并到一行，
 * 官方规避方案是在每行开头加无序列表符号 "- " 才能强制换行（引用块 > 在移动端不可靠）。
 * 对非 markdown 结构行补 "- " 前缀；已有引用/列表/标题/表格等结构行保留原样。
 * @param {string} text
 * @returns {string}
 */
function fixNewlines(text) {
  const lines = text.split("\n");
  return lines
    .map((line, i) => {
      if (i === 0) return line; // 首行不加前缀（通常是对话头/标题）
      if (!line.trim()) return line; // 空行保留
      // 已是 markdown 结构行（引用/列表/标题/代码块/表格）则保留
      if (/^(>\s|\*\s|-\s|#|\s*```|\|)/.test(line)) return line;
      return "- " + line;
    })
    .join("\n");
}

class Pusher {
  constructor(cfg, api, log) {
    this.cfg = cfg;
    this.api = api;
    this.log = log;
    this.bot = null; // 智能机器人通道（可选）
    this.activeStream = null; // 当前任务的活动流
    this.activeStreamAborted = false; // 本任务流式是否已中止（降级后只推最终 reply）
    this.streamInterrupted = false; // 流式被授权打断，后续应自动重开新流
  }

  /**
   * 绑定智能机器人通道（可选）
   * @param {object} bot BotClient 实例
   */
  attachBot(bot) {
    this.bot = bot;
  }

  /**
   * 任务开始：若 bot 可用则开启一条流式会话
   * @param {string} taskName
   * @param {string} reqId 回调 req_id（复用打字机）
   * @returns {boolean} 是否已开启流式
   */
  beginTask(taskName, reqId) {
    this.activeStreamAborted = false;
    this.streamInterrupted = false;
    if (!this.bot || !this.bot.available) return false;
    // 降级回调：流式失败时用 bot 主动推送补发完整结果
    const fallback = (text) => this.sendNotification(text, "markdown").catch(() => {});
    this.activeStream = this.bot.createStream(reqId || this.bot.lastReqId, fallback);
    return true;
  }

  /**
   * 结束当前流式会话
   * @param {string} [taskName]
   * @param {string} [finalText] 若提供则用完整文本 finish
   * @param {boolean} [interrupt] true=被授权打断（后续应自动重开新流）；false/缺省=任务正常结束
   */
  async endTask(taskName, finalText, interrupt) {
    if (this.activeStream) {
      try {
        if (finalText) this.activeStream.finish(finalText);
        else this.activeStream.finish();
      } catch (e) {
        this.log.error("结束流式失败", { err: e.message });
      }
      this.activeStream = null;
    }
    if (interrupt) {
      // 授权打断：标记后续可自动重开流
      this.streamInterrupted = true;
    } else {
      this.activeStreamAborted = false;
      this.streamInterrupted = false;
    }
  }

  /**
   * 分段推送结果
   * @param {string} taskName
   * @param {string} text
   * @param {number} [durationMs]
   */
  /**
   * 主动推送单条消息（命令回复/权限确认/系统通知/流式降级）
   * bot 可用 → 走 bot 主动推送（aibot_send_msg，仅支持 markdown 类型）
   * 否则降级自建应用
   * @param {string} text
   * @param {string} [msgtype] 固定 markdown（主动推送仅支持 markdown）
   */
  async sendNotification(text, msgtype = "markdown") {
    if (this.bot && this.bot.available && this.bot.lastChatId) {
      const payload =
        msgtype === "markdown"
          ? { msgtype: "markdown", markdown: { content: text } }
          : { msgtype: "text", text: { content: text } };
      const ok = this.bot.sendActive(this.bot.lastChatId, payload);
      if (ok) return true;
      this.log.warn("bot 主动推送失败，降级自建应用");
    }
    await this.api.sendText(text);
    return true;
  }

  async pushSectioned(taskName, text, durationMs) {
    const cfg = this.cfg.pusher;
    let parts = splitByBytes(text || "(空结果)", cfg.maxBytes);
    const truncated = parts.length > cfg.maxChunks;
    parts = parts.slice(0, cfg.maxChunks);

    const head = `[${taskName}]${durationMs ? ` (耗时 ${Math.round(durationMs / 1000)}s)` : ""}\n`;
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.length > 1 ? `\n── 第 ${i + 1}/${parts.length} 段 ──\n` : "";
      let body = prefix + parts[i];
      if (i === 0) body = head + body;
      if (truncated && i === parts.length - 1) body += "\n…[已截断，详见本地]";
      try {
        await this.sendNotification(fixNewlines(body));
      } catch (e) {
        this.log.error("推送失败", { err: e.message });
      }
      await new Promise((r) => setTimeout(r, 300)); // 避免过快触发限流
    }
  }

  /**
   * 按类型推送带样式的消息
   * 有活动流时 → 走智能机器人流式分片（打字机）；否则走自建应用 sendMarkdown
   * @param {string} taskName
   * @param {string} text
   * @param {string} kind thinking | tool | reply
   * @param {number} [durationMs]
   */
  async pushStyled(taskName, text, kind, durationMs) {
    const cfg = this.cfg.pusher;
    if (!text || !text.trim()) return;

    // 样式模板：基础 markdown 语法（官方承诺渲染，安卓不显示源码）
    const TEMPLATES = {
      thinking: (body) => `> 🤔 ${body.replace(/\n/g, "\n> ")}`,
      tool: (body) => `**🔧 ${body}**`,
      reply: (body) => `**📝 回复**\n${body}`,
      plain: (body) => body,
    };
    const wrap = TEMPLATES[kind] || TEMPLATES.plain;
    const body = wrap(text);

    // 授权打断后自动重开新流：activeStream 为空但任务仍被授权打断中，且 bot 可用
    if (!this.activeStream && this.streamInterrupted && this.bot && this.bot.available) {
      this.log.info("授权后自动重开流式会话");
      this.activeStream = this.bot.createStream(this.bot.lastReqId, (t) =>
        this.sendNotification(t, "markdown").catch(() => {})
      );
      this.streamInterrupted = false;
      this.activeStreamAborted = false;
    }

    // 智能机器人流式分支：对话内容（thinking/tool/reply）走打字机
    if (this.activeStream) {
      // 流已中止（abort/超时降级过）→ 清空并降级（优先 bot 主动推送）
      if (this.activeStream.isFinished) {
        this.log.warn("流已中止，降级（优先 bot 主动推送）");
        this.activeStream = null;
        this.activeStreamAborted = true;
      } else {
        try {
          if (kind === "reply") {
            this.activeStream.finish(body);
          } else {
            // thinking/tool：作为分片追加，原地刷新
            this.activeStream.append("\n\n" + body);
          }
          return;
        } catch (e) {
          this.log.error("流式推送失败，降级", { err: e.message });
          this.activeStream = null;
          this.activeStreamAborted = true;
          // fall through 到降级分支
        }
      }
    }

    // 降级分支：优先 bot 主动推送（留在 bot 会话），bot 不可用才自建应用
    // 一次流式任务内 abort 后，后续分片（thinking/tool）不再重复推，只推最终 reply
    if (this.activeStreamAborted && kind !== "reply") {
      return;
    }

    const head = `[${taskName}]${durationMs ? ` (耗时 ${Math.round(durationMs / 1000)}s)` : ""}\n`;
    try {
      await this.sendNotification(fixNewlines(head + body), "markdown");
    } catch (e) {
      this.log.error("推送失败", { err: e.message });
    }
  }
}

module.exports = { Pusher, splitByBytes, fixNewlines };
