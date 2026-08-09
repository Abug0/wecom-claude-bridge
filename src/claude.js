// claude.exe 调用器 + 串行队列 + 超时/杀进程 + 命令分发
const { spawn, execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseCommand, HELP_TEXT } = require("./commands");
const { detectActiveSession, listRecentSessions, readSessionHistory, formatSessionName } = require("./detector");
const { encodeCwd } = require("./projects");

class ClaudeRunner {
  constructor(cfg, log, registry, pusher) {
    this.cfg = cfg;
    this.log = log;
    this.registry = registry;
    this.pusher = pusher;
    this.queues = new Map(); // sessionId -> job[]（同一会话串行，不同会话可并行）
    this.running = new Set(); // 正在执行的 sessionId
    this.actives = new Map(); // sessionId -> claude 子进程
    this.activeJobs = new Map(); // sessionId -> { taskName, startedAt }（/状态 显示多个运行中任务）
    this.MAX_CONCURRENT = 3; // 最多同时执行 3 个会话
    this.activeJobName = null; // 兼容旧引用（最近任务名）
    this.activeStartedAt = null;
    this.watchInfo = null; // 会话实时监控状态（/盯 用）
    this.permissionMode = cfg.claude.permissionMode; // 当前权限模式（/模式 可切换）
    this.aborting = new Set(); // /停止 待中止的 sessionId 集合（并行安全）
    this.model = null; // 当前模型覆盖（/model 可切换，null=用默认）
    this.effort = null; // 当前推理努力程度（/effort，null=用默认）
    this.thinkingEnabled = false; // /thinking 思考内容展示开关（默认只显示"思考中…"）
  }

  /**
   * 处理一条入站消息（命令分发 + 入队）
   * @param {{msg, api, registry, approver}} ctx
   */
  async handleIncoming(ctx) {
    const content = ctx.msg.Content;
    const cmd = parseCommand(content);

    switch (cmd.type) {
      case "project": {
        await this._handleProject(ctx, cmd);
        break;
      }
      case "new": {
        await this._handleNew(ctx, cmd);
        break;
      }
      case "switch": {
        await this._handleSwitch(ctx, cmd);
        break;
      }
      case "takeover": {
        await this._handleTakeover(ctx, cmd);
        break;
      }
      case "list": {
        await this._handleList(ctx, cmd);
        break;
      }
      case "continue": {
        await this._handleContinue(ctx, cmd);
        break;
      }
      case "reset": {
        await this._handleReset(ctx);
        break;
      }
      case "status": {
        await this._handleStatus(ctx);
        break;
      }
      case "pin": {
        await this._handlePin(ctx, cmd);
        break;
      }
      case "alias": {
        await this._handleAlias(ctx, cmd);
        break;
      }
      case "watch": {
        await this._handleWatch(ctx, cmd);
        break;
      }
      case "unwatch": {
        await this._handleUnwatch(ctx);
        break;
      }
      case "mode": {
        await this._handleMode(ctx, cmd);
        break;
      }
      case "restart": {
        await this._handleRestart(ctx);
        break;
      }
      case "stop": {
        await this._handleStop(ctx);
        break;
      }
      case "model": {
        await this._handleModel(ctx, cmd);
        break;
      }
      case "compact": {
        await this._handleCompact(ctx);
        break;
      }
      case "history": {
        await this._handleHistory(ctx, cmd);
        break;
      }
      case "export": {
        await this._handleExport(ctx, cmd);
        break;
      }
      case "effort": {
        await this._handleEffort(ctx, cmd);
        break;
      }
      case "thinking": {
        await this._handleThinking(ctx, cmd);
        break;
      }
      case "prompt": {
        await this._handlePrompt(ctx, cmd);
        break;
      }
      case "usage":
      default: {
        await this.pusher.pushSectioned("命令", cmd.hint || HELP_TEXT);
        break;
      }
    }
  }

  /** 确保当前有默认项目（未指定则用配置的 workdir） */
  _ensureProject() {
    const cfg = this.cfg;
    let proj = this.registry.getProject(cfg.claude.workdir);
    if (!proj) {
      proj = this.registry.addProject(cfg.claude.workdir, encodeCwd(cfg.claude.workdir));
    }
    return proj;
  }

  /**
   * 自动识别 VSCode 最近会话并绑定为当前任务
   * 任务名用最近提示词（formatSessionName），比 vscode-<slug> 更友好
   * @param {object} proj
   * @returns {{name, sessionId, cwd}|null}
   */
  _bindDetected(proj) {
    const detected = detectActiveSession({
      sessionDir: this.cfg.claude.sessionDir,
      cwd: proj.cwd,
    });
    if (!detected) return null;
    // 补 lastPrompt：detectActiveSession 不返回，需经 listRecentSessions 获取
    const recent = listRecentSessions({
      sessionDir: this.cfg.claude.sessionDir,
      cwd: proj.cwd,
      limit: 0,
    });
    const info = recent.find((s) => s.sessionId === detected.sessionId) || {};
    const name = formatSessionName({
      slug: detected.slug,
      sessionId: detected.sessionId,
      lastPrompt: info.lastPrompt,
    });
    const projKey = encodeCwd(proj.cwd);
    this.registry.addTask(projKey, name, {
      sessionId: detected.sessionId,
      cwd: detected.cwd,
      slug: detected.slug,
    });
    this.registry.setCurrentTask(projKey, name);
    this.log.info("自动绑定 VSCode 会话", { name, sessionId: detected.sessionId });
    return { name, sessionId: detected.sessionId, cwd: detected.cwd };
  }

  async _handleProject(ctx, cmd) {
    let proj = this.registry.getProject(cmd.selector);
    if (!proj) {
      // 尝试当作路径处理
      const p = this.registry.getProject(cmd.selector);
      if (!p) {
        return this.pusher.pushSectioned(
          "项目",
          `未找到项目「${cmd.selector}」。可用 /会话列表 查看，或 /项目 <完整路径> 添加。`
        );
      }
    }
    // 保存到当前会话的"默认项目"：用 workdir 键
    const cfg = this.cfg;
    const key = encodeCwd(proj.cwd);
    const defaultProj = this.registry.getProject(cfg.claude.workdir);
    // 简化：直接记住选择的项目 key 在内存，并用 registry 记录
    this.registry.addProject(proj.cwd, proj.name); // 确保存在
    // 记录当前项目为默认
    const all = this.registry.listProjects();
    const projKey = encodeCwd(proj.cwd);
    const me = this.registry.getProject(cfg.claude.workdir);
    this._currentProjectKey = projKey;
    const tasks = this.registry.listTasks(projKey);
    const cur = this.registry.getCurrentTask(projKey);
    const lines = [
      `已切换到项目「${proj.name}」`,
      `路径: ${proj.cwd}`,
      `会话数: ${tasks.length}`,
      cur ? `当前任务: ${cur.name}` : "当前无任务",
      "",
      "发送 /新开 <任务名> 开始新任务，或 /会话列表 查看。",
    ];
    await this.pusher.pushSectioned("项目", lines.join("\n"));
  }

  async _handleNew(ctx, cmd) {
    const proj = this._ensureProject();
    const projKey = encodeCwd(proj.cwd);
    const sessionId = crypto.randomUUID();
    const task = { sessionId, cwd: proj.cwd };
    this.registry.addTask(projKey, cmd.taskName, task);
    this.registry.setCurrentTask(projKey, cmd.taskName);
    this.log.info("新开任务", { taskName: cmd.taskName, sessionId });

    if (cmd.prompt) {
      this.enqueue({
        taskName: cmd.taskName,
        sessionId,
        cwd: proj.cwd,
        prompt: cmd.prompt,
        isNew: true,
      });
    } else {
      await this.pusher.pushSectioned(
        cmd.taskName,
        `已新开任务「${cmd.taskName}」\n发送任意消息即可开始。`
      );
    }
  }

