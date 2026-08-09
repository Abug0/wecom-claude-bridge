// 命令解析器
// 支持：/项目 <路径|名称>、/新开 <任务名>、/切换 <任务名|编号>、/会话列表、/继续、/帮助、/重置、/状态、/pin、/别名

const CMD_RE = /^\/(项目|新开|切换|列表|会话列表|接管|继续|重置|帮助|help|状态|pin|别名|盯|不盯|watch|unwatch|模式)\s*(.*)$/;

/**
 * 解析微信消息
 * @param {string} content
 * @returns {{type: string, ...}}
 *   type: prompt | project | new | switch | list | continue | reset | usage
 */
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
      const [name, ...p] = rest.split(/\s+/);
      if (!name) return { type: "usage", hint: "用法: /新开 <任务名> [提示词]" };
      return { type: "new", taskName: name, prompt: p.join(" ") || null };
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
/pin <任务名|编号>   置顶/取消置顶会话（⭐）
/别名 <任务名|编号> <新名>  给会话设置别名
/重置                重置当前项目状态
其他消息直接作为提示词发给 Claude`;

module.exports = { parseCommand, HELP_TEXT };
