# Contributing

感谢你愿意为 wecom-claude-bridge 贡献代码！请花两分钟阅读以下指南。

## 项目结构

```
src/
  index.js            # 桥接服务入口（Express + 配置 + 启动）
  config.js           # 配置加载（.env）
  claude.js           # claude 进程调用 + 命令分发 + 会话管理 + 并行调度
  commands.js         # 微信命令解析
  pusher.js           # 消息推送（流式/分片/降级）
  approver.js         # 微信授权确认（允许/拒绝/总是允许）
  bot/bot-client.js   # 企业微信智能机器人客户端（WS 长连接）
  wecom/              # 自建应用 API
  detector.js         # 会话文件扫描/识别
  projects.js         # 项目注册表
  logger.js           # 日志（按天滚动 + 脱敏）
scripts/              # watchdog 等运维脚本
vscode-live-viewer/   # VSCode 实时视图扩展
test/                 # 单元测试
```

## 环境准备

```bash
git clone <repo>
npm install
cp .env.example .env   # 填写你的企业微信配置
npm start              # 启动桥接
```

需要：Node.js ≥ 18、Claude Code CLI、企业微信（智能机器人 API 模式）。

## 开发

- **命令解析**在 `src/commands.js`（正则 + switch），处理逻辑在 `src/claude.js`
- 新增命令：`commands.js` 加解析 → `claude.js` 加 `_handleXxx` + dispatch case
- 微信消息类型（语音/图片/文件）处理在 `src/bot/bot-client.js`

## 测试

```bash
npm test          # 运行全部单元测试
node test/commands.test.js   # 单独跑命令解析测试
```

新增功能请补充对应测试（`test/` 目录）。

## 代码规范

- **JavaScript**：Google JavaScript Style Guide，CommonJS 模块
- 中文注释（项目约定）
- 不引入不必要的依赖；能用 Node 内置就少加包
- 日志通过 `logger.js`（自动脱敏 + 按天滚动），不要直接 `console.log`

## 提交规范

- commit message 用中文，格式：`类型: 描述`（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`）
- 一个改动一个 commit，不掺杂无关改动
- 只 `git add` 本次修改的文件

## PR 流程

1. fork 仓库，新建分支
2. 完成改动 + 测试
3. 提 PR，说明改动目的和验证方式

## 安全注意事项

- **密钥只放 `.env`**（已 gitignore），绝不要提交
- 不要提交含个人路径的配置（用环境变量或通用占位）
- 提交前检查 `git diff` 确认无敏感信息（路径/IP/域名/密钥）
- 涉及鉴权/凭证的改动要谨慎 review

## License

MIT
