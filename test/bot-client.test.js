// BotClient 单元测试：mock ws 库，验证认证/收消息/流式/降级
const assert = require("assert");

// ---- 模拟 ws 库（ws 事件风格：on/emit + readyState 实例属性）----
let fakeWs = null;
let messagesSent = [];
class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this._listeners = {};
    fakeWs = this;
    messagesSent = [];
    setTimeout(() => this._emit("open"), 0);
  }
  on(evt, fn) {
    this._listeners[evt] = this._listeners[evt] || [];
    this._listeners[evt].push(fn);
    return this;
  }
  _emit(evt, ...args) {
    (this._listeners[evt] || []).forEach((fn) => fn(...args));
  }
  send(data) {
    messagesSent.push(JSON.parse(data));
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this._emit("close", 1000, "test");
  }
  // 测试辅助：模拟收到服务端消息
  emitMsg(obj) {
    this._emit("message", JSON.stringify(obj));
  }
}

// 通过 require.cache 把 ws 模块替换为 FakeWebSocket，使 bot-client 走 ws 库路径
const wsModulePath = require.resolve("ws");
require.cache[wsModulePath] = {
  id: wsModulePath,
  filename: wsModulePath,
  loaded: true,
  exports: FakeWebSocket,
};

const { BotClient } = require("../src/bot/bot-client");

const botCfg = {
  wsUrl: "wss://openws.work.weixin.qq.com",
  botId: "bot_123",
  botSecret: "secret_abc",
  streamIntervalMs: 50,
  streamIdleTimeoutMs: 1000,
  streamTotalTimeoutMs: 3000,
  reconnectMaxMs: 1000,
};

let logBuf = [];
const log = {
  info: (...a) => logBuf.push(["info", a]),
  warn: (...a) => logBuf.push(["warn", a]),
  error: (...a) => logBuf.push(["error", a]),
};

let handled = [];
const deps = {
  runner: { handleIncoming: async (ctx) => handled.push(ctx.msg.Content) },
  pusher: {},
  api: { sendMarkdown: async (t) => handled.push(["fallback", t]) },
  registry: {},
  approver: { handleReply: async () => false },
};