  async _handleTakeover(ctx, cmd) {
    const proj = this._ensureProject();
    const projKey = encodeCwd(proj.cwd);
    // 列出 VSCode 最近会话，按编号接管
    const recent = listRecentSessions({
      sessionDir: this.cfg.claude.sessionDir,
      cwd: proj.cwd,
      limit: 20,
    });
    if (!recent.length) {
      return this.pusher.pushSectioned("接管", "未找到 VSCode 会话。");
    }
    let idx;
    if (/^\d+$/.test(cmd.selector)) {
      idx = parseInt(cmd.selector, 10) - 1;
    } else {
      // 按 slug 名称匹配
      idx = recent.findIndex((s) => s.slug === cmd.selector);
    }
    if (idx < 0 || idx >= recent.length) {
      return this.pusher.pushSectioned(
        "接管",
        `编号无效（1-${recent.length}）。用 /会话列表 查看。`
      );
    }
    const target = recent[idx];
    // 用最近提示词作为任务名（更友好），无则用 slug
    const displayName = formatSessionName(target);
    const name = "vscode-" + (target.slug || target.sessionId.slice(0, 8));
    // 绑定到注册表（任务名用友好名）
    this.registry.addTask(projKey, displayName, {
      sessionId: target.sessionId,
      cwd: proj.cwd,
      slug: target.slug,
    });
    this.registry.setCurrentTask(projKey, displayName);
    this.log.info("接管 VSCode 会话", { name: displayName, sessionId: target.sessionId });

    // 读取会话历史，让用户先了解上下文
    const history = readSessionHistory({
      sessionDir: this.cfg.claude.sessionDir,
      cwd: proj.cwd,
      sessionId: target.sessionId,
      limit: 8,
    });
    const lines = [`已接管会话「${displayName}」，以下是最近的对话：`, ""];
    if (history.length) {
      history.forEach((m) => {
        const who = m.role === "user" ? "你" : "Claude";
        const text = m.text.length > 120 ? m.text.slice(0, 120) + "…" : m.text;
        lines.push(`【${who}】${text}`);
        lines.push("");
      });
    } else {
      lines.push("（该会话暂无可见历史消息）");
    }
    lines.push("—— 回复 /继续 <提示词> 或直接发消息接着干。");
    await this.pusher.pushSectioned(displayName, lines.join("\n"));
  }

  /**
   * 解析 /历史、/导出 的目标会话
   * 无 selector → 当前任务；否则按任务名/编号（先绑定任务，后 VSCode 会话）
   */
  _resolveSession(projKey, cwd, selector) {
    if (!selector) {
      const cur = this.registry.getCurrentTask(projKey);
      return cur ? { sessionId: cur.sessionId, cwd: cur.cwd || cwd } : null;
    }
    // 先找绑定任务
    const task = this.registry.findTask(projKey, selector);
    if (task) return { sessionId: task.sessionId, cwd: task.cwd || cwd, name: task.name };
    // 再按 VSCode 会话编号（listRecentSessions 的第 N 个）
    if (/^\d+$/.test(selector)) {
      const recent = listRecentSessions({
        sessionDir: this.cfg.claude.sessionDir,
        cwd,
        limit: 20,
      });
      const idx = parseInt(selector, 10) - 1;
      if (recent[idx]) {
        return { sessionId: recent[idx].sessionId, cwd, name: formatSessionName(recent[idx]) };
      }
    }
    return null;
  }

  /**
   * /历史 [编号|任务名]：查看会话最近对话（不接管、不执行）
   */
  async _handleHistory(ctx, cmd) {
    const proj = this._ensureProject();
    const projKey = encodeCwd(proj.cwd);
    const session = this._resolveSession(projKey, proj.cwd, cmd.selector);
    if (!session) {
      return this.pusher.sendNotification("⚠️ 未找到会话。用 /会话列表 查看编号，或 /历史 <任务名>。");
    }
    const history = readSessionHistory({
      sessionDir: this.cfg.claude.sessionDir,
      cwd: session.cwd,
      sessionId: session.sessionId,
      limit: 15,
    });
    if (!history.length) {
      return this.pusher.sendNotification("📋 该会话暂无可见历史。");
    }
    const lines = [
      `📋 会话历史（${session.name || session.sessionId.slice(0, 8)}）：`,
      "",
    ];
    history.forEach((m) => {
      const who = m.role === "user" ? "🧑 你" : "🤖 Claude";
      const text = m.text.length > 150 ? m.text.slice(0, 150) + "…" : m.text;
      lines.push(`【${who}】${text}`);
      lines.push("");
    });
    lines.push("发 /接管 <编号> 接管，或 /继续 接着聊。");
    await this.pusher.sendNotification(lines.join("\n"));
  }

