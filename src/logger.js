// 简易日志：按天滚动，脱敏
const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "data");

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function logPath() {
  return path.join(LOG_DIR, `bridge-${todayStr()}.log`);
}

// 脱敏：隐藏 secret 类字段
const SECRET_KEYS = ["secret", "token", "aeskey", "encodingaeskey", "password"];
function redact(obj) {
  if (typeof obj === "string") {
    // 长 secret 掩码
    if (obj.length > 20) return obj.slice(0, 4) + "***";
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEYS.some((s) => k.toLowerCase().includes(s))) {
        out[k] = redact(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return obj;
}

function write(level, msg, extra) {
  ensureDir();
  const ts = new Date().toISOString();
  let line = `[${ts}] [${level}] ${msg}`;
  if (extra !== undefined) {
    try {
      line += " " + JSON.stringify(redact(extra));
    } catch {
      line += " " + String(extra);
    }
  }
  fs.appendFileSync(logPath(), line + "\n");
  // 同时输出到控制台
  const colored = {
    INFO: "\x1b[32m",
    WARN: "\x1b[33m",
    ERROR: "\x1b[31m",
  };
  const color = colored[level] || "";
  console.log(`${color}${line}\x1b[0m`);
}

const log = {
  info: (msg, extra) => write("INFO", msg, extra),
  warn: (msg, extra) => write("WARN", msg, extra),
  error: (msg, extra) => write("ERROR", msg, extra),
};

module.exports = { log, redact };
