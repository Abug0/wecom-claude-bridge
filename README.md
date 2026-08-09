# wecom-claude-bridge

通过企业微信远程操控 Claude Code：人在外面，用微信指挥本机的 Claude Code 干活，实现与 VSCode 会话的无缝衔接。

## ✨ 功能

- **企业微信智能机器人通道**（API 模式-长连接，免公网 IP 白名单）
  - 对话流式打字机回复
  - 语音消息自动转文字
  - 图片/文件消息下载后交给 Claude 处理
  - 主动推送（权限确认、命令回复）始终留在 bot 会话
- **20+ 微信命令**：`/新开` `/切换` `/接管` `/会话列表` `/继续` `/状态` `/盯` `/模式` `/停止` `/重启` `/model` `/effort` `/thinking` `/compact` `/历史` `/导出` `/pin` `/别名` 等
- **权限体验**：`/模式` 切换权限级别、授权时"总是允许"、`/停止` 中止任务
- **并行会话执行**：不同会话并发运行（同会话串行）
- **VSCode 实时视图扩展**（`vscode-live-viewer/`）：逐字流式显示微信操作的消息流
- **自建应用通道**（URL 回调）作为降级备份
- **开机自启 + 崩溃自动恢复**（watchdog）

## 🏗 架构

```
你的微信 → 企业微信智能机器人(WS长连接) → 本机桥接服务
                                        ├─ claude -p --resume <会话>（微信操作）
                                        ├─ 命令分发（会话管理/权限/监控）
                                        └─ VSCode 实时视图（jsonl/.live 监听）
```

- **智能机器人**（默认）：`aibot_msg_callback` 收消息，`aibot_respond_msg` 流式回复，免公网 IP
- **自建应用**（降级）：URL 回调 + `message/send`，需公网入口（nginx + 反向隧道）
- **会话文件**：与 VSCode 共享 `~/.claude/projects/` 下的 jsonl，上下文天然延续

## 🚀 快速开始

### 1. 环境要求

- Node.js ≥ 18
- Claude Code CLI（`claude` 命令可用）
- 企业微信（后台配置智能机器人）

### 2. 安装

```bash
git clone <repo-url>
cd wecom-claude-bridge
npm install
cp .env.example .env   # 按需修改
```

### 3. 配置企业微信智能机器人（API 模式-长连接）

1. 企业微信管理后台 → 管理工具 → 智能机器人 → 创建机器人 → **API 模式创建**
2. 连接方式选「使用长连接」
3. 拿到 **Bot ID** 和 **Secret**，填入 `.env`：
   ```
   WECOM_BOT_ENABLED=1
   WECOM_BOT_ID=your_bot_id
   WECOM_BOT_SECRET=your_bot_secret
   ```
4. 设置可见范围（至少包含你自己）

### 4. 启动

```bash
npm start
```

然后在企业微信里给机器人发消息即可。

> **Windows 用户必配**：`.env` 里需要设置 `CLAUDE_BIN`（claude 的完整路径）和 `CLAUDE_CODE_GIT_BASH_PATH`（git-bash 的 bash.exe 路径，claude 依赖它运行）。Linux/macOS 默认 `claude`/`bash` 即可。

### 5. VSCode 实时视图（可选）

把 `vscode-live-viewer/` 复制到 `~/.vscode/extensions/` 下（重命名为 `local.wecom-live-viewer-0.1.0`），reload VSCode，点左侧"微信远程"图标。

### 6. 在其他项目启用微信授权确认（可选）

微信里的"允许/拒绝"授权确认，需要在你**想远程操作的 Claude Code 项目**里接入 `wecom_approver` MCP。在该项目的 `.mcp.json` 加入：

```json
{
  "mcpServers": {
    "wecom_approver": {
      "command": "node",
      "args": ["<桥接工程绝对路径>/src/approver/mcp-server.js"],
      "env": { "BRIDGE_PORT": "8787", "APPROVER_TIMEOUT_MS": "300000" }
    }
  }
}
```

同时在 `~/.claude/settings.json`（或项目设置）里让 claude 进程使用该授权工具（见 `src/config.js` 的 `permissionPromptTool`）。桥接自身已内置此配置（`.mcp.json`）。

## 📖 命令清单

| 命令 | 说明 |
|------|------|
| `/项目 <路径或名称>` | 切换工作项目 |
| `/新开 <任务名> [提示词]` | 开新会话并命名（不带名字自动用提示词命名）|
| `/切换 <任务名|编号>` | 切换到已有会话 |
| `/接管 <编号>` | 接管 VSCode 最近会话 |
| `/会话列表` | 列出所有项目/会话（分页）|
| `/继续 [提示词]` | 在当前会话继续 |
| `/状态` | 查看任务状态（执行中/队列）|
| `/盯 [编号]` | 实时监控某会话在 VSCode 的进展 |
| `/不盯` | 停止监控 |
| `/模式 <default\|accept\|bypass\|plan>` | 切换权限模式 |
| `/停止` | 中止所有任务并清空队列 |
| `/重启` | 安全重启桥接服务 |
| `/model [ID]` | 查看/切换模型 |
| `/effort <low\|medium\|high\|max>` | 切换推理努力程度 |
| `/thinking <on\|off>` | 开关思考内容展示 |
| `/compact` | 生成会话摘要（压缩上下文）|
| `/历史 [编号]` | 查看会话最近对话 |
| `/导出 [编号]` | 导出会话为 markdown |
| `/pin <任务名\|编号>` | 置顶会话 |
| `/别名 <任务名\|编号> <新名>` | 设置会话别名 |
| `/重置` | 重置当前项目状态 |

其他消息直接作为提示词发给 Claude。

## ⚙️ 配置说明

主要配置见 `.env.example`。核心项：

| 变量 | 说明 |
|------|------|
| `WECOM_BOT_ENABLED/ID/SECRET` | 智能机器人通道 |
| `WECOM_CORP_ID` 等 | 自建应用通道（降级）|
| `CLAUDE_BIN` | claude CLI 路径 |
| `WORKDIR` | 默认工作目录 |
| `CLAUDE_PERMISSION_MODE` | 默认权限模式 |
| `VSCODE_AUTO_OPEN` | 任务完成自动打开 VSCode 会话 |
| `HEARTBEAT_ENABLED` | 长任务心跳（默认关）|

## 🔐 安全说明

- 密钥只放 `.env`（已 gitignore）
- 权限确认走微信（`/模式 bypass` 有风险，谨慎使用）
- 桥接服务只监听本机（`127.0.0.1`），公网入口需自行加固（nginx/隧道 + 鉴权）

## 📄 License

MIT
