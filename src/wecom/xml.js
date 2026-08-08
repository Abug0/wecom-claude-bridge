// 极简 XML 字段提取（兼容 CDATA 与普通文本）
// 企业微信回调 XML 结构简单，正则提取即可，无需引入 XML 库

/**
 * 提取 XML 字段值
 * @param {string} xml
 * @param {string} name 字段名
 * @returns {string} 空串表示不存在
 */
function extractField(xml, name) {
  if (!xml) return "";
  // 优先 CDATA: <name><![CDATA[value]]></name>
  const cdata = xml.match(
    new RegExp(`<${name}><!\\[CDATA\\[(.*?)\\]\\]></${name}>`, "s")
  );
  if (cdata) return cdata[1];
  // 普通: <name>value</name>
  const plain = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, "s"));
  return plain ? plain[1] : "";
}

/**
 * 提取 POST 回调体里的 <Encrypt> 值
 * @param {string} body 原始 body 字符串
 * @returns {string}
 */
function extractEncrypt(body) {
  return extractField(body, "Encrypt");
}

/**
 * 从解密后的明文 XML 提取消息字段
 * @param {string} xml 明文XML
 * @returns {{
 *   MsgType: string,
 *   Content: string,
 *   FromUserName: string,
 *   ToUserName: string,
 *   MsgId: string,
 *   CreateTime: string,
 *   AgentID: string
 * }}
 */
function extractMessage(xml) {
  return {
    MsgType: extractField(xml, "MsgType"),
    Content: extractField(xml, "Content"),
    FromUserName: extractField(xml, "FromUserName"),
    ToUserName: extractField(xml, "ToUserName"),
    MsgId: extractField(xml, "MsgId"),
    CreateTime: extractField(xml, "CreateTime"),
    AgentID: extractField(xml, "AgentID"),
  };
}

module.exports = { extractField, extractEncrypt, extractMessage };
