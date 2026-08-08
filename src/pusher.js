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

class Pusher {
  constructor(cfg, api, log) {
    this.cfg = cfg;
    this.api = api;
    this.log = log;
  }

  /**
   * 分段推送结果
   * @param {string} taskName
   * @param {string} text
   * @param {number} [durationMs]
   */
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
        await this.api.sendText(body);
      } catch (e) {
        this.log.error("推送失败", { err: e.message });
      }
      await new Promise((r) => setTimeout(r, 300)); // 避免过快触发限流
    }
  }

  /**
   * 按类型推送带样式的消息（方案B：思考/工具/回复 区分）
   * @param {string} taskName
   * @param {string} text
   * @param {string} kind thinking | tool | reply
   * @param {number} [durationMs]
   */
  async pushStyled(taskName, text, kind, durationMs) {
    const cfg = this.cfg.pusher;
    if (!text || !text.trim()) return;
    let parts = splitByBytes(text, cfg.maxBytes);
    const truncated = parts.length > cfg.maxChunks;
    parts = parts.slice(0, cfg.maxChunks);

    const head = `[${taskName}]${durationMs ? ` (耗时 ${Math.round(durationMs / 1000)}s)` : ""}\n`;

    // 样式模板：基础 markdown 语法（官方承诺渲染，安卓不显示源码）
    const TEMPLATES = {
      // 思考过程 → 引用块（灰，官方支持 > 引用）
      thinking: (body) => `> 🤔 ${body.replace(/\n/g, "\n> ")}`,
      // 工具调用 → 加粗 + emoji
      tool: (body) => `**🔧 ${body}**`,
      // 最终回复 → 加粗标题 + 正文
      reply: (body) => `**📝 回复**\n${body}`,
      // 普通文本（无样式）
      plain: (body) => body,
    };
    const wrap = TEMPLATES[kind] || TEMPLATES.plain;

    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.length > 1 ? `\n━━ 续上一条 ${i + 1}/${parts.length} ━━\n` : "";
      let body = wrap(prefix + parts[i]);
      if (i === 0) body = head + body;
      if (truncated && i === parts.length - 1) body += "\n…[已截断，详见本地]";
      try {
        await this.api.sendMarkdown(body);
      } catch (e) {
        this.log.error("推送失败", { err: e.message });
      }
      await new Promise((r) => setTimeout(r, 300)); // 避免过快触发限流
    }
  }
}

module.exports = { Pusher, splitByBytes };
