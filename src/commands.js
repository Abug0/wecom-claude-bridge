// 命令解析器
// 支持：/项目 <路径|名称>、/新开 <任务名>、/切换 <任务名|编号>、/会话列表、/继续、/帮助、/重置、/状态、/pin、/别名

const CMD_RE = /^\/(项目|新开|切换|列表|会话列表|接管|继续|重置|帮助|help|状态|pin|别名|盯|不盯|watch|unwatch|模式|重启|停止|中止|stop|model|compact|历史|history|导出|export|effort|thinking|搜索|search|成本|cost|定时|定时列表|取消定时|发送文件)\s*(.*)$/;

/**
 * 解析微信消息
 * @param {string} content
 * @returns {{type: string, ...}}
 *   type: prompt | project | new | switch | list | continue | reset | usage
 */
/**
 * 自然语言命令关键词匹配（语音/文本不带 / 时）
 * 返回 { type, hint } 或 null（未匹配则当普通消息）
 * 注意：匹配到后是否执行由桥接的确认流程决定（破坏性命令需用户二次确认）
 */
const NATURAL_KEYWORDS = [
  // [关键词, 命令类型, 是否破坏性]
  ["新开", "new", true],
  ["新建", "new", true],
  ["新会话", "new", true],
  ["切换", "switch", true],
  ["接管", "takeover", true],
  ["重置", "reset", true],
  ["重启", "restart", true],
  ["会话列表", "list", false],
  ["列出会话", "list", false],
  ["状态", "status", false],
  ["继续", "continue", false],
  ["停止", "stop", false],
  ["中止", "stop", false],
  ["导出", "export", false],
  ["历史", "history", false],
];

function matchNaturalCommand(text) {
  for (const [kw, type, destructive] of NATURAL_KEYWORDS) {
    if (text.includes(kw)) {
      return { type, keyword: kw, destructive };
    }
  }
  return null;
}

