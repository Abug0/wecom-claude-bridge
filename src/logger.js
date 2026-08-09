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
  // 不再写 console.log/stdout：重定向到 /dev/null 或管道断开时会产生 EPIPE 死循环，
  // 且真实日志已写入 data/bridge-日期.log（按天滚动），stdout 副本无必要。
}

const log = {
  info: (msg, extra) => write("INFO", msg, extra),
  warn: (msg, extra) => write("WARN", msg, extra),
  error: (msg, extra) => write("ERROR", msg, extra),
};

module.exports = { log, redact };
