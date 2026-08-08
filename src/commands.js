// 命令解析器
// 支持：/项目 <路径|名称>、/新开 <任务名>、/切换 <任务名|编号>、/会话列表、/继续、/帮助、/重置

const CMD_RE = /^\/(项目|新开|切换|列表|会话列表|接管|继续|重置|帮助|help)\s*(.*)$/;

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
/重置                重置当前项目状态
其他消息直接作为提示词发给 Claude`;

module.exports = { parseCommand, HELP_TEXT };
