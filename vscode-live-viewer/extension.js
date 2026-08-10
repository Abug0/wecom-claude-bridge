// 微信远程实时视图：监听 ~/.claude/projects/**/*.jsonl 增量，实时推送消息到 webview
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const SESSION_ROOT = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  ".claude",
  "projects"
);
const LIVE_ROOT = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  ".claude",
  "wecom-bridge",
  "live"
);
const POLL_MS = 500; // 轮询间隔（流式更密集）

/** @type {Map<string, {filePath:string, offset:number, size:number, livePath:string, liveOffset:number}>} */
const trackers = new Map(); // sessionId -> 偏移跟踪

function activate(context) {
  const provider = new LiveViewProvider();
  const registration = vscode.window.registerWebviewViewProvider(
    "wecomLiveView",
    provider
  );
  context.subscriptions.push(registration);
}

class LiveViewProvider {
  resolveWebviewView(webviewView) {
    this._view = webviewView;
    this._watchers = []; // fs.watch 句柄
    this._refreshTimer = null; // 防抖定时器
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._html();

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "listSessions") {
        this._sendSessions();
      } else if (msg.type === "selectSession") {
        this._sendHistory(msg.sessionId);
      } else if (msg.type === "refresh") {
        this._sendSessions();
      }
    });

    // 启动轮询（流式增量）+ 文件监听（事件驱动刷新会话列表）
    this._timer = setInterval(() => this._poll(), POLL_MS);
    this._updateWatchers();
    // 兜底：30 秒定期刷新（fs.watch 可能漏事件）
    this._fallbackTimer = setInterval(() => this._sendSessions(), 30000);
    // 视图关闭时清理
    webviewView.onDidDispose(() => {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      if (this._fallbackTimer) clearInterval(this._fallbackTimer);
      this._fallbackTimer = null;
      this._cleanupWatchers();
    });

    // 初始推送会话列表
    setTimeout(() => this._sendSessions(), 500);
  }

  /** 扫描所有 jsonl 会话，按 mtime 排序 */
  _listSessions() {
    const out = [];
    if (!fs.existsSync(SESSION_ROOT)) return out;
    for (const proj of fs.readdirSync(SESSION_ROOT)) {
      const projDir = path.join(SESSION_ROOT, proj);
      let st;
      try {
        st = fs.statSync(projDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      let files;
      try {
        files = fs.readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const p = path.join(projDir, f);
        try {
          const s = fs.statSync(p);
          if (!s.isFile() || s.size === 0) continue;
          out.push({
            sessionId: f.replace(".jsonl", ""),
            project: proj,
            name: this._sessionName(p),
            mtimeMs: s.mtimeMs,
            size: s.size,
          });
        } catch {}
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out.slice(0, 50);
  }

  /**
   * 事件驱动：fs.watch 监听 SESSION_ROOT 和每个项目目录，
   * 新会话/新消息出现时即时刷新会话列表（防抖 200ms）
   */
  _updateWatchers() {
    this._cleanupWatchers();
    if (!fs.existsSync(SESSION_ROOT)) return;
    // 监听 SESSION_ROOT（新项目目录出现）
    try {
      const w = fs.watch(SESSION_ROOT, () => this._scheduleRefresh());
      w.on("error", () => {});
      this._watchers.push(w);
    } catch {}
    // 监听每个项目目录（新 jsonl 出现）
    for (const proj of fs.readdirSync(SESSION_ROOT)) {
      const dir = path.join(SESSION_ROOT, proj);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        const w = fs.watch(dir, () => this._scheduleRefresh());
        w.on("error", () => {});
        this._watchers.push(w);
      } catch {}
    }
  }

  _cleanupWatchers() {
    for (const w of this._watchers || []) {
      try {
        w.close();
      } catch {}
    }
    this._watchers = [];
  }

  /** 防抖刷新会话列表（200ms 内多次事件合并为一次） */
  _scheduleRefresh() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._updateWatchers(); // 项目目录可能变化，重建 watcher
      this._sendSessions();
    }, 200);
  }

  /** 从 jsonl 尾部提取会话显示名（lastPrompt > slug > sessionId 前8位） */
  _sessionName(filePath) {
    try {
      const size = fs.statSync(filePath).size;
      const len = Math.min(size, 16384);
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      let lastPrompt = null;
      let slug = null;
      for (const line of buf.toString("utf8").split("\n")) {
        const l = line.trim();
        if (!l) continue;
        try {
          const d = JSON.parse(l);
          if (d.slug) slug = d.slug;
          if (d.type === "last-prompt" && d.lastPrompt) lastPrompt = d.lastPrompt;
        } catch {}
      }
      if (lastPrompt) {
        const p = lastPrompt.replace(/\s+/g, " ").trim();
        return p.length > 40 ? p.slice(0, 40) + "…" : p;
      }
      if (slug) return slug;
    } catch {}
    return filePath.replace(/\.jsonl$/, "").split(/[\\/]/).pop().slice(0, 8);
  }

  _sendSessions() {
    if (!this._view) return;
    const sessions = this._listSessions();
    // 同步 tracker（新会话初始化偏移）
    for (const s of sessions) {
      if (!trackers.has(s.sessionId)) {
        trackers.set(s.sessionId, {
          filePath: this._filePath(s.project, s.sessionId),
          offset: 0,
          size: 0,
          livePath: path.join(LIVE_ROOT, s.sessionId + ".live"),
          liveOffset: 0,
        });
      }
    }
    this._view.webview.postMessage({ type: "sessions", sessions });
  }

  _filePath(project, sessionId) {
    return path.join(SESSION_ROOT, project, sessionId + ".jsonl");
  }

  /** 发送某会话完整历史（切换会话时），并带上 .live 剩余内容 */
  _sendHistory(sessionId) {
    if (!this._view) return;
    const t = trackers.get(sessionId);
    if (!t) return;
    let messages = [];
    if (fs.existsSync(t.filePath)) {
      const size = fs.statSync(t.filePath).size;
      t.offset = size;
      messages = this._parseRange(t.filePath, 0, size);
    }
    // .live 剩余（未结束的流式内容）
    if (fs.existsSync(t.livePath)) {
      const size = fs.statSync(t.livePath).size;
      t.liveOffset = size;
      const liveItems = this._parseLiveRange(t.livePath, 0, size);
      messages = messages.concat(liveItems);
    }
    this._view.webview.postMessage({ type: "messages", sessionId, messages });
  }

  /** 轮询所有会话：jsonl 增量 + .live 流式增量 */
  _poll() {
    if (!this._view) return;
    for (const [sessionId, t] of trackers) {
      // jsonl 块级增量
      if (fs.existsSync(t.filePath)) {
        let size;
        try {
          size = fs.statSync(t.filePath).size;
        } catch {
          size = 0;
        }
        if (size > t.offset) {
          const messages = this._parseRange(t.filePath, t.offset, size);
          t.offset = size;
          if (messages.length) {
            this._view.webview.postMessage({ type: "messages", sessionId, messages });
          }
        }
      }
      // .live 流式增量（逐字级）
      if (fs.existsSync(t.livePath)) {
        let size;
        try {
          size = fs.statSync(t.livePath).size;
        } catch {
          size = 0;
        }
        if (size > t.liveOffset) {
          const items = this._parseLiveRange(t.livePath, t.liveOffset, size);
          t.liveOffset = size;
          if (items.length) {
            this._view.webview.postMessage({ type: "live", sessionId, items });
          }
        }
      }
    }
  }

  /** 解析 .live 增量文件的 [start, end) 区间（每行 JSON {kind,text}） */
  _parseLiveRange(filePath, start, end) {
    const items = [];
    try {
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, end - start, start);
      fs.closeSync(fd);
      for (const line of buf.toString("utf8").split("\n")) {
        const l = line.trim();
        if (!l) continue;
        try {
          const d = JSON.parse(l);
          if (d.kind && d.text !== undefined) items.push(d);
          else if (d.kind === "end") items.push({ kind: "end" });
        } catch {}
      }
    } catch {}
    return items;
  }

  /** 解析 jsonl 的 [start, end) 字节区间，提取消息 */
  _parseRange(filePath, start, end) {
    const messages = [];
    try {
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, end - start, start);
      fs.closeSync(fd);
      for (const line of buf.toString("utf8").split("\n")) {
        const m = this._parseLine(line);
        if (m) messages.push(m);
      }
    } catch {}
    return messages;
  }

  /** 解析一行 jsonl → 消息对象或 null */
  _parseLine(line) {
    const l = line.trim();
    if (!l) return null;
    let d;
    try {
      d = JSON.parse(l);
    } catch {
      return null;
    }
    const msg = d.message;
    if (!msg || typeof msg !== "object") return null;
    const content = msg.content;

    if (d.type === "user") {
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content
          .filter((i) => i && i.type === "text" && i.text)
          .map((i) => i.text)
          .join("\n");
      }
      if (text.trim()) {
        return { role: "user", text: text.trim(), ts: d.timestamp };
      }
    } else if (d.type === "assistant") {
      if (Array.isArray(content)) {
        const parts = [];
        for (const item of content) {
          if (!item) continue;
          if (item.type === "text" && item.text && item.text.trim()) {
            parts.push({ kind: "text", text: item.text.trim() });
          } else if (item.type === "thinking" && item.thinking) {
            parts.push({ kind: "thinking", text: item.thinking.trim() });
          } else if (item.type === "tool_use" && item.name) {
            let input = "";
            try {
              input = JSON.stringify(item.input || {}, null, 1);
            } catch {}
            parts.push({ kind: "tool", name: item.name, text: input });
          }
        }
        if (parts.length) {
          return { role: "assistant", parts, ts: d.timestamp };
        }
      }
    }
    return null;
  }

  _html() {
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; margin: 0; padding: 8px; color: var(--vscode-foreground); display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  .toolbar { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; flex: none; }
  select { flex: 1; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 3px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 10px; cursor: pointer; }
  .msg { margin: 6px 0; padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
  .user { background: var(--vscode-editor-selectionBackground); }
  .assistant { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
  .tool { color: var(--vscode-charts-orange, #d19a66); font-size: 12px; margin: 2px 0; }
  .thinking { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 12px; margin: 2px 0; white-space: pre-wrap; }
  .label { font-weight: 600; margin-bottom: 4px; }
  .tool-label { color: #d19a66; font-weight: 600; }
  .empty { color: var(--vscode-descriptionForeground); text-align: center; margin-top: 40px; }
  .live { margin: 1px 0; white-space: pre-wrap; word-break: break-word; }
  .live.reply { color: var(--vscode-foreground); }
  .live.thinking { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 12px; }
  .live.tool { color: var(--vscode-charts-orange, #d19a66); font-size: 12px; }
  .end-line { border-top: 1px dashed var(--vscode-panel-border); margin: 6px 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
  #list { flex: 1; overflow-y: auto; }
</style>
</head>
<body>
  <div class="toolbar">
    <select id="sessionSel"></select>
    <button id="refreshBtn">刷新</button>
  </div>
  <div id="list"><div class="empty">正在加载会话…</div></div>
<script>
  const vscode = acquireVsCodeApi();
  const sel = document.getElementById('sessionSel');
  const list = document.getElementById('list');
  let current = null;
  let liveItems = [];
  let knownSessions = new Set();

  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // 等 DOM 布局完成后滚动到底部（最新消息）
  function scrollToBottom() {
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
  }

  function render(messages) {
    if (!messages || !messages.length) {
      list.innerHTML = '<div class="empty">暂无消息。在微信里操作 Claude Code 后这里会实时显示。</div>';
      return;
    }
    list.innerHTML = messages.map(m => {
      if (m.role === 'user') {
        return '<div class="msg user"><div class="label">🧑 你</div>' + esc(m.text) + '</div>';
      }
      if (m.role === 'assistant') {
        const parts = (m.parts || []).map(p => {
          if (p.kind === 'text') return esc(p.text);
          if (p.kind === 'thinking') return '<div class="thinking">🤔 ' + esc(p.text) + '</div>';
          if (p.kind === 'tool') return '<div class="tool"><span class="tool-label">🔧 ' + esc(p.name || '工具') + '</span>' + (p.text ? '<pre>' + esc(p.text) + '</pre>' : '') + '</div>';
          return '';
        }).join('');
        return '<div class="msg assistant"><div class="label">🤖 Claude</div>' + parts + '</div>';
      }
      return '';
    }).join('');
    scrollToBottom();
  }

  function loadSession(sessionId) {
    current = sessionId;
    liveItems = [];
    vscode.postMessage({ type: 'selectSession', sessionId });
  }

  function renderLive(items) {
    for (const it of items) {
      if (it.kind === 'end') {
        const d = document.createElement('div');
        d.className = 'end-line';
        d.textContent = '── 本轮结束 ──';
        list.appendChild(d);
        continue;
      }
      const el = document.createElement('div');
      if (it.kind === 'reply') {
        el.className = 'live reply';
        el.textContent = it.text;
      } else if (it.kind === 'thinking') {
        el.className = 'live thinking';
        el.textContent = '🤔 ' + it.text;
      } else if (it.kind === 'tool') {
        el.className = 'live tool';
        el.textContent = '🔧 ' + it.text;
      } else {
        continue;
      }
      list.appendChild(el);
    }
    scrollToBottom();
  }

  sel.addEventListener('change', () => {
    if (sel.value) loadSession(sel.value);
  });
  document.getElementById('refreshBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'listSessions' });
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'sessions') {
      const cur = sel.value;
      const ids = msg.sessions.map(s => s.sessionId);
      // 检测新会话（之前未见过）→ 自动聚焦最新的新会话
      const newOnes = msg.sessions.filter(s => !knownSessions.has(s.sessionId));
      knownSessions = new Set(ids);
      sel.innerHTML = msg.sessions.map(s =>
        '<option value="' + s.sessionId + '" title="' + s.project + '">' + esc(s.name || s.sessionId.slice(0, 8)) + '</option>'
      ).join('');
      if (newOnes.length && ids.length) {
        // 自动聚焦最新的新会话（sessions 按 mtime 倒序，第一个最新）
        sel.value = ids[0];
        loadSession(ids[0]);
      } else if (cur && msg.sessions.some(s => s.sessionId === cur)) {
        sel.value = cur;
      } else if (msg.sessions.length) {
        sel.value = msg.sessions[0].sessionId;
        loadSession(msg.sessions[0].sessionId);
      } else {
        list.innerHTML = '<div class="empty">暂无会话。用微信操作 Claude Code 后自动出现。</div>';
      }
    } else if (msg.type === 'messages') {
      if (current === msg.sessionId) render(msg.messages);
    } else if (msg.type === 'live') {
      if (current === msg.sessionId) {
        liveItems.push(...msg.items);
        renderLive(msg.items);
      }
    }
  });

  vscode.postMessage({ type: 'listSessions' });
</script>
</body>
</html>`;
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
