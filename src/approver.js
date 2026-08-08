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
      "(5分钟内有效，超时自动拒绝)",
    ];

    try {
      await this.api.sendText(lines.join("\n"));
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
    if (/允许|批准|确认|同意|allow|yes|ok|好的|可以/i.test(t)) {
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
    await this.pusher.pushSectioned(
      "权限",
      behavior === "allow" ? "✅ 已允许该操作" : "🚫 已拒绝该操作"
    );
    this.log.info("权限确认已回复", { id: candidateId, behavior });
    return true;
  }
}

module.exports = { Approver };
