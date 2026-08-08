// 桥接服务入口
const { loadConfig, assertValid } = require("./config");
const { log } = require("./logger");
const { ProjectRegistry } = require("./projects");
const { WecomApi } = require("./wecom/api");
const { Pusher } = require("./pusher");
const { ClaudeRunner } = require("./claude");
const { Approver } = require("./approver");
const { BotClient } = require("./bot/bot-client");
const { buildServer } = require("./server");
const { startTunnel } = require("./tunnel/keepalive");

function main() {
  const cfg = loadConfig();
  assertValid(cfg);

  log.info("启动 wecom-claude-bridge", { port: cfg.bridge.port });

  const registry = new ProjectRegistry(cfg.registry.file);
  const api = new WecomApi(cfg, log);
  const pusher = new Pusher(cfg, api, log);
  const approver = new Approver(cfg, api, pusher, log);
  const runner = new ClaudeRunner(cfg, log, registry, pusher);

  // 智能机器人通道（默认对话流式；未配置则纯自建应用模式）
  let bot = null;
  if (cfg.bot.enabled && cfg.bot.botId && cfg.bot.botSecret) {
    bot = new BotClient(cfg.bot, log, {
      runner,
      pusher,
      api,
      registry,
      approver,
    });
    pusher.attachBot(bot);
    bot.start();
    log.info("智能机器人通道已启用");
  } else {
    log.info("智能机器人未配置，使用自建应用通道");
  }

  const app = buildServer({ cfg, log, registry, runner, api, approver });

  app.listen(cfg.bridge.port, cfg.bridge.host, () => {
    log.info(`桥接服务已启动: http://${cfg.bridge.host}:${cfg.bridge.port}`);
  });

  if (cfg.tunnel.enabled) {
    startTunnel(cfg, log);
  }

  // 优雅退出
  process.on("SIGINT", () => {
    if (bot) bot.stop();
    log.info("收到 SIGINT，退出");
    process.exit(0);
  });
  process.on("uncaughtException", (e) => {
    log.error("未捕获异常", { err: e.message, stack: e.stack });
  });
}

main();