function setup() {
  handled = [];
  logBuf = [];
  fakeWs = null;
  messagesSent = [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 测试 1：认证 + 就绪 ----
async function testAuth() {
  setup();
  const bot = new BotClient(botCfg, log, deps);
  bot.start();
  await sleep(20);
  const sub = messagesSent.find((m) => m.cmd === "aibot_subscribe");
  assert(sub, "找到 subscribe 帧");
  assert.strictEqual(sub.body.bot_id, "bot_123");
  assert.strictEqual(sub.body.secret, "secret_abc");

  fakeWs.emitMsg({ headers: { req_id: "aibot_subscribe_1_abc" }, errcode: 0, errmsg: "ok" });
  assert.strictEqual(bot.available, true, "订阅成功后就绪");
  bot.stop();
  console.log("PASS 1 认证 + 就绪");
}

// ---- 测试 2：收用户消息 → handleIncoming ----
async function testReceive() {
  setup();
  const bot = new BotClient(botCfg, log, deps);
  bot.start();
  await sleep(10);
  fakeWs.emitMsg({ headers: { req_id: "aibot_subscribe_1_abc" }, errcode: 0, errmsg: "ok" });

  fakeWs.emitMsg({
    cmd: "aibot_msg_callback",
    headers: { req_id: "req_1" },
    body: { msgid: "msg_1", msgtype: "text", from_userid: "zhangsan", text: { content: "你好" } },
  });
  await sleep(20);
  assert.strictEqual(handled[0], "你好", "消息应转发给 runner");
  assert.strictEqual(bot.lastReqId, "req_1", "记录 req_id 供流式复用");
  bot.stop();
  console.log("PASS 2 收消息 → handleIncoming");
}

// ---- 测试 3：流式回复（打字机分片 + finish） ----
async function testStream() {
  setup();
  const bot = new BotClient(botCfg, log, deps);
  bot.start();
  await sleep(10);
  fakeWs.emitMsg({ headers: { req_id: "aibot_subscribe_1_abc" }, errcode: 0, errmsg: "ok" });

  const stream = bot.createStream("req_1", async () => {});
  stream.append("你好");
  stream.append("世界");
  await sleep(120);
  stream.finish("你好世界，完整版");

  const streamFrames = messagesSent.filter((m) => m.body && m.body.msgtype === "stream");
  assert(streamFrames.length >= 1, "应有流式分片");
  const last = streamFrames[streamFrames.length - 1];
  assert.strictEqual(last.body.stream.finish, true, "最后一帧 finish=true");
  assert.strictEqual(last.body.stream.content, "你好世界，完整版", "finish 内容为完整文本");
  assert.strictEqual(last.headers.req_id, "req_1", "复用 req_id");
  bot.stop();
  console.log("PASS 3 流式回复（分片 + finish 定型）");
}

// ---- 测试 4：空闲超时 → 降级 fallback ----
async function testIdleFallback() {
  setup();
  const bot = new BotClient({ ...botCfg, streamIdleTimeoutMs: 100 }, log, deps);
  bot.start();
  await sleep(10);
  fakeWs.emitMsg({ headers: { req_id: "aibot_subscribe_1_abc" }, errcode: 0, errmsg: "ok" });

  const fallbackCalled = [];
  const stream = bot.createStream("req_1", async (t) => fallbackCalled.push(t));
  stream.append("部分内容");
  await sleep(250);
  assert.strictEqual(fallbackCalled.length, 1, "空闲超时应降级补发");
  assert.strictEqual(fallbackCalled[0], "部分内容");
  bot.stop();
  console.log("PASS 4 空闲超时 → 降级 fallback");
}

// ---- 测试 5：pusher 无 bot 时降级自建应用 ----
async function testNoBotFallback() {
  const { Pusher } = require("../src/pusher");
  const sent = [];
  const api = {
    sendMarkdown: async (c) => sent.push(["md", c]),
    sendText: async (c) => sent.push(["text", c]),
  };
  const pusher = new Pusher({ pusher: { maxChunks: 6, maxBytes: 2048 } }, api, log);
  await pusher.pushStyled("任务", "**📝 回复**\n内容", "reply");
  // 无 bot 时降级 → sendNotification → api.sendText
  assert(sent.some(([t]) => t === "text"), "无 bot 应走 sendText（自建应用降级）");
  console.log("PASS 5 无 bot 时 pushStyled 降级自建应用");
}

// ---- 测试 6：pusher 有 bot 且 available 时走流式 ----
async function testStreamViaPusher() {
  setup();
  const bot = new BotClient(botCfg, log, deps);
  bot.start();
  await sleep(10);
  fakeWs.emitMsg({ headers: { req_id: "aibot_subscribe_1_abc" }, errcode: 0, errmsg: "ok" });
  bot.lastReqId = "req_x";

  const { Pusher } = require("../src/pusher");
  const sentMd = [];
  const api = { sendMarkdown: async (c) => sentMd.push(c), sendText: async (c) => {} };
  const pusher = new Pusher({ pusher: { maxChunks: 6, maxBytes: 2048 } }, api, log);
  pusher.attachBot(bot);

  const ok = pusher.beginTask("任务");
  assert(ok, "bot 可用时应开启流式");
  await pusher.pushStyled("任务", "思考中…", "thinking");
  await pusher.pushStyled("任务", "Bash 执行: git status", "tool");
  await pusher.pushStyled("任务", "**📝 回复**\n完整结果", "reply");
  await pusher.endTask("任务");

  const streamFrames = messagesSent.filter((m) => m.body && m.body.msgtype === "stream");
  assert(streamFrames.length >= 1, "应有流式分片");
  const last = streamFrames[streamFrames.length - 1];
  assert.strictEqual(last.body.stream.finish, true, "reply 应为 finish");
  assert.strictEqual(sentMd.length, 0, "流式走通时不应走 sendMarkdown");
  bot.stop();
  console.log("PASS 6 有 bot 时 pushStyled 走流式");
}

// ---- 测试 7：授权打断后自动重开新流 ----
async function testInterruptRestartStream() {
  setup();
  const bot = new BotClient(botCfg, log, deps);
  bot.start();
  await sleep(10);
  fakeWs.emitMsg({ headers: { req_id: "aibot_subscribe_1_abc" }, errcode: 0, errmsg: "ok" });
  bot.lastReqId = "req_1";

  const { Pusher } = require("../src/pusher");
  const api = { sendText: async () => {}, sendMarkdown: async () => {} };
  const pusher = new Pusher({ pusher: { maxChunks: 6, maxBytes: 2048 } }, api, log);
  pusher.attachBot(bot);

  // 任务开始（流 A）
  pusher.beginTask("任务", "req_1");
  await pusher.pushStyled("任务", "思考中…", "thinking");
  await pusher.pushStyled("任务", "Write 文件", "tool");

  // 授权打断 → 结束当前流（流 A finish）
  await pusher.endTask(null, null, true);
  const framesAfterInterrupt = messagesSent.filter((m) => m.body && m.body.msgtype === "stream");
  assert.strictEqual(framesAfterInterrupt.length >= 1, true, "授权打断时应 finish 当前流");
  const lastBefore = framesAfterInterrupt[framesAfterInterrupt.length - 1];
  assert.strictEqual(lastBefore.body.stream.finish, true, "授权前流的最后一片应 finish=true");

  // 授权后 claude 继续输出 → 自动重开新流（流 B）
  const countBefore = messagesSent.filter((m) => m.body && m.body.msgtype === "stream").length;
  await pusher.pushStyled("任务", "授权后继续回复", "reply");
  const framesAfter = messagesSent.filter((m) => m.body && m.body.msgtype === "stream");
  assert(framesAfter.length > countBefore, "授权后应新起一条流式消息");
  const newStreams = new Set(framesAfter.slice(countBefore).map((m) => m.body.stream.id));
  assert(newStreams.size === 1, "授权后应只有一个新流");
  const last = framesAfter[framesAfter.length - 1];
  assert.strictEqual(last.body.stream.finish, true, "授权后流的最后一片应 finish=true");
  assert.strictEqual(last.body.stream.content, "**📝 回复**\n授权后继续回复", "授权后内容应在新流里");

  await pusher.endTask("任务", null, false); // 任务正常结束
  bot.stop();
  console.log("PASS 7 授权打断后自动重开新流");
}

(async () => {
  await testAuth();
  await testReceive();
  await testStream();
  await testIdleFallback();
  await testNoBotFallback();
  await testStreamViaPusher();
  await testInterruptRestartStream();
  console.log("\n全部 BotClient 测试通过 ✅");
  process.exit(0);
})();
