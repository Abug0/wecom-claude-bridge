// P3 命令解析单测
const assert = require("assert");
const { parseCommand, HELP_TEXT } = require("../src/commands");

// prompt
const p1 = parseCommand("继续改这个bug");
assert.strictEqual(p1.type, "prompt");
assert.strictEqual(p1.prompt, "继续改这个bug");

// 项目
const p2 = parseCommand("/项目 d:\\codes\\projects\\PROJECT");
assert.strictEqual(p2.type, "project");
assert.strictEqual(p2.selector, "d:\\codes\\projects\\PROJECT");

// 新开
const p3 = parseCommand("/新开 视频导出 帮我整理视频");
assert.strictEqual(p3.type, "new");
assert.strictEqual(p3.taskName, "视频导出");
assert.strictEqual(p3.prompt, "帮我整理视频");

// 新开无提示词
const p4 = parseCommand("/新开 写日报");
assert.strictEqual(p4.type, "new");
assert.strictEqual(p4.taskName, "写日报");
assert.strictEqual(p4.prompt, null);

// 切换
const p5 = parseCommand("/切换 写日报");
assert.strictEqual(p5.type, "switch");
assert.strictEqual(p5.selector, "写日报");

// 切换编号
const p6 = parseCommand("/切换 2");
assert.strictEqual(p6.type, "switch");
assert.strictEqual(p6.selector, "2");

// 列表
const p7 = parseCommand("/会话列表");
assert.strictEqual(p7.type, "list");
const p8 = parseCommand("/列表");
assert.strictEqual(p8.type, "list");

// 继续
const p9 = parseCommand("/继续 继续上次的任务");
assert.strictEqual(p9.type, "continue");
assert.strictEqual(p9.prompt, "继续上次的任务");

// 帮助
const p10 = parseCommand("/帮助");
assert.strictEqual(p10.type, "usage");

// 空消息
const p11 = parseCommand("");
assert.strictEqual(p11.type, "usage");

console.log("PASS commands: 全部命令解析正确");
console.log("HELP_TEXT 非空:", HELP_TEXT.length > 50);
