// P2 加解密/验签自测
const assert = require("assert");
const {
  getSignature,
  decryptMessage,
  encryptMessage,
  generateEncodingAESKey,
} = require("../src/wecom/crypto");
const { extractEncrypt, extractMessage } = require("../src/wecom/xml");

function testRoundtrip() {
  const aesKey = generateEncodingAESKey();
  assert.strictEqual(aesKey.length, 43, "EncodingAESKey 应为43字符");
  const corpid = "ww1234567890abcdef";
  const xml = `<xml>
  <ToUserName><![CDATA[${corpid}]]></ToUserName>
  <FromUserName><![CDATA[zhangsan]]></FromUserName>
  <CreateTime>1348831860</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[你好，测试一下]]></Content>
  <MsgId>1234567890123456</MsgId>
  <AgentID>1000002</AgentID>
</xml>`;

  const cipher = encryptMessage(aesKey, xml, corpid);
  const { message, receiveId } = decryptMessage(aesKey, cipher);

  assert.strictEqual(receiveId, corpid, "receiveId 应为 corpid");
  assert.strictEqual(message, xml, "解密应与明文一致");
  console.log("PASS roundtrip: 加解密一致, corpid校验通过");
}

function testSignature() {
  const token = "testtoken";
  const ts = "1409659813";
  const nonce = "1372623149";
  const encrypt = "aXJlIFRoaXMgbWFkZSBieSBXZUNvbQ==";
  // 用我们自己的实现算一遍，并验证确定性
  const s1 = getSignature(token, ts, nonce, encrypt);
  const s2 = getSignature(token, ts, nonce, encrypt);
  assert.strictEqual(s1, s2, "签名应确定性");
  assert.ok(/^[0-9a-f]{40}$/.test(s1), "签名应为40位小写hex");
  // 顺序无关性验证：token位置交换不影响结果
  const s3 = getSignature(nonce, ts, token, encrypt);
  assert.strictEqual(s1, s3, "sort后拼接应顺序无关");
  console.log("PASS signature: 40位小写hex, 顺序无关");
}

function testEncryptFieldExtraction() {
  const body = `<xml>
  <ToUserName><![CDATA[ww123]]></ToUserName>
  <AgentID><![CDATA[1000002]]></AgentID>
  <Encrypt><![CDATA[RE9OT1RQQVNT]]></Encrypt>
</xml>`;
  assert.strictEqual(extractEncrypt(body), "RE9OT1RQQVNT");
  console.log("PASS extractEncrypt: 提取<Encrypt>值成功");
}

function testMessageExtraction() {
  const xml = `<xml>
  <ToUserName><![CDATA[ww123]]></ToUserName>
  <FromUserName><![CDATA[zhangsan]]></FromUserName>
  <CreateTime>1348831860</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[继续改bug]]></Content>
  <MsgId>1234567890123456</MsgId>
  <AgentID>1</AgentID>
</xml>`;
  const msg = extractMessage(xml);
  assert.strictEqual(msg.MsgType, "text");
  assert.strictEqual(msg.Content, "继续改bug");
  assert.strictEqual(msg.FromUserName, "zhangsan");
  assert.strictEqual(msg.MsgId, "1234567890123456");
  console.log("PASS extractMessage: 字段提取正确");
}

testRoundtrip();
testSignature();
testEncryptFieldExtraction();
testMessageExtraction();
console.log("\n全部 P2 加解密测试通过");
