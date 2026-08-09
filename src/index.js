// 桥接服务入口
const { loadConfig, assertValid } = require("./config");
const { log } = require("./logger");
const fs = require("fs");
const path = require("path");
const { ProjectRegistry } = require("./projects");
const { WecomApi } = require("./wecom/api");
const { Pusher } = require("./pusher");
const { ClaudeRunner } = require("./claude");
const { Approver } = require("./approver");
const { BotClient } = require("./bot/bot-client");
const { buildServer } = require("./server");
const { startTunnel } = require("./tunnel/keepalive");

/**
 * 启动维护：清理 7 天前的媒体下载（图片/文件）。
 * 注意：真实日志已在 data/ 按天滚动（logger），Claude Code 的 jsonl 由其自身 cleanupPeriodDays 管理，此处不碰。
 */
function startupMaintenance(logger) {
  try {
    const mediaDir = path.join(
      process.env.USERPROFILE || process.env.HOME || "",
      ".claude",
      "wecom-bridge",
      "media"
    );
    if (fs.existsSync(mediaDir)) {
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      let cleaned = 0;
      for (const f of fs.readdirSync(mediaDir)) {
        const p = path.join(mediaDir, f);
        try {
          if (fs.statSync(p).mtimeMs < cutoff) {
            fs.unlinkSync(p);
            cleaned++;
          }
        } catch {}
      }
      if (cleaned) logger.info("媒体清理", { cleaned });
    }
  } catch (e) {
    logger.error("启动维护失败", { err: e.message });
  }
}

function main() {
  // stdout/stderr 断管道（如重定向到 /dev/null）时吞掉 EPIPE，避免死循环
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  const cfg = loadConfig();
  assertValid(cfg);

  // 启动维护：媒体目录清理（7 天前的下载图片/文件）
  startupMaintenance(log);

  log.info("启动 wecom-claude-bridge", { port: cfg.bridge.port });

  const registry = new ProjectRegistry(cfg.registry.file);
  const api = new WecomApi(cfg, log);
  const pusher = new Pusher(cfg, api, log);
  const approver = new Approver(cfg, api, pusher, log);
  const runner = new ClaudeRunner(cfg, log, registry, pusher);
  // 定时任务调度器（每分钟检查）
  runner.startCronScheduler();

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
