// 自动识别当前 VSCode 会话
// 扫描 ~/.claude/projects/<encoded-cwd>/*.jsonl 尾部，
// 找 entrypoint:"claude-vscode" 的最近 user 消息所在会话
const fs = require("fs");
const path = require("path");
const { encodeCwd } = require("./projects");

/** 读取文件尾部（避免全量读大文件） */
function readTail(filePath, maxBytes = 65536) {
  const fd = fs.openSync(filePath, "r");
  const size = fs.fstatSync(fd).size;
  const len = Math.min(size, maxBytes);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  return buf.toString("utf8");
}

/**
 * 扫描项目目录下的 jsonl，识别最近活跃的 VSCode 会话
 * @param {string} sessionDir 如 /home/user\USER\.claude\projects
 * @param {string} cwd 工作目录，如 /path\projects\PROJECT
 * @returns {{sessionId: string, cwd: string, slug: string} | null}
 */
function detectActiveSession({ sessionDir, cwd }) {
  const encoded = encodeCwd(cwd);
  const dir = path.join(sessionDir, encoded);
  if (!fs.existsSync(dir)) return null;

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"));
  let best = null;
  let bestMtime = 0;

  for (const f of files) {
    const p = path.join(dir, f);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0) continue;

    const tail = readTail(p, 65536);
    const lines = tail.split("\n").filter((l) => l.trim());
    // 从最新往旧找最近一条 VSCode user 消息
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]);
        const cwdOk =
          typeof r.cwd === "string" &&
          r.cwd.replace(/\\/g, "/").toLowerCase().startsWith(
            cwd.replace(/\\/g, "/").toLowerCase()
          );
        if (
          r.type === "user" &&
          r.entrypoint === "claude-vscode" &&
          cwdOk
        ) {
          if (st.mtimeMs > bestMtime) {
            best = {
              sessionId: r.sessionId,
              cwd: r.cwd,
              slug: r.slug || null,
            };
            bestMtime = st.mtimeMs;
          }
          break; // 该文件已找到最近一条 VSCode user 消息
        }
      } catch {
        /* 跳过损坏行 */
      }
    }
  }

  if (best) return best;

  // 兜底：取最新 mtime 的 jsonl 并读其 sessionId
  let latestFile = null;
  let latestMtime = 0;
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latestFile = p;
      }
    } catch {}
  }
  if (latestFile) {
    const tail = readTail(latestFile, 65536);
    const lines = tail.split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (r.sessionId) {
          return { sessionId: r.sessionId, cwd: r.cwd, slug: r.slug };
        }
      } catch {}
    }
  }
  return null;
}

/**
 * 列出项目目录下最近的 VSCode 会话（按 mtime 排序）
 * @param {string} sessionDir
 * @param {string} cwd
 * @param {number} limit 最多返回几个
 * @returns {Array<{sessionId: string, slug: string|null, lastPrompt: string|null, mtimeMs: number}>}
 */
function listRecentSessions({ sessionDir, cwd, limit = 10 }) {
  const encoded = encodeCwd(cwd);
  const dir = path.join(sessionDir, encoded);
  if (!fs.existsSync(dir)) return [];

  const result = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    const p = path.join(dir, f);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0) continue;
    // 读尾部找 slug、lastPrompt 和 sessionId
    let slug = null;
    let sessionId = null;
    let lastPrompt = null;
    try {
      const tail = readTail(p, 16384);
      const lines = tail.split("\n").filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        const r = JSON.parse(lines[i]);
        if (r.sessionId) {
          sessionId = r.sessionId;
          if (r.slug) slug = r.slug;
        }
        if (r.type === "last-prompt" && r.lastPrompt) {
          lastPrompt = r.lastPrompt;
        }
        if (sessionId && slug) break;
      }
    } catch {}
    if (!sessionId) sessionId = f.replace(".jsonl", "");
    result.push({ sessionId, slug, lastPrompt, mtimeMs: st.mtimeMs });
  }
  result.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return limit > 0 ? result.slice(0, limit) : result;
}

/**
 * 提取会话的最近对话历史（user/assistant 消息）
 * @param {string} sessionDir
 * @param {string} cwd
 * @param {string} sessionId
 * @param {number} limit 返回最近几条消息（默认10条）
 * @returns {Array<{role: 'user'|'assistant', text: string}>}
 */
function readSessionHistory({ sessionDir, cwd, sessionId, limit = 10 }) {
  const encoded = encodeCwd(cwd);
  const filePath = path.join(sessionDir, encoded, sessionId + ".jsonl");
  if (!fs.existsSync(filePath)) return [];

  const messages = [];
  try {
    const data = fs.readFileSync(filePath, "utf8");
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.type !== "user" && d.type !== "assistant") continue;
        const msg = d.message || {};
        const role = d.type === "user" ? "user" : "assistant";
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((i) => i && i.type === "text" && i.text)
            .map((i) => i.text)
            .join("\n");
        }
        if (text && text.trim()) {
          messages.push({ role, text: text.trim() });
        }
      } catch {}
    }
  } catch {
    return [];
  }
  return messages.slice(-limit);
}

/**
 * 格式化会话显示名：优先用最近提示词（截断），否则用 slug
 * @param {{slug, lastPrompt, sessionId}} s
 * @returns {string}
 */
function formatSessionName(s) {
  if (s.lastPrompt) {
    const p = s.lastPrompt.replace(/\s+/g, " ").trim();
    return p.length > 40 ? p.slice(0, 40) + "…" : p;
  }
  if (s.slug) return s.slug;
  return s.sessionId.slice(0, 8);
}

module.exports = { detectActiveSession, listRecentSessions, readSessionHistory, formatSessionName, readTail };
