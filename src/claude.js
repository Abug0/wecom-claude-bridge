// claude.exe 调用器 + 串行队列 + 超时/杀进程 + 命令分发
const { spawn, execFileSync } = require("child_process");
const crypto = require("crypto");
const { parseCommand, HELP_TEXT } = require("./commands");
const { detectActiveSession, listRecentSessions, readSessionHistory, formatSessionName } = require("./detector");
const { encodeCwd } = require("./projects");

class ClaudeRunner {
  constructor(cfg, log, registry, pusher) {
    this.cfg = cfg;
    this.log = log;
    this.registry = registry;
    this.pusher = pusher;
    this.queue = [];
    this.running = false;
    this.active = null;
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
    await this.pusher.pushSectioned(
      "切换",
      `已切换到「${task.name}」\n发送 /继续 <提示词> 或直接发消息继续。`
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
      // 所有 VSCode 会话（含已绑定的，但已绑定显示为任务名）
      const all = listRecentSessions({ sessionDir: this.cfg.claude.sessionDir, cwd, limit: 0 });
      // 标记每个 VSCode 会话是否已被绑定
      const entries = [];
      tasks.forEach((t) => {
        entries.push({
          name: t.name,
          mark: cur && cur.name === t.name,
          isBound: true,
          time: (t.lastActiveAt || "").slice(0, 16),
        });
      });
      const unbound = all.filter((s) => !boundIds.has(s.sessionId));
      unbound.forEach((s) => {
        entries.push({ name: formatSessionName(s), mark: false, isBound: false, time: null });
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
          const mark = e.mark ? " 👈当前" : "";
          lines.push(`   ${i + 1}. ${e.name}${mark}${e.time ? ` (${e.time})` : ""}`);
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
      // 无当前任务 → 自动识别 VSCode 会话并绑定
      const detected = detectActiveSession({
        sessionDir: this.cfg.claude.sessionDir,
        cwd: proj.cwd,
      });
      if (detected) {
        const name = "vscode-" + (detected.slug || detected.sessionId.slice(0, 8));
        this.registry.addTask(projKey, name, {
          sessionId: detected.sessionId,
          cwd: detected.cwd,
        });
        this.registry.setCurrentTask(projKey, name);
        this.log.info("自动绑定 VSCode 会话", { name, sessionId: detected.sessionId });
        return this.enqueue({
          taskName: name,
          sessionId: detected.sessionId,
          cwd: detected.cwd,
          prompt: cmd.prompt,
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
      // 无当前任务 → 尝试自动识别 VSCode 会话
      const detected = detectActiveSession({
        sessionDir: this.cfg.claude.sessionDir,
        cwd: proj.cwd,
      });
      if (detected) {
        const name = "vscode-" + (detected.slug || detected.sessionId.slice(0, 8));
        this.registry.addTask(projKey, name, {
          sessionId: detected.sessionId,
          cwd: detected.cwd,
        });
        this.registry.setCurrentTask(projKey, name);
        this.log.info("自动绑定 VSCode 会话", { name, sessionId: detected.sessionId });
        const prompt = cmd.prompt || "继续";
        return this.enqueue({ taskName: name, sessionId: detected.sessionId, cwd: detected.cwd, prompt });
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
   * 入队一条 claude 执行
   */
  enqueue(job) {
    this.queue.push(job);
    if (!this.running) this._drain();
    return job;
  }

  async _drain() {
    this.running = true;
    while (this.queue.length) {
      const job = this.queue.shift();
      await this._run(job);
    }
    this.running = false;
  }

  async _run(job) {
    const start = Date.now();

    // 开启智能机器人流式会话（若 bot 可用），对话内容走打字机
    let streamStarted = false;
    if (this.pusher && typeof this.pusher.beginTask === "function") {
      streamStarted = this.pusher.beginTask(job.taskName, job.reqId);
    }

    // 开始处理提示：有流式则作为流式首片，否则走自建应用
    const startHint = `⏳ 开始处理，队列剩余 ${this.queue.length} 条…`;
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
      const onPartial = ({ kind, text }) => {
        if (kind === "reply") {
          replyBuf += text;
        } else if (kind === "thinking") {
          if (!pushedThinking) {
            pushedThinking = true;
            this.pusher.pushStyled(job.taskName, "思考中…", "thinking").catch(() => {});
          }
        } else if (kind === "tool") {
          // 每个工具调用推一条（可能有多个工具）
          this.pusher.pushStyled(job.taskName, text, "tool").catch(() => {});
        }
      };

      const { code, stdout, stderr, error, result } = await this._spawn(args, job.cwd, onPartial);

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
    } catch (e) {
      this.log.error("claude 执行异常", { err: e.message });
      await this.pusher.pushSectioned(job.taskName, "❌ 执行失败: " + e.message);
    } finally {
      // 结束流式会话（未 finish 则用最终结果定型）
      if (this.pusher && typeof this.pusher.endTask === "function") {
        await this.pusher.endTask(job.taskName);
      }
      this.registry.touchTask(encodeCwd(job.cwd), job.taskName);
    }
  }

  /**
   * 末尾去重兜底：检测文本末尾是否有完整重复段（模型偶发重复），截断保留一份
   * @param {string} text
   * @returns {string}
   */
  _dedupTail(text) {
    if (!text || text.length < 10) return text;
    // 从后往前找重复：取末尾一段，看它是否在更早位置也出现
    const maxLen = Math.floor(text.length / 2);
    for (let len = Math.min(maxLen, 200); len >= 20; len--) {
      const tail = text.slice(text.length - len);
      const pos = text.indexOf(tail);
      if (pos !== -1 && pos < text.length - len) {
        // 早于末尾也出现 → 末尾是重复
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
      cfg.permissionMode,
    ];
    // 权限确认工具（P5 阶段启用）
    if (cfg.permissionPromptTool) {
      base.push("--permission-prompt-tool", cfg.permissionPromptTool);
    }
    if (job.isNew) {
      return [...base, "--session-id", job.sessionId, "--name", job.taskName, job.prompt];
    }
    return [...base, "--resume", job.sessionId, job.prompt];
  }

  _spawn(args, cwd, onPartial) {
    return new Promise((resolve) => {
      const bin = this.cfg.claude.bin;
      // claude 在 Windows 上需要 git-bash；子进程需继承该环境变量
      const env = {
        ...process.env,
        CLAUDE_CODE_GIT_BASH_PATH: this.cfg.claude.gitBashPath,
      };
      const child = spawn(bin, args, {
        cwd: cwd || this.cfg.claude.workdir,
        env,
        shell: false,
        windowsHide: true,
      });
      this.active = child;
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
            finalResult = r.is_error ? "❌ " + (r.result || "") : r.result;
            if (r.is_error) err = (err || "") + (r.result || "");
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
        this.active = null;
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
}

module.exports = { ClaudeRunner };