  /**
   * /导出 [编号|任务名]：导出会话全部对话为 markdown 文件
   */
  async _handleExport(ctx, cmd) {
    const proj = this._ensureProject();
    const projKey = encodeCwd(proj.cwd);
    const session = this._resolveSession(projKey, proj.cwd, cmd.selector);
    if (!session) {
      return this.pusher.sendNotification("⚠️ 未找到会话。用 /会话列表 查看编号，或 /导出 <任务名>。");
    }
    const history = readSessionHistory({
      sessionDir: this.cfg.claude.sessionDir,
      cwd: session.cwd,
      sessionId: session.sessionId,
      limit: 0, // 全部
    });
    if (!history.length) {
      return this.pusher.sendNotification("📋 该会话暂无可见消息。");
    }
    const md = [
      `# 会话导出（${session.name || session.sessionId}）`,
      `- 会话ID: ${session.sessionId}`,
      `- 消息数: ${history.length}`,
      `- 导出时间: ${new Date().toISOString()}`,
      "",
    ];
    history.forEach((m, i) => {
      md.push(`## ${i + 1}. ${m.role === "user" ? "用户" : "Claude"}`);
      md.push("");
      md.push(m.text);
      md.push("");
    });
    try {
      const dir = path.join(path.dirname(this.cfg.registry.file), "exports");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${session.sessionId.slice(0, 8)}.md`);
      fs.writeFileSync(file, md.join("\n"), "utf8");
      await this.pusher.sendNotification(
        `📄 已导出 ${history.length} 条消息到:\n${file}`
      );
    } catch (e) {
      this.log.error("导出失败", { err: e.message });
      await this.pusher.sendNotification("❌ 导出失败: " + e.message);
    }
  }

  async _handleSwitch(ctx, cmd) {
    const proj = this._ensureProject();
    const projKey = encodeCwd(proj.cwd);
    const task = this.registry.findTask(projKey, cmd.selector);
    if (!task) {
      return this.pusher.pushSectioned(
        "切换",
        `未找到任务「${cmd.selector}」。用 /会话列表 查看当前项目任务。`
      );
    }
    this.registry.setCurrentTask(projKey, task.name);
    const displayName = task.alias || task.name;
    await this.pusher.pushSectioned(
      "切换",
      `已切换到「${displayName}」\n发送 /继续 <提示词> 或直接发消息继续。`
    );
  }

  async _handleList(ctx, cmd) {
    const page = cmd && cmd.page ? cmd.page : "1";
    const PAGE_SIZE = 20;
    const projects = this.registry.listProjects();

    // 获取某个项目下的"绑定任务 + VSCode 会话"完整列表
    const buildEntries = (cwd) => {
      const key = encodeCwd(cwd);
      const tasks = this.registry.listTasks(key);
      const cur = this.registry.getCurrentTask(key);
      const boundIds = new Set(tasks.map((t) => t.sessionId));
      // 所有 VSCode 会话（含已绑定的，但已绑定显示为任务名），建 sessionId → 信息索引
      const all = listRecentSessions({ sessionDir: this.cfg.claude.sessionDir, cwd, limit: 0 });
      const byId = new Map(all.map((s) => [s.sessionId, s]));
      // 标记每个 VSCode 会话是否已被绑定
      const entries = [];
      tasks.forEach((t) => {
        const info = byId.get(t.sessionId);
        entries.push({
          name: t.name,
          alias: t.alias,
          pinned: !!t.pinned,
          mark: cur && cur.name === t.name,
          isBound: true,
          time: (t.lastActiveAt || "").slice(0, 16),
          lastPrompt: info ? info.lastPrompt : null,
        });
      });
      const unbound = all.filter((s) => !boundIds.has(s.sessionId));
      unbound.forEach((s) => {
        entries.push({ name: formatSessionName(s), alias: null, pinned: false, mark: false, isBound: false, time: null, lastPrompt: null });
      });
      return { key, cwd, entries, curName: cur ? cur.name : null };
    };

    const projectsData = projects.map((p) => buildEntries(p.cwd));

    if (!projectsData.length) {
      // 无绑定项目 → 只展示 VSCode 会话
      const all = listRecentSessions({ sessionDir: this.cfg.claude.sessionDir, cwd: this.cfg.claude.workdir, limit: 0 });
      if (!all.length) {
        return this.pusher.pushSectioned("会话列表", "暂无项目，用 /新开 <任务名> 开始。");
      }
      const total = all.length;
      const totalPages = Math.ceil(total / PAGE_SIZE);
      const showAll = page === "全部" || page === "all";
      const start = showAll ? 0 : (parseInt(page, 10) || 1 - 1) * PAGE_SIZE;
      const end = showAll ? total : Math.min(start + PAGE_SIZE, total);
      const slice = all.slice(start, end);
      const lines = [
        `当前暂无绑定项目，VSCode 里共有 ${total} 个会话：`,
        "",
        `📁 ${encodeCwd(this.cfg.claude.workdir)}`,
        `   路径: ${this.cfg.claude.workdir}`,
      ];
      slice.forEach((s, i) => {
        lines.push(`   ${start + i + 1}. ${formatSessionName(s)}`);
      });
      if (!showAll) {
        lines.push("", `第 ${start / PAGE_SIZE + 1}/${totalPages} 页。发 /会话列表 N 看更多，或 /会话列表 全部。`);
      }
      lines.push("", "回复 /接管 <编号> 接管某个会话继续干活。");
      return this.pusher.pushSectioned("会话列表", lines.join("\n"));
    }

    // 已有项目：合并显示每个项目的绑定任务 + VSCode 会话
    const lines = [];
    projectsData.forEach((pd) => {
      lines.push(`📁 ${encodeCwd(pd.cwd)}`);
      lines.push(`   路径: ${pd.cwd}`);
      if (pd.entries.length) {
        pd.entries.slice(0, 60).forEach((e, i) => {
          const star = e.pinned ? "⭐ " : "";
          const mark = e.mark ? " 👈当前" : "";
          // 显示名与 VSCode 侧边栏一致：alias 优先，其次最近提示词（lastPrompt），最后 fallback name
          let name;
          if (e.alias) {
            name = e.alias;
          } else if (e.lastPrompt) {
            const lp = e.lastPrompt.replace(/\s+/g, " ").trim();
            name = lp.length > 40 ? lp.slice(0, 40) + "…" : lp;
          } else {
            name = e.name;
          }
          let line = `   ${i + 1}. ${star}${name}${mark}`;
          if (e.time) line += ` (${e.time})`;
          lines.push(line);
        });
        if (pd.entries.length > 60) {
          lines.push(`   …共 ${pd.entries.length} 个，仅显示前 60。`);
        }
      } else {
        lines.push(`   无会话`);
      }
      lines.push("");
    });
    lines.push("回复 /接管 <编号> 接管 VSCode 会话，/新开 <任务名> 开新会话。");
    await this.pusher.pushSectioned("会话列表", lines.join("\n"));
  }

  async _handlePrompt(ctx, cmd) {
    const proj = this._ensureProject();
    const projKey = encodeCwd(proj.cwd);
    const cur = this.registry.getCurrentTask(projKey);
    if (!cur) {
      // 无当前任务 → 自动识别 VSCode 会话并绑定（relay 标记接力）
      const bound = this._bindDetected(proj);
      if (bound) {
        return this.enqueue({
          taskName: bound.name,
          sessionId: bound.sessionId,
          cwd: bound.cwd,
          prompt: cmd.prompt,
          relay: true,
        });
      }
      // 无可用会话 → 开新会话
      const sessionId = crypto.randomUUID();
      const taskName = "微信-" + sessionId.slice(0, 8);
      this.registry.addTask(projKey, taskName, { sessionId, cwd: proj.cwd });
      this.registry.setCurrentTask(projKey, taskName);
      this.log.info("开新会话处理消息", { taskName, sessionId });
      return this.enqueue({ taskName, sessionId, cwd: proj.cwd, prompt: cmd.prompt, isNew: true });
    }
    // 有当前任务 → 入队
    this.enqueue({
      taskName: cur.name,
      sessionId: cur.sessionId,
      cwd: cur.cwd,
      prompt: cmd.prompt,
    });
  }

  async _handleContinue(ctx, cmd) {    const proj = this._ensureProject();
    const projKey = encodeCwd(proj.cwd);
    const cur = this.registry.getCurrentTask(projKey);
    if (!cur) {
      // 无当前任务 → 尝试自动识别 VSCode 会话（relay 标记接力）
      const bound = this._bindDetected(proj);
      if (bound) {
        const prompt = cmd.prompt || "继续";
        return this.enqueue({
          taskName: bound.name,
          sessionId: bound.sessionId,
          cwd: bound.cwd,
          prompt,
          relay: true,
        });
      }
      return this.pusher.pushSectioned(
        "继续",
        "当前无任务。用 /新开 <任务名> 开新会话，或用 /切换 <任务名>。"
      );
    }
    const prompt = cmd.prompt || "继续";
    this.enqueue({ taskName: cur.name, sessionId: cur.sessionId, cwd: cur.cwd, prompt });
  }

  async _handleReset(ctx) {
    const proj = this._ensureProject();
    const projKey = encodeCwd(proj.cwd);
    const cur = this.registry.getCurrentTask(projKey);
    if (cur) {
      this.registry.removeTask(projKey, cur.name);
      await this.pusher.pushSectioned("重置", `已重置，清除了当前任务「${cur.name}」`);
    } else {
      await this.pusher.pushSectioned("重置", "当前无任务可重置");
    }
  }

  /**
   * 主动推送（兼容无 bot / mock pusher），失败静默
   * @param {string} text
   */
  _notify(text) {
    if (this.pusher && typeof this.pusher.sendNotification === "function") {
      this.pusher.sendNotification(text).catch(() => {});
    }
  }

  async _handleStatus(ctx) {
    const proj = this._ensureProject();
    const projKey = encodeCwd(proj.cwd);
    const cur = this.registry.getCurrentTask(projKey);
    const queueN = [...this.queues.values()].reduce((n, q) => n + q.length, 0);

    if (!cur) {
      const lines = [
        "当前无任务",
        queueN > 0 ? `队列中还有 ${queueN} 条消息待处理。` : "队列空闲。",
        "用 /新开 <任务名> 开新会话，或直接发消息。",
      ];
      return this.pusher.pushSectioned("状态", lines.join("\n"));
    }

    // 最后一句：从 listRecentSessions 的 lastPrompt 取
    let lastPrompt = null;
    try {
      const recent = listRecentSessions({
        sessionDir: this.cfg.claude.sessionDir,
        cwd: cur.cwd,
        limit: 0,
      });
      const info = recent.find((s) => s.sessionId === cur.sessionId);
      if (info) lastPrompt = info.lastPrompt;
    } catch {}

    // 显示名与 VSCode 侧边栏一致：alias 优先，其次 lastPrompt（最近提示词），最后 name
    let displayName;
    if (cur.alias) {
      displayName = cur.alias;
    } else if (lastPrompt) {
      const lp = lastPrompt.replace(/\s+/g, " ").trim();
      displayName = lp.length > 60 ? lp.slice(0, 60) + "…" : lp;
    } else {
      displayName = cur.name;
    }
    const lines = [`📄 任务: ${displayName}`];
    if (cur.lastActiveAt) lines.push(`   最近活跃: ${cur.lastActiveAt.slice(0, 16)}`);
    // 状态（支持多会话并行：列出所有正在执行的任务）
    if (this.activeJobs.size) {
      for (const [, aj] of this.activeJobs) {
        const secs = Math.round((Date.now() - aj.startedAt) / 1000);
        lines.push(`   执行中: 「${aj.taskName}」已耗时 ${secs}s`);
      }
      if (queueN > 0) lines.push(`   队列: 还有 ${queueN} 条等待`);
    } else if (queueN > 0) {
      lines.push(`   状态: 排队中，前面 ${queueN} 条`);
    } else {
      lines.push("   状态: 空闲（等待指令）");
    }
    lines.push("", "发送 /继续 <提示词> 或直接发消息继续。");
    await this.pusher.pushSectioned("状态", lines.join("\n"));
  }

  async _handlePin(ctx, cmd) {
    const proj = this._ensureProject();
    const projKey = encodeCwd(proj.cwd);
    const result = this.registry.togglePin(projKey, cmd.selector);
    if (result === null) {
      return this.pusher.pushSectioned("置顶", `未找到任务「${cmd.selector}」。用 /会话列表 查看。`);
    }
    const task = this.registry.findTask(projKey, cmd.selector);
    const displayName = task ? task.alias || task.name : cmd.selector;
    await this.pusher.pushSectioned(
      "置顶",
      result ? `已置顶「${displayName}」⭐` : `已取消置顶「${displayName}」`
    );
  }

  async _handleAlias(ctx, cmd) {
    const proj = this._ensureProject();
    const projKey = encodeCwd(proj.cwd);
    const ok = this.registry.setAlias(projKey, cmd.selector, cmd.alias);
    if (!ok) {
      return this.pusher.pushSectioned("别名", `未找到任务「${cmd.selector}」。用 /会话列表 查看。`);
    }
    await this.pusher.pushSectioned("别名", `已为任务设置别名「${cmd.alias}」`);
  }

  /**
   * 入队一条 claude 执行（按会话分组：同一会话串行，不同会话可并行）
   */
  enqueue(job) {
    const sid = job.sessionId;
    if (!this.queues.has(sid)) this.queues.set(sid, []);
    const q = this.queues.get(sid);
    q.push(job);
    // 同一会话已有任务在跑 → 排队提示
    if (this.running.has(sid) && q.length > 1) {
      this._notify(`[${job.taskName}] ⏳ 已入队，该会话前面还有 ${q.length - 1} 条任务。`);
    }
    this._drain();
    return job;
  }

  /**
   * 并发调度：每个 sessionId 一个串行队列，最多 MAX_CONCURRENT 个会话同时执行
   */
  _drain() {
    for (const [sid, q] of this.queues) {
      if (!this.running.has(sid) && q.length && this.running.size < this.MAX_CONCURRENT) {
        const job = q.shift();
        this.running.add(sid);
        this._run(job).finally(() => {
          this.running.delete(sid);
          this._drain();
        });
      }
    }
  }

  async _run(job) {
    const start = Date.now();
    // 状态追踪（/状态 命令用，支持多会话并行）
    this.activeJobName = job.taskName;
    this.activeStartedAt = start;
    this.activeJobs.set(job.sessionId, { taskName: job.taskName, startedAt: start });

    // 长任务心跳（默认关闭）：超过阈值后定期推送"仍在运行"，间隔递增（避免刷屏）
    // 通过 HEARTBEAT_ENABLED=1 开启。流式本身实时展示进展 + 空闲超时兜底，心跳通常不需要。
    let hbTimer = null;
    const hbCfg = this.cfg.pusher || {};
    if (hbCfg.heartbeatEnabled) {
      const hbStart = hbCfg.heartbeatStartMs || 60 * 1000;
      const hbInterval = hbCfg.heartbeatIntervalMs || 120 * 1000;
      const hbCap = hbCfg.heartbeatCapMs || 300 * 1000;
      let hbNext = hbStart;
      const scheduleHeartbeat = () => {
        const elapsed = Date.now() - start;
        if (elapsed < hbNext) {
          hbTimer = setTimeout(scheduleHeartbeat, hbNext - elapsed);
        } else {
          this._notify(`[${job.taskName}] ⏳ 仍在运行，已耗时 ${Math.round(elapsed / 1000)}s…`);
          hbNext = Math.min(Math.max(hbInterval, hbNext * 2), hbCap);
          hbTimer = setTimeout(scheduleHeartbeat, hbNext);
        }
      };
      hbTimer = setTimeout(scheduleHeartbeat, hbStart);
    }

    // 开启智能机器人流式会话（若 bot 可用），对话内容走打字机
    let streamStarted = false;
    if (this.pusher && typeof this.pusher.beginTask === "function") {
      streamStarted = this.pusher.beginTask(job.taskName, job.reqId);
    }

    // 开始处理提示：有流式则作为流式首片，否则走自建应用
    const remain = (this.queues.get(job.sessionId) || []).length;
    const startHint = `⏳ 开始处理，队列剩余 ${remain} 条…`;
    if (streamStarted && this.pusher.pushStyled) {
      await this.pusher.pushStyled(job.taskName, startHint, "plain");
    } else {
      await this.pusher.pushSectioned(job.taskName, startHint);
    }

    // 思考/工具事件去重（各推一次）
    let pushedThinking = false;

    try {
      const args = this._buildArgs(job);
      this.log.info("执行 claude", { taskName: job.taskName, args: args.join(" ") });

      // 类型化增量处理：思考/工具走流式分片（去重），回复仅累积不推送
      let replyBuf = "";
      let thinkingBuf = "";
      let thinkingTimer = null;
      const flushThinking = () => {
        if (thinkingTimer) {
          clearTimeout(thinkingTimer);
          thinkingTimer = null;
        }
        const t = thinkingBuf.trim();
        thinkingBuf = "";
        if (t) {
          this.pusher.pushStyled(job.taskName, t, "thinking").catch(() => {});
        }
      };
      const onPartial = ({ kind, text }) => {
        if (kind === "reply") {
          replyBuf += text;
        } else if (kind === "thinking") {
          if (this.thinkingEnabled) {
            // 展示思考内容：累积 + 节流推送（避免刷屏）
            thinkingBuf += text;
            if (thinkingBuf.length >= 200) flushThinking();
            else if (!thinkingTimer) {
              thinkingTimer = setTimeout(flushThinking, 1500);
            }
          } else if (!pushedThinking) {
            pushedThinking = true;
            this.pusher.pushStyled(job.taskName, "思考中…", "thinking").catch(() => {});
          }
        } else if (kind === "tool") {
          // 每个工具调用推一条（可能有多个工具）
          this.pusher.pushStyled(job.taskName, text, "tool").catch(() => {});
        }
      };

      const { code, stdout, stderr, error, result } = await this._spawn(args, job.cwd, onPartial, job.sessionId);

      // 被 /停止 中止（按会话独立判断，并行安全）：不推送结果，直接收尾
      if (this.aborting.has(job.sessionId)) {
        this.aborting.delete(job.sessionId);
        return;
      }

      // 最终结果：优先用流式累积的回复文本；若无则回退解析
      let finalResult =
        (replyBuf && replyBuf.trim()) || result || this._extractResult(stdout, stderr, code, error);
      finalResult = this._dedupTail(finalResult);

      if (finalResult) {
        await this.pusher.pushStyled(job.taskName, finalResult, "reply", Date.now() - start);
      } else if (error || code !== 0) {
        const errText = "❌ 进程异常: " + (error ? error.message : "退出码 " + code);
        await this.pusher.pushSectioned(job.taskName, errText);
      }
      // 长任务完成总结（> 阈值，成功且有结果）
      const completeMs = (this.cfg.pusher && this.cfg.pusher.completeNotifyMs) || 60 * 1000;
      if (Date.now() - start > completeMs && finalResult) {
        this._notify(`[${job.taskName}] ✅ 完成，总耗时 ${Math.round((Date.now() - start) / 1000)}s。`);
      }
    } catch (e) {
      this.log.error("claude 执行异常", { err: e.message });
      await this.pusher.pushSectioned(job.taskName, "❌ 执行失败: " + e.message);
    } finally {
      if (hbTimer) clearTimeout(hbTimer);
      hbTimer = null;
      // flush 剩余思考内容（/thinking on 时）
      if (this.thinkingEnabled && typeof flushThinking === "function") {
        flushThinking();
      }
      this.activeJobs.delete(job.sessionId);
      this.activeJobName = this.activeJobs.size
        ? [...this.activeJobs.values()][0].taskName
        : null;
      this.activeStartedAt = this.activeJobs.size
        ? [...this.activeJobs.values()][0].startedAt
        : null;
      // 结束流式会话（未 finish 则用最终结果定型）
      if (this.pusher && typeof this.pusher.endTask === "function") {
        await this.pusher.endTask(job.taskName);
      }
      this.registry.touchTask(encodeCwd(job.cwd), job.taskName);
      // 任务完成后自动触发 VSCode 深链打开该会话（jsonl 已落盘，VSCode 从磁盘加载最新内容）
      if (this.cfg.claude && this.cfg.claude.vscodeAutoOpen && job.sessionId) {
        this._openInVscode(job.sessionId);
      }
    }
  }

  /**
   * 通过 vscode:// 深链让 VSCode 打开/聚焦某会话（从磁盘加载全部内容）
   * 实现"微信操作一轮后，VSCode 面板自动显示最新结果"（整轮级近实时）
   */
  _openInVscode(sessionId) {
    try {
      const url = `vscode://anthropic.claude-code/open?session=${sessionId}`;
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
      this.log.info("已触发 VSCode 打开会话", { sessionId: sessionId.slice(0, 8) });
    } catch (e) {
      this.log.error("VSCode 深链触发失败", { err: e.message });
    }
  }