function parseCommand(content) {
  const text = (content || "").trim();
  if (!text) return { type: "usage" };

  const m = CMD_RE.exec(text);
  if (!m) return { type: "prompt", prompt: text };

  const cmd = m[1];
  const rest = m[2].trim();

  switch (cmd) {
    case "项目": {
      if (!rest) return { type: "usage", hint: "用法: /项目 <项目路径或名称>" };
      return { type: "project", selector: rest };
    }
    case "新开": {
      if (!rest) return { type: "usage", hint: "用法: /新开 <任务名> [提示词]，或 /新开 <提示词>（自动命名）" };
      const words = rest.split(/\s+/);
      // 第一个词短（≤8 字符）→ 视为任务名；否则整个视为提示词，名字自动生成
      if (words[0].length <= 8) {
        const [name, ...p] = words;
        return { type: "new", taskName: name, prompt: p.join(" ") || null };
      }
      return { type: "new", taskName: null, prompt: rest };
    }
    case "切换": {
      if (!rest) return { type: "usage", hint: "用法: /切换 <任务名或编号>" };
      return { type: "switch", selector: rest };
    }
    case "接管": {
      if (!rest) return { type: "usage", hint: "用法: /接管 <编号>" };
      return { type: "takeover", selector: rest };
    }
    case "列表":
    case "会话列表":
      // 支持分页: /会话列表 2 或 /会话列表 全部
      return { type: "list", page: rest || "1" };
    case "继续":
      return { type: "continue", prompt: rest || null };
    case "重置":
      return { type: "reset" };
    case "状态":
      return { type: "status" };
    case "pin": {
      if (!rest) return { type: "usage", hint: "用法: /pin <任务名或编号>" };
      return { type: "pin", selector: rest };
    }
    case "别名": {
      const [sel, ...restP] = rest.split(/\s+/);
      const alias = restP.join(" ").trim();
      if (!sel || !alias) return { type: "usage", hint: "用法: /别名 <任务名或编号> <新别名>" };
      return { type: "alias", selector: sel, alias };
    }
    case "盯":
    case "watch": {
      return { type: "watch", selector: rest || null };
    }
    case "不盯":
    case "unwatch": {
      return { type: "unwatch" };
    }
    case "模式": {
      if (!rest) return { type: "usage", hint: "用法: /模式 <default|accept|bypass|plan>" };
      return { type: "mode", mode: rest.toLowerCase() };
    }
    case "重启": {
      return { type: "restart" };
    }
    case "停止":
    case "中止":
    case "stop": {
      return { type: "stop" };
    }
    case "model": {
      return { type: "model", model: rest || null };
    }
    case "compact": {
      return { type: "compact" };
    }
    case "历史":
    case "history": {
      return { type: "history", selector: rest || null };
    }
    case "导出":
    case "export": {
      return { type: "export", selector: rest || null };
    }
    case "effort": {
      if (!rest) return { type: "usage", hint: "用法: /effort <low|medium|high|max>" };
      return { type: "effort", level: rest.toLowerCase() };
    }
    case "thinking": {
      return { type: "thinking", on: rest.toLowerCase() };
    }
    case "搜索":
    case "search": {
      if (!rest) return { type: "usage", hint: "用法: /搜索 <关键词>" };
      return { type: "search", keyword: rest };
    }
    case "成本":
    case "cost": {
      return { type: "cost" };
    }
    case "定时": {
      if (!rest) return { type: "usage", hint: "用法: /定时 每<N>分钟 <任务描述>" };
      if (/^(列表|list)$/i.test(rest)) return { type: "cron", action: "list" };
      return { type: "cron", action: "create", rest };
    }
    case "定时列表": {
      return { type: "cron", action: "list" };
    }
    case "取消定时": {
      if (!rest) return { type: "usage", hint: "用法: /取消定时 <编号>" };
      return { type: "cron", action: "cancel", id: rest.trim() };
    }
    case "发送文件": {
      if (!rest) return { type: "usage", hint: "用法: /发送文件 <文件路径>" };
      return { type: "sendfile", path: rest.trim() };
    }
    case "帮助":
    case "help":
    default:
      return { type: "usage" };
  }
}

const HELP_TEXT = `可用的命令：
/项目 <路径或名称>   切换工作项目
/新开 <任务名> [提示词]  开新会话并命名
/切换 <任务名|编号>  切换到已有会话
/接管 <编号>        接管 VSCode 里的最近会话
/会话列表            列出所有项目/会话（含 VSCode 最近会话）
/继续 [提示词]       在当前会话继续
/状态                查看当前任务状态（活跃时间/最后一句/在做什么）
/盯 [编号]          实时查看某会话在 VSCode 的进展（tail jsonl）
/不盯               停止实时监控
/模式 <类型>        切换权限模式：default/accept/bypass/plan
/重启               重启桥接服务（由桥接自行处理，不会中断）
/停止               中止当前任务并清空排队消息
/model [模型ID]    查看或切换模型（如 /model deepseek-v4-flash）
/effort <级别>     切换推理努力程度：low/medium/high/max
/thinking <on|off> 是否展示思考内容（默认 off 只显示"思考中…"）
/compact            压缩当前会话上下文（生成摘要）
/历史 [编号]       查看某会话最近对话（不接管）
/导出 [编号]       导出会话为 markdown 文件
/搜索 <关键词>     在历史会话中搜索内容
/成本              查看 token 用量与花费统计
/定时 每<N>分钟 <任务>  设置定时任务（如 /定时 每30分钟 检查服务器）
/定时列表          查看定时任务
/取消定时 <编号>   取消定时任务
/发送文件 <路径>   把本地文件发送到微信（如 /发送文件 C:\a.txt）
/pin <任务名|编号>   置顶/取消置顶会话（⭐）
/别名 <任务名|编号> <新名>  给会话设置别名
/重置                重置当前项目状态
其他消息直接作为提示词发给 Claude`;

module.exports = { parseCommand, matchNaturalCommand, HELP_TEXT };
