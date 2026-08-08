// 企业微信服务端 API：access_token 缓存 + 发送应用消息
const https = require("https");
const API_HOST = "qyapi.weixin.qq.com";

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("响应解析失败: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("企业微信 API 请求超时"));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

class WecomApi {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.token = null;
    this.expiresAt = 0;
    this.inflight = null;
  }

  /**
   * 获取 access_token（带缓存 + 并发去重 + 提前刷新）
   * @param {boolean} force 强制刷新
   */
  async getToken(force = false) {
    const cfg = this.cfg;
    if (!force && this.token && Date.now() < this.expiresAt - cfg.pusher.earlyRefreshMs) {
      return this.token;
    }
    if (!this.inflight) {
      this.inflight = this._fetchToken().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async _fetchToken() {
    const cfg = this.cfg;
    const url = `/cgi-bin/gettoken?corpid=${encodeURIComponent(
      cfg.wecom.corpId
    )}&corpsecret=${encodeURIComponent(cfg.wecom.secret)}`;
    const res = await request({ hostname: API_HOST, path: url, method: "GET" });
    if (res.errcode) {
      throw new Error(`获取 access_token 失败: ${res.errcode} ${res.errmsg}`);
    }
    this.token = res.access_token;
    this.expiresAt = Date.now() + (res.expires_in - 120) * 1000; // 提前2分钟过期
    this.log.info("已获取新的 access_token");
    return this.token;
  }

  /**
   * 发送文本消息（主动推送）
   * @param {string} content 文本内容（≤2048字节）
   */
  async sendText(content) {
    // 企业微信 text 类型要求 body 结构为 text: {content}
    return this._send("text", { text: { content } });
  }

  /**
   * 发送 markdown 消息（主动推送，样式区分）
   * @param {string} content markdown 内容（≤2048字节，仅支持官方子集语法）
   */
  async sendMarkdown(content) {
    // 企业微信 markdown 类型要求 body 结构为 markdown: {content}，不是顶层 content
    return this._send("markdown", { markdown: { content } });
  }

  /**
   * 发送应用消息（通用）
   * @param {string} msgtype text | markdown | textcard ...
   * @param {object} payload 对应 msgtype 的负载（不含 touser/agentid）
   */
  async _send(msgtype, payload) {
    const cfg = this.cfg;
    // 云转发模式：POST 到云服务器 /wecom/send，源IP为云服务器（企业微信可信IP只需加云IP）
    if (cfg.wecom.sendViaCloud && cfg.wecom.bridgeSecret) {
      const endpoint = cfg.wecom.sendViaCloud || "https://www.your-domain.com/wecom/send";
      const res = await request(
        {
          hostname: new URL(endpoint).hostname,
          port: 443,
          path: new URL(endpoint).pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Bridge-Secret": cfg.wecom.bridgeSecret,
          },
        },
        { msgtype, payload }
      );
      if (res.ok) return res;
      // 云转发失败时回退本地直连
      this.log.warn("云转发失败，回退本地直连", { err: res.error });
    }
    const token = await this.getToken();
    const body = {
      touser: cfg.wecom.touser,
      msgtype,
      agentid: cfg.wecom.agentId,
      ...payload,
      safe: 0,
    };
    const res = await request(
      {
        hostname: API_HOST,
        path: `/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      body
    );
    // token 失效则强制刷新重试一次
    if (res.errcode === 40014 || res.errcode === 42001) {
      const newToken = await this.getToken(true);
      const res2 = await request(
        {
          hostname: API_HOST,
          path: `/cgi-bin/message/send?access_token=${encodeURIComponent(newToken)}`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        body
      );
      if (res2.errcode) {
        throw new Error(`发送消息失败(重试): ${res2.errcode} ${res2.errmsg}`);
      }
      return res2;
    }
    if (res.errcode) {
      throw new Error(`发送消息失败: ${res.errcode} ${res.errmsg}`);
    }
    return res;
  }
}

module.exports = { WecomApi };