  /**
   * 回复去重兜底：检测文本中"相邻重复的段"（模型/上下文偶发把内容复述多次），保留一份。
   * 先做整段相邻去重，再兜底末尾小段重复。
   */
  _dedupTail(text) {
    if (!text || text.length < 20) return text;

    // 1) 相邻重复段去重：任意位置找到"连续相同的一块"，删掉重复份，循环直到稳定
    let out = text;
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 10) {
      changed = false;
      // 块长从大到小，优先去重长段（避免小窗口切坏内容）
      const maxLen = Math.min(Math.floor(out.length / 2), 1500);
      for (let len = maxLen; len >= 30; len--) {
        let i = 0;
        while (i + 2 * len <= out.length) {
          const block = out.slice(i, i + len);
          if (out.startsWith(block, i + len)) {
            out = out.slice(0, i + len) + out.slice(i + 2 * len);
            changed = true;
            break;
          }
          i++;
        }
        if (changed) break;
      }
    }
    if (out !== text) return out;

    // 2) 末尾小段重复兜底（原有逻辑）
    const maxLen2 = Math.floor(text.length / 2);
    for (let len = Math.min(maxLen2, 200); len >= 20; len--) {
      const tail = text.slice(text.length - len);
      const pos = text.indexOf(tail);
      if (pos !== -1 && pos < text.length - len) {
        return text.slice(0, pos + len);
      }
    }
    return text;
  }

  /**
   * 将工具调用格式化为可读摘要（供微信展示）
   * @param {string} name 工具名
   * @param {object} input 工具输入参数
   * @returns {string}
   */
  _formatToolCall(name, input) {
    const truncate = (s, n = 60) => {
      const str = String(s ?? "");
      return str.length > n ? str.slice(0, n) + "…" : str;
    };
    switch (name) {
      case "Bash":
        return `Bash 执行: ${truncate(input.command || "")}`;
      case "Write":
      case "Edit":
        return `${name}: ${truncate(input.file_path || input.filePath || "")}`;
      case "Read":
        return `读取: ${truncate(input.file_path || input.filePath || "")}`;
      case "Glob":
      case "Grep":
        return `${name}: ${truncate(input.pattern || input.query || "")}`;
      case "WebFetch":
        return `抓取: ${truncate(input.url || "")}`;
      case "WebSearch":
        return `搜索: ${truncate(input.query || "")}`;
      case "Agent":
        return `子代理: ${truncate(input.description || input.prompt || "")}`;
      default:
        // 其他工具：显示首条输入字段
        const firstKey = Object.keys(input)[0];
        return firstKey ? `${name}: ${truncate(input[firstKey])}` : `调用工具: ${name}`;
    }
  }

  _buildArgs(job) {
    const cfg = this.cfg.claude;
    // 流式模式：stream-json + include-partial-messages，实时接收增量文本
    // 注意：-p 下 stream-json 必须配合 --verbose，否则 claude 拒绝运行
    const base = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      this.permissionMode || cfg.permissionMode,
    ];
    // 权限确认工具（P5 阶段启用）
    if (cfg.permissionPromptTool) {
      base.push("--permission-prompt-tool", cfg.permissionPromptTool);
    }
    // "总是允许"的工具列表（授权时用户选择"总是允许 <工具>"）
    const allowed = this._loadAllowedTools();
    if (allowed.length) {
      base.push("--allowedTools", allowed.join(" "));
    }
    // /model 切换模型（未设置则用默认）
    if (this.model) {
      base.push("--model", this.model);
    }
    // /effort 切换推理努力程度（未设置则用默认）
    if (this.effort) {
      base.push("--effort", this.effort);
    }
    if (job.isNew) {
      return [...base, "--session-id", job.sessionId, "--name", job.taskName, job.prompt];
    }
    // 会话文件不存在（如 /新开 只注册未创建）→ 自动转为创建新会话
    const sessFile = path.join(
      this.cfg.claude.sessionDir,
      encodeCwd(job.cwd || this.cfg.claude.workdir),
      job.sessionId + ".jsonl"
    );
    if (!fs.existsSync(sessFile)) {
      this.log.info("会话文件不存在，自动创建新会话", { sessionId: job.sessionId.slice(0, 8) });
      return [...base, "--session-id", job.sessionId, "--name", job.taskName, job.prompt];
    }
    const args = [...base, "--resume", job.sessionId];
    // 接力：微信第一次接手 VSCode 会话时注入"继续而非重来"的语义引导
    if (job.relay) {
      const relayHint =
        "注意：你是用户通过企业微信从远端接管此会话。" +
        "此会话此前已在 VSCode 中处理过。请先回顾当前进度，" +
        "然后执行用户新指令，不要从头开始或重复已完成的工作。";
      args.push("--append-system-prompt", relayHint);
    }
    args.push(job.prompt);
    return args;
  }

  _spawn(args, cwd, onPartial, sessionId) {
    return new Promise((resolve) => {
      const bin = this.cfg.claude.bin;
      // claude 在 Windows 上需要 git-bash；子进程需继承该环境变量
      // 同时注入 settings 里的 ANTHROPIC_* env（模型别名映射等，与 VSCode 一致）
      const env = {
        ...process.env,
        ...this._loadSettingsEnv(),
        CLAUDE_CODE_GIT_BASH_PATH: this.cfg.claude.gitBashPath,
      };
      const child = spawn(bin, args, {
        cwd: cwd || this.cfg.claude.workdir,
        env,
        shell: false,
        windowsHide: true,
      });
      if (sessionId) this.actives.set(sessionId, child);
      let out = "",
        err = "",
        lastAt = Date.now(),
        lineBuf = "";
      let finalResult = null;

      // 逐行解析 NDJSON 流（stream-json）
      // tool_use 的 input 通过 input_json_delta 流式累积，start 时为空
      let curTool = null; // { name, buf }
      const processLine = (line) => {
        const l = line.trim();
        if (!l) return;
        try {
          const r = JSON.parse(l);
          if (r.type === "stream_event") {
            const ev = r.event || {};
            if (ev.type === "content_block_delta" && ev.delta) {
              // 文本增量（最终回复）
              if (ev.delta.type === "text_delta" && ev.delta.text) {
                if (onPartial) onPartial({ kind: "reply", text: ev.delta.text });
              }
              // 思考增量（推理过程）
              if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
                if (onPartial) onPartial({ kind: "thinking", text: ev.delta.thinking });
              }
              // 工具输入增量（累积 JSON）
              if (ev.delta.type === "input_json_delta" && curTool) {
                curTool.buf += ev.delta.partial_json || "";
              }
            }
            if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "tool_use") {
              curTool = { name: ev.content_block.name || "tool", buf: "" };
            }
            if (ev.type === "content_block_stop" && curTool) {
              // 工具输入完整，解析并格式化
              let input = {};
              try {
                input = curTool.buf ? JSON.parse(curTool.buf) : {};
              } catch {
                input = {};
              }
              const detail = this._formatToolCall(curTool.name, input);
              if (onPartial) onPartial({ kind: "tool", text: detail, toolName: curTool.name });
              curTool = null;
            }
          } else if (r.type === "assistant") {
            // 兼容：整段 assistant 消息（非流式场景）
            const content = r.message && r.message.content;
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c && c.type === "text" && c.text) {
                  if (onPartial) onPartial({ kind: "reply", text: c.text });
                }
              }
            }
          } else if (r.type === "result") {
            if (r.is_error) {
              // 错误详情在 errors 数组（result 常为空）
              const errMsg = (r.errors && r.errors[0]) || r.result || "未知错误";
              finalResult = "❌ " + errMsg;
              err = (err || "") + errMsg;
            } else {
              finalResult = r.result;
            }
          }
        } catch {}
      };

      child.stdout.on("data", (d) => {
        out += d;
        lastAt = Date.now();
        // 按行切分（NDJSON 每行一个 JSON）
        lineBuf += d;
        let idx;
        while ((idx = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          processLine(line);
        }
      });
      child.stderr.on("data", (d) => {
        err += d;
        lastAt = Date.now();
      });

      // 空闲看门狗：无输出超时则强杀
      const idleMs = this.cfg.claude.idleTimeoutMs;
      const idle = setInterval(() => {
        if (idleMs && Date.now() - lastAt > idleMs) {
          this.log.warn("空闲超时，强杀进程", { pid: child.pid });
          this._killTree(child.pid);
        }
      }, 30000);

      // 总超时
      const totalMs = this.cfg.claude.totalTimeoutMs;
      const total = totalMs
        ? setTimeout(() => {
            this.log.warn("总超时，强杀进程", { pid: child.pid });
            this._killTree(child.pid);
          }, totalMs)
        : null;

      const finish = (code, error) => {
        clearInterval(idle);
        if (total) clearTimeout(total);
        if (sessionId) this.actives.delete(sessionId);
        resolve({ code, stdout: out, stderr: err, error, result: finalResult });
      };

      child.on("close", (code) => finish(code, null));
      child.on("error", (e) => finish(-1, e));
    });
  }

  _killTree(pid) {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* 进程可能已退出 */
    }
  }

  _extractResult(stdout, stderr, code, error) {
    if (error) return "❌ 启动失败: " + error.message;
    // --output-format json 输出：最后一行是 {type:"result",...}
    const lines = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (r.type === "result") {
          if (r.is_error) return "❌ " + (r.result || stderr.slice(-500));
          return r.result;
        }
      } catch {
        /* 非JSON行跳过 */
      }
    }
    if (code !== 0) {
      return "❌ 进程退出码 " + code + "\n" + (stderr || "").slice(-500);
    }
    return stdout.slice(-4000);
  }

  /**
   * /盯 <编号>：实时监控某会话在 VSCode 的进展（tail jsonl 增量 → 推微信）
   * 适用于 VSCode 里正在跑的 claude（实时旁观，无法控制/授权）
   */
  async _handleWatch(ctx, cmd) {
    const proj = this._ensureProject();
    const cwd = proj ? proj.cwd : this.cfg.claude.workdir;
    const sessions = listRecentSessions({ sessionDir: this.cfg.claude.sessionDir, cwd, limit: 0 });

    let session = null;
    if (cmd.selector) {
      const n = parseInt(cmd.selector, 10);
      if (!isNaN(n) && n >= 1 && n <= sessions.length) {
        session = sessions[n - 1];
      } else {
        return this.pusher.sendNotification(`⚠️ 编号 ${cmd.selector} 无效。用 /会话列表 查看编号。`);
      }
    } else {
      // 无参数 → 盯当前任务会话
      const key = encodeCwd(cwd);
      const cur = this.registry.getCurrentTask(key);
      if (cur) session = { sessionId: cur.sessionId, cwd: cur.cwd };
    }
    if (!session) {
      return this.pusher.sendNotification("📡 未找到要盯的会话。用法: /盯 <编号>，或用 /会话列表 查看编号。");
    }
    this._startWatch(session, cwd);
  }

  _startWatch(session, cwd) {
    this._stopWatch();
    const filePath = path.join(
      this.cfg.claude.sessionDir,
      encodeCwd(cwd),
      session.sessionId + ".jsonl"
    );
    if (!fs.existsSync(filePath)) {
      return this.pusher.sendNotification("📡 会话文件不存在: " + filePath);
    }
    let offset = 0;
    try {
      offset = fs.statSync(filePath).size;
    } catch {}
    let idle = 0;
    const seen = new Set();

    const name = formatSessionName(session);
    this.pusher.sendNotification(
      `📡 开始盯会话「${name.slice(0, 30)}」，实时推送 VSCode 侧进展。发 /不盯 停止。`
    );

    const timer = setInterval(async () => {
      try {
        const size = fs.statSync(filePath).size;
        if (size > offset) {
          const buf = Buffer.alloc(size - offset);
          const fd = fs.openSync(filePath, "r");
          fs.readSync(fd, buf, 0, size - offset, offset);
          fs.closeSync(fd);
          offset = size;
          idle = 0;
          const lines = buf.toString("utf8").split("\n").filter(Boolean);
          for (const line of lines) {
            const ev = this._parseWatchEvent(line);
            if (!ev) continue;
            const sig = ev.role + ":" + ev.text.slice(0, 40);
            if (seen.has(sig)) continue;
            seen.add(sig);
            try {
              await this.pusher.sendNotification(ev.text, "markdown");
            } catch (e) {
              this.log.error("盯推送失败", { err: e.message });
            }
          }
        } else {
          idle++;
          // 90s 无更新才停止（1.5s × 60）——思考间隙/等授权可能超 15s，别过早结束
          if (idle >= 60) {
            this._stopWatch();
            this.pusher.sendNotification("📡 会话已安静 90 秒（可能已结束），监控停止。发 /盯 <编号> 可继续盯。");
          }
        }
      } catch (e) {
        this.log.error("盯监控异常", { err: e.message });
        this._stopWatch();
        this.pusher.sendNotification("📡 监控异常，已停止。");
      }
    }, 1500);

    this.watchInfo = { timer, filePath, sessionId: session.sessionId };
    this.log.info("开始盯会话", {
      sessionId: session.sessionId.slice(0, 8),
      filePath,
    });
  }

  _stopWatch() {
    if (this.watchInfo && this.watchInfo.timer) {
      clearInterval(this.watchInfo.timer);
      this.watchInfo = null;
      return true;
    }
    return false;
  }

  async _handleUnwatch(ctx) {
    const stopped = this._stopWatch();
    await this.pusher.sendNotification(
      stopped ? "📡 已停止监控。" : "📡 当前没有进行中的监控。"
    );
  }

  /**
   * /模式 <default|accept|bypass|plan>：切换 claude 进程的权限模式
   * 与 VSCode 里的权限模式一致，让微信远程操作时授权体验更灵活。
   */
  async _handleMode(ctx, cmd) {
    const MODES = {
      default: "default",
      accept: "acceptEdits",
      acceptedits: "acceptEdits",
      bypass: "bypassPermissions",
      bypasspermissions: "bypassPermissions",
      plan: "plan",
    };
    const mode = MODES[cmd.mode];
    if (!mode) {
      return this.pusher.sendNotification(
        "⚠️ 无效模式。支持: /模式 default（每次确认）、/模式 accept（自动接受编辑）、/模式 bypass（全程免确认）、/模式 plan（只读规划）"
      );
    }
    this.permissionMode = mode;
    const desc = {
      default: "每次工具调用需确认",
      acceptEdits: "自动接受文件编辑，其他仍需确认",
      bypassPermissions: "全程免确认（高风险）",
      plan: "只读规划，不执行",
    };
    await this.pusher.sendNotification(`✅ 已切换权限模式为「${mode}」：${desc[mode]}`);
    this.log.info("切换权限模式", { mode });
  }

  /**
   * /重启：重启桥接服务。
   * 关键：由桥接自身处理（detached 拉起新进程后退出自己），
   * 绝不经 claude 执行命令——否则 taskkill 会杀掉桥接宿主，导致输出通道中断。
   */
  async _handleRestart(ctx) {
    await this.pusher.sendNotification("🔄 正在重启桥接服务，约 3 秒后恢复…");
    this.log.info("收到 /重启 指令，执行安全重启");
    try {
      const entry = path.join(__dirname, "index.js");
      const child = spawn(process.execPath, [entry], {
        detached: true,
        stdio: "ignore",
        cwd: path.join(__dirname, ".."),
      });
      child.unref();
    } catch (e) {
      this.log.error("重启拉起失败", { err: e.message });
      return this.pusher.sendNotification("❌ 重启失败: " + e.message);
    }
    // 给新进程 1.5s 拉起时间，然后退出当前进程释放 8787 端口
    setTimeout(() => process.exit(0), 1500);
  }

  /**
   * /停止：中止正在执行的任务并清空待处理队列。
   * 并行安全：记录待中止的 sessionId，_run 各自判断。
   */
  async _handleStop(ctx) {
    // 记录所有正在执行的会话为待中止
    this.aborting = new Set(this.actives.keys());
    // 清空所有会话队列
    let queueN = 0;
    for (const q of this.queues.values()) queueN += q.length;
    this.queues.clear();
    // 杀掉所有正在执行的 claude 进程
    let killed = 0;
    for (const [sid, child] of this.actives) {
      try {
        this._killTree(child.pid);
        killed++;
        this.log.info("已杀掉 claude 进程", { sessionId: sid, pid: child.pid });
      } catch (e) {
        this.log.error("杀进程失败", { err: e.message });
      }
    }
    this.actives.clear();
    this.running.clear();
    this.activeJobs.clear();
    // 结束当前流式（用"已中止"定型）
    if (this.pusher && typeof this.pusher.endTask === "function") {
      await this.pusher.endTask(null, "⏹ 已中止", false);
    }
    this.activeJobName = null;
    this.activeStartedAt = null;
    const parts = [];
    if (killed) parts.push(`已中止 ${killed} 个正在执行的任务`);
    if (queueN) parts.push(`清空 ${queueN} 条排队消息`);
    await this.pusher.sendNotification(
      parts.length ? "⏹ " + parts.join("，") + "。" : "⏹ 当前无任务在执行。"
    );
    this.log.info("中止任务", { killed, queueN });
  }

  /**
   * /model [模型ID]：查看或切换模型（下一条消息生效）
   */
  async _handleModel(ctx, cmd) {
    if (!cmd.model) {
      const env = this._loadSettingsEnv();
      const def = env.ANTHROPIC_MODEL || this._defaultModel();
      const opt = (label, v) => `  ${label} → ${v}`;
      const lines = [
        `当前模型: ${this.model || def}`,
        "",
        "可选模型（与 VSCode /model 一致）：",
        opt("Default", def),
        opt("Opus", env.ANTHROPIC_DEFAULT_OPUS_MODEL || def),
        opt("Sonnet", env.ANTHROPIC_DEFAULT_SONNET_MODEL || def),
        opt("Haiku", env.ANTHROPIC_DEFAULT_HAIKU_MODEL || def),
        "",
        "切换: /model <default|opus|sonnet|haiku|完整ID>",
      ];
      return this.pusher.sendNotification(lines.join("\n"));
    }
    this.model = cmd.model.trim();
    await this.pusher.sendNotification(`✅ 已切换模型为「${this.model}」，下一条消息生效。`);
    this.log.info("切换模型", { model: this.model });
  }

  /**
   * 读取 Claude 配置里的 env（~/.claude/settings.json + 项目级 settings）
   * 包含 ANTHROPIC_MODEL、ANTHROPIC_DEFAULT_*_MODEL 等模型别名映射，
   * 用于与 VSCode 的 /model 列表保持一致，并注入 claude 子进程。
   */
  _loadSettingsEnv() {
    const merged = {};
    const files = [
      path.join(process.env.USERPROFILE || "", ".claude", "settings.json"),
      path.join(this.cfg.claude.workdir, ".claude", "settings.json"),
      path.join(this.cfg.claude.workdir, ".claude", "settings.local.json"),
    ];
    for (const f of files) {
      try {
        if (!fs.existsSync(f)) continue;
        const d = JSON.parse(fs.readFileSync(f, "utf8"));
        if (d.env) Object.assign(merged, d.env);
      } catch {}
    }
    return merged;
  }

  /**
   * 读取实际使用的默认模型：优先 VSCode settings 的 claudeCode.selectedModel，
   * 其次 ~/.claude/settings.json 的 model，最后 fallback 已知值。
   */
  _defaultModel() {
    const candidates = [];
    // settings.json 的 model 字段（CLI 实际生效，VSCode /model 切换写入处）优先
    try {
      const us = JSON.parse(
        fs.readFileSync(path.join(process.env.USERPROFILE || "", ".claude", "settings.json"), "utf8")
      );
      if (us.model) candidates.push(us.model);
    } catch {}
    try {
      const vs = JSON.parse(
        fs.readFileSync(
          path.join(process.env.APPDATA || "", "Code", "User", "settings.json"),
          "utf8"
        )
      );
      if (vs.claudeCode && vs.claudeCode.selectedModel) {
        candidates.push(vs.claudeCode.selectedModel);
      }
    } catch {}
    if (candidates.length) return candidates[0];
    return "deepseek-v4-flash[1m]";
  }

  /**
   * /effort <low|medium|high|max>：切换推理努力程度（下一条消息生效）
   */
  async _handleEffort(ctx, cmd) {
    const levels = ["low", "medium", "high", "max"];
    if (!levels.includes(cmd.level)) {
      return this.pusher.sendNotification("⚠️ 无效级别。支持: /effort low|medium|high|max");
    }
    this.effort = cmd.level;
    await this.pusher.sendNotification(
      `✅ 已切换推理努力程度为「${cmd.level}」，下一条消息生效。`
    );
    this.log.info("切换 effort", { level: cmd.level });
  }

  /**
   * /thinking <on|off>：控制思考内容是否展示
   * on → 流式推送完整思考内容（节流防刷屏）；off → 只显示"思考中…"
   */
  async _handleThinking(ctx, cmd) {
    if (cmd.on === "on" || cmd.on === "1" || cmd.on === "true") {
      this.thinkingEnabled = true;
      await this.pusher.sendNotification(
        "✅ 已开启思考内容展示——后续回复会实时推送推理过程（节流防刷屏）。"
      );
    } else if (cmd.on === "off" || cmd.on === "0" || cmd.on === "false") {
      this.thinkingEnabled = false;
      await this.pusher.sendNotification("✅ 已关闭思考内容展示（只显示「思考中…」）。");
    } else {
      await this.pusher.sendNotification(
        `当前思考展示: ${this.thinkingEnabled ? "开启" : "关闭（只显示「思考中…」）"}\n用法: /thinking on|off`
      );
    }
    this.log.info("切换 thinking 展示", { enabled: this.thinkingEnabled });
  }

  /**
   * /compact：压缩当前会话上下文——读取最近对话历史，生成摘要并展示，
   * 提示用 /新开 带摘要继续（旧会话保留）。
   */
  async _handleCompact(ctx) {
    const proj = this._ensureProject();
    const key = encodeCwd(proj.cwd);
    const cur = this.registry.getCurrentTask(key);
    if (!cur) {
      return this.pusher.sendNotification("📋 当前无任务可压缩。");
    }
    const history = readSessionHistory({
      sessionDir: this.cfg.claude.sessionDir,
      cwd: cur.cwd,
      sessionId: cur.sessionId,
      limit: 30,
    });
    if (!history.length) {
      return this.pusher.sendNotification("📋 会话历史为空，无需压缩。");
    }
    await this.pusher.sendNotification("📋 正在压缩上下文，生成会话摘要…");
    const summary = await this._summarize(history, cur.cwd);
    if (!summary || summary.startsWith("❌")) {
      return this.pusher.sendNotification("❌ 摘要生成失败: " + summary);
    }
    const msg = `📋 **会话摘要**（${cur.name}）：\n\n${summary}\n\n---\n💡 发 /新开 <任务名> 并把以上摘要作为提示词，即可带摘要开新会话继续（旧会话保留）。`;
    await this.pusher.sendNotification(msg);
    this.log.info("已生成会话摘要", { task: cur.name });
  }

  /**
   * 用 claude 生成对话摘要（临时会话，不干扰当前任务）
   */
  async _summarize(history, cwd) {
    try {
      const text = history
        .map((m) => (m.role === "user" ? "用户: " : "AI: ") + m.text)
        .join("\n")
        .slice(0, 30000);
      const prompt = `请为以下 AI 对话生成精炼摘要（保留：任务目标、已做的关键决定、重要结论、未完成事项。300 字以内）：\n\n${text}`;
      const sessionId = crypto.randomUUID();
      const args = this._buildArgs({ sessionId, cwd, isNew: true, prompt });
      const { code, stdout, stderr, error, result } = await this._spawn(args, cwd, () => {}, sessionId);
      return (result || this._extractResult(stdout, stderr, code, error) || "").trim();
    } catch (e) {
      return "❌ " + e.message;
    }
  }

  /**
   * 读取"总是允许"的工具列表（持久化在 registry 目录下）
   * @returns {string[]} 形如 ["Bash(git:*)", "Write"] 的规则
   */
  _loadAllowedTools() {
    try {
      const file = path.join(
        path.dirname(this.cfg.registry.file),
        "allowed-tools.json"
      );
      if (!fs.existsSync(file)) return [];
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data) ? data : [];
    } catch (e) {
      this.log.error("读取 always-allow 列表失败", { err: e.message });
      return [];
    }
  }

  /** 把工具加入"总是允许"列表（持久化） */
  _addAllowedTool(rule) {
    try {
      const dir = path.dirname(this.cfg.registry.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "allowed-tools.json");
      const list = this._loadAllowedTools();
      if (!list.includes(rule)) list.push(rule);
      fs.writeFileSync(file, JSON.stringify(list, null, 2), "utf8");
      return true;
    } catch (e) {
      this.log.error("写入 always-allow 列表失败", { err: e.message });
      return false;
    }
  }

  _parseWatchEvent(line) {
    try {
      const d = JSON.parse(line);
      if (d.type === "user") {
        const c = d.message && d.message.content;
        let text = "";
        if (typeof c === "string") text = c;
        else if (Array.isArray(c)) {
          text = c
            .filter((i) => i && i.type === "text" && i.text)
            .map((i) => i.text)
            .join("\n");
        }
        if (text && text.trim()) {
          return { role: "user", text: "🧑 你: " + text.trim().slice(0, 200) };
        }
      }
      if (d.type === "assistant") {
        const c = d.message && d.message.content;
        if (Array.isArray(c)) {
          const parts = [];
          for (const item of c) {
            if (item && item.type === "text" && item.text && item.text.trim()) {
              parts.push("🤖 " + item.text.trim());
            } else if (item && item.type === "tool_use" && item.name) {
              parts.push("🔧 调用工具: " + item.name);
            }
          }
          if (parts.length) {
            return { role: "assistant", text: parts.join("\n").slice(0, 400) };
          }
        }
      }
    } catch {}
    return null;
  }
}

module.exports = { ClaudeRunner };
