// 企业微信消息加解密（内置实现，算法公开）
// 参考：https://developer.work.weixin.qq.com/document/path/90968
// 核心：EncodingAESKey(43字符) + "=" → base64解码得32字节AESKey
//       AES-256-CBC, IV = AESKey前16字节, PKCS#7填充(块32)
//       明文结构: random(16字节) + msg_len(4字节大端) + msg + receiveid(corpid)

const crypto = require("crypto");

/**
 * 计算签名
 * @param {string} token 回调Token
 * @param {string} timestamp 时间戳
 * @param {string} nonce 随机串
 * @param {string} encrypt 加密串（GET为echostr, POST为<Encrypt>值）
 * @returns {string} 小写hex签名
 */
function getSignature(token, timestamp, nonce, encrypt) {
  const hash = crypto.createHash("sha1");
  hash.update([token, timestamp, nonce, encrypt].sort().join(""));
  return hash.digest("hex");
}

/**
 * 解密企业微信消息
 * @param {string} encodingAESKey 43字符EncodingAESKey
 * @param {string} encryptedBase64 密文base64
 * @returns {{message: string, receiveId: string}}
 */
function decryptMessage(encodingAESKey, encryptedBase64) {
  const key = Buffer.from(encodingAESKey + "=", "base64");
  if (key.length !== 32) {
    throw new Error("EncodingAESKey 解码后必须是 32 字节");
  }
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  let buf = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, "base64")),
    decipher.final(),
  ]);

  // 去 PKCS#7 填充（块32）
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) {
    throw new Error("非法填充字节: " + pad);
  }
  buf = buf.subarray(0, buf.length - pad);

  // 明文结构: random(16) + msg_len(4大端) + msg + receiveid
  if (buf.length < 20) {
    throw new Error("明文长度不足");
  }
  const msgLen = buf.readUInt32BE(16);
  const message = buf.subarray(20, 20 + msgLen).toString("utf8");
  const receiveId = buf.subarray(20 + msgLen).toString("utf8");
  return { message, receiveId };
}

/**
 * 加密（用于测试与回显）
 * @param {string} encodingAESKey 43字符EncodingAESKey
 * @param {string} msg 明文XML
 * @param {string} receiveId corpid
 * @param {string} [randomStr] 16字节随机串
 * @returns {string} 密文base64
 */
function encryptMessage(encodingAESKey, msg, receiveId, randomStr) {
  const key = Buffer.from(encodingAESKey + "=", "base64");
  const iv = key.subarray(0, 16);
  const random = randomStr ? Buffer.from(randomStr, "utf8") : crypto.randomBytes(16);
  const msgBuf = Buffer.from(msg, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const receiveBuf = Buffer.from(receiveId, "utf8");

  const plain = Buffer.concat([random, lenBuf, msgBuf, receiveBuf]);

  // PKCS#7 填充（块32）
  const blockSize = 32;
  const padLen = blockSize - (plain.length % blockSize);
  const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)]);

  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString("base64");
}

/**
 * 生成 43 字符 EncodingAESKey（企业微信格式的 base64，无等号，43位）
 * @returns {string}
 */
function generateEncodingAESKey() {
  // 32字节随机 → base64 → 去掉尾部等号，保留43位
  return crypto.randomBytes(32).toString("base64").replace(/=+$/, "").slice(0, 43);
}

module.exports = {
  getSignature,
  decryptMessage,
  encryptMessage,
  generateEncodingAESKey,
};
