// SSH 反向隧道 watchdog：断线自动重连
const { spawn } = require("child_process");

function startTunnel(cfg, log) {
  if (!cfg.tunnel.enabled) return;
  if (!cfg.tunnel.server || !cfg.tunnel.remoteUser || !cfg.tunnel.key) {
    log.warn("隧道已启用但缺少配置，跳过");
    return;
  }

  let backoff = 1;
  let shuttingDown = false;

  const args = [
    "-N",
    "-T",
    `-R${cfg.tunnel.remotePort}:127.0.0.1:${cfg.bridge.port}`,
    "-oServerAliveInterval=30",
    "-oServerAliveCountMax=3",
    "-oExitOnForwardFailure=yes",
    "-oStrictHostKeyChecking=accept-new",
    "-oConnectTimeout=15",
    "-i",
    cfg.tunnel.key,
    `${cfg.tunnel.remoteUser}@${cfg.tunnel.server}`,
  ];

  function launch() {
    if (shuttingDown) return;
    log.info("建立反向隧道", args.join(" "));
    const child = spawn("ssh", args, { windowsHide: true, stdio: "ignore" });
    child.on("spawn", () => {
      backoff = 1;
    });
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      log.warn(`隧道退出(code=${code}, signal=${signal})，${backoff * 5}s 后重连`);
      setTimeout(launch, backoff * 5000);
      backoff = Math.min(backoff * 2, 60);
    });
    child.on("error", (e) => {
      if (shuttingDown) return;
      log.error("隧道启动错误", { err: e.message });
      setTimeout(launch, backoff * 5000);
      backoff = Math.min(backoff * 2, 60);
    });
    return child;
  }

  launch();
  log.info(`反向隧道 watchdog 已启动: ${cfg.tunnel.remoteUser}@${cfg.tunnel.server} → :${cfg.bridge.port}`);
}

module.exports = { startTunnel };
