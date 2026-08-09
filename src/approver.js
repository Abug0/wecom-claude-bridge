// 权限确认处理器（运行在桥接进程内）
// 职责：
//   POST /approval/request  接收 MCP 权限工具的确认请求 → 推送微信 → 记录 pending
//   GET  /approval/status/:id  查询确认状态（MCP 工具轮询）
//   handleReply(text)  处理用户在微信的回复（允许/拒绝）
const crypto = require("crypto");

class Approver {
  constructor(cfg, api, pusher, log) {
    this.cfg = cfg;
    this.api = api;
    this.pusher = pusher;
    this.log = log;
    this.pending = new Map(); // id -> { createdAt, resolvedAt, result }
  }

  /**
   * 发起权限确认
   * @param {{tool_use_id, tool_name, input, timeoutMs}} body
   */
  async request(body) {
    const id = crypto.randomUUID();
    const { tool_name, input, tool_use_id } = body;
    this.pending.set(id, {
      createdAt: Date.now(),
      resolvedAt: null,
      result: null,
      originalInput: input || {},
    });

    // 构造微信消息
    let inputDesc = "";
    try {
      inputDesc = JSON.stringify(input || {}, null, 2).slice(0, 800);
    } catch {
      inputDesc = String(input);
    }
    const lines = [
      "⚠️ **需要你的授权确认**",
      `工具: ${tool_name}`,
      `请求ID: ${id.slice(0, 8)}`,
      "",
      "操作内容:",
      "```",
      inputDesc,
      "```",
      "",
      "回复：**允许** 或 **拒绝**",
      "或 **总是允许 <工具>**（如「总是允许 Bash」）免后续确认",
      "(5分钟内有效，超时自动拒绝)",
    ];

    try {
      // 先结束当前流式回复（授权前已输出的部分定型），授权完成后新起一条流
      if (this.pusher && typeof this.pusher.endTask === "function") {
        await this.pusher.endTask(null, null, true);
      }
      // 权限确认走统一主动推送（bot 可用走 bot，否则自建应用）
      // 多用户：推给当前操作用户的对话目标
      const bot = this.pusher && this.pusher.bot;
      const chatId =
        bot && bot.userChats && bot.currentUserId
          ? bot.userChats.get(bot.currentUserId)
          : undefined;
      await this.pusher.sendNotification(lines.join("\n"), "markdown", chatId);
    } catch (e) {
      this.log.error("权限确认推送失败", { err: e.message });
      this.pending.delete(id);
      return { ok: false, error: "推送失败: " + e.message };
    }

    this.log.info("发起权限确认", { id, tool_name });
    return { ok: true, id };
  }

  /**
   * 查询确认状态
   * @param {string} id
   */
  status(id) {
    const p = this.pending.get(id);
    if (!p) return { status: "not_found" };
    if (p.resolvedAt) {
      return { status: "resolved", result: p.result };
    }
    // 超时未回复 → 自动拒绝
    const timeoutMs = this.cfg.approver.timeoutMs;
    if (Date.now() - p.createdAt > timeoutMs) {
      p.resolvedAt = Date.now();
      p.result = { behavior: "deny", message: "确认超时，已自动拒绝" };
      return { status: "resolved", result: p.result };
    }
    return { status: "pending" };
  }

  /**
   * 处理用户在微信的回复
   * @param {string} text 用户消息
   * @returns {Promise<boolean>} 是否消费了这条消息
   */
  async handleReply(text) {
    const t = (text || "").trim();
    if (!t) return false;

    // 匹配最近的 pending 确认
    const now = Date.now();
    let candidate = null;
    let candidateId = null;
    for (const [id, p] of this.pending) {
      if (p.resolvedAt) continue;
      if (now - p.createdAt > this.cfg.approver.timeoutMs) continue;
      if (!candidate || p.createdAt > candidate.createdAt) {
        candidate = p;
        candidateId = id;
      }
    }
    if (!candidate) return false;

    let behavior = null;
    let alwaysAllowTool = null;
    // "总是允许 <工具>"：本次允许，并把该工具加入 always-allow 列表
    const alwaysM = /^总是允许\s+(.+)$/i.exec(t);
    if (alwaysM) {
      alwaysAllowTool = alwaysM[1].trim();
      behavior = "allow";
    } else if (/允许|批准|确认|同意|allow|yes|ok|好的|可以/i.test(t)) {
      behavior = "allow";
    } else if (/拒绝|禁止|不同意|deny|no|不行|取消/i.test(t)) {
      behavior = "deny";
    }
    if (!behavior) return false;

    candidate.resolvedAt = Date.now();
    candidate.result =
      behavior === "allow"
        ? { behavior: "allow", updatedInput: candidate.originalInput || {} }
        : { behavior: "deny", message: "用户在微信中拒绝" };

    if (alwaysAllowTool) {
      const ok = this._addAllowedTool(alwaysAllowTool);
      await this.pusher.pushSectioned(
        "权限",
        ok
          ? `✅ 已允许，并将「${alwaysAllowTool}」加入总是允许列表，后续自动放行。`
          : `✅ 已允许（但写入总是允许列表失败）`
      );
    } else {
      await this.pusher.pushSectioned(
        "权限",
        behavior === "allow" ? "✅ 已允许该操作" : "🚫 已拒绝该操作"
      );
    }
    this.log.info("权限确认已回复", { id: candidateId, behavior, alwaysAllowTool });
    return true;
  }

  /**
   * "总是允许"列表文件路径（与 claude.js 的 _loadAllowedTools 一致）
   */
  _allowedToolsFile() {
    const dir = require("path").dirname(this.cfg.registry.file);
    return require("path").join(dir, "allowed-tools.json");
  }

  /** 把工具规则加入总是允许列表 */
  _addAllowedTool(rule) {
    try {
      const fs = require("fs");
      const path = require("path");
      const dir = path.dirname(this.cfg.registry.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = this._allowedToolsFile();
      let list = [];
      if (fs.existsSync(file)) {
        try {
          list = JSON.parse(fs.readFileSync(file, "utf8"));
          if (!Array.isArray(list)) list = [];
        } catch {
          list = [];
        }
      }
      if (!list.includes(rule)) list.push(rule);
      fs.writeFileSync(file, JSON.stringify(list, null, 2), "utf8");
      this.log.info("加入总是允许列表", { rule });
      return true;
    } catch (e) {
      this.log.error("写入总是允许列表失败", { err: e.message });
      return false;
    }
  }
}

module.exports = { Approver };
