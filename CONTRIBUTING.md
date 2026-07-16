# Contributing to StoryStudio

感谢参与 StoryStudio。项目的核心目标是把长篇网文创作做成一条可追溯、可审查、可恢复的本地生产链。

## Development setup

要求：

- Node.js 20 或更高版本；
- npm；
- Windows、macOS 或 Linux。

```console
git clone https://github.com/Herobetrine/StoryStudio.git
cd StoryStudio
npm ci
npm run check
npm run docs:check
npm test
npm run quality:check
```

启动开发实例：

```console
npm start
```

默认地址为 `http://127.0.0.1:8123/`。开发和测试请使用单独的数据目录：

### PowerShell

```powershell
$env:PORT = '8125'
$env:STORY_STUDIO_DATA_ROOT = Join-Path $env:TEMP 'story-studio-dev'
npm start
```

### Bash

```bash
PORT=8125 STORY_STUDIO_DATA_ROOT=/tmp/story-studio-dev npm start
```

## Before opening a change

1. 先阅读 [`README.md`](./README.md)、[`ARCHITECTURE.md`](./ARCHITECTURE.md) 和 [`ROADMAP.md`](./ROADMAP.md)。
2. 搜索现有 issue 和 pull request，避免重复实现。
3. 对数据模型、API、Provider、Workflow、恢复和安全边界的改动先写清不变量。
4. 使用合成作品和测试密钥；不要复制个人私稿或真实 Provider 凭据。

## Design rules

### Authority before convenience

- 模型输出先进入候选、Artifact 或 proposal；
- 权威写入需要严格 Schema、引用、项目版本和章节修订；
- 正文与 Story State 的联合变化使用原子采纳；
- 冲突和恢复证据不足时保持 fail-closed；
- UI 简化可以隐藏工程细节，但不得建立第二套状态。

### Preserve traceability

新增摘要、记忆、图谱、质量问题或自动建议时，应保留：

- 来源类型与 ID；
- 章节与文本范围；
- 内容摘要；
- 产生它的版本、模型或规则；
- proposal、审批和采纳血缘。

### Keep compatibility explicit

- SillyTavern 资源导入必须有 fixture 和兼容诊断；
- 脚本、EJS、TavernHelper 和未知表达式保持惰性；
- Prompt Profile 或 Schema 变化需要版本与迁移；
- 已发布的内置 Workflow/Profile 不在原位修改，新增版本或新 ID；
- 兼容报告应明确“完整、转换、降级、忽略、告警”中的具体结果。

### Local-first and private by default

- 前端不引入运行时远程脚本；
- 新网络调用必须由用户显式配置或触发；
- 密钥保留在服务端，日志和错误不回显密钥；
- 数据目录、导出、备份和遥测边界需要公开说明；
- 不提交 `data/`、`logs/`、`.env`、凭据或 QA 私稿。

## Code organization

| Path | Responsibility |
| --- | --- |
| `server.js` | 进程入口、端口、数据目录和退出 |
| `src/app.js` | Express 装配与公共中间件 |
| `src/story-studio-*` | 作品、卷、章、资源与权威 Store/API |
| `src/generation-*` | 候选生成、历史、蒸馏与采纳 |
| `src/retrieval-*` | 本地检索和派生索引 |
| `src/workflow-*` | Workflow Definition、run、Artifact 和执行 |
| `src/copilot-*` | 只读策划 Copilot |
| `src/quality-*` | 质量规则、报告、regression 与 baseline |
| `src/openai-provider.js` | Provider 协议、超时、流式解析和传输边界 |
| `public/` | 浏览器工作区和纯前端模型 |
| `fixtures/` | 固定公开回归数据 |
| `tests/` | Node.js 合同与回归测试 |

尽量把可测试逻辑写成纯函数。路由负责 HTTP 合同，Service 负责编排，Store 负责持久化和完整性。

## Tests

提交前运行：

```console
npm run check
npm run docs:check
npm test
npm run quality:check
npm audit --omit=dev
npm pack --dry-run --json
```

验证重点：

- 新 API：成功、非法字段、错误类型、CSRF、Origin、内容类型和大小限制；
- Store：路径、所有权、摘要、原子发布、并发冲突、中断恢复和损坏隔离；
- Provider：六协议、参数映射、超时、取消、重定向、错误体、JSON、SSE/NDJSON；
- Story State：引用、时间、POV、未来信息、替代链和 ChangeSet 原子性；
- Workflow：Definition hash、V1 兼容、Artifact 血缘、receipt、取消、租约和恢复；
- UI：纯状态投影、冲突、刷新恢复、桌面和移动视口；
- 数据格式：旧版 fixture、升级、导出、重新导入和回滚证据。

修改固定质量规则、Profile 或 regression suite 时：

1. 先运行 `npm run quality:check` 观察门禁；
2. 解释预期指标变化；
3. 只有预期变化经过审查后才运行 `npm run quality:baseline`；
4. 同时提交规则、fixture、baseline 和说明。

## Documentation

- 用户操作写入 `README.md`；
- 数据流、安全边界和维护不变量写入 `ARCHITECTURE.md`；
- 计划能力写入 `ROADMAP.md`；
- 用户可见变化写入 `CHANGELOG.md`；
- 安全报告与部署边界写入 `SECURITY.md`。

公开文档使用可移植路径：

- `<repo>`：StoryStudio 仓库根目录；
- `<data-root>`：运行时数据根目录；
- `<backup-root>`：外部备份目录。

不要在稳定文档中提交开发机用户名或盘符路径。

本地工具比较、逆向/采集、内部审查、验收原始证据和恢复检查点统一放在
`.research/` 或 `.private/`。这两个目录及常见内部记录文件名均由 `.gitignore`
排除，公开树门禁还会检查 Git 索引，防止被强制加入。公开 pull request 只保留实现、
用户文档、可复现测试和合成 fixture。新增公开源文件时还必须显式更新
`.public-source-manifest.txt`；CI 会拒绝任何未经过该清单审查的 Git 跟踪文件。

## Commit and pull request guidance

建议提交类型：

- `feat:` 新能力；
- `fix:` 缺陷修复；
- `docs:` 文档；
- `test:` 测试；
- `refactor:` 不改变行为的重构；
- `chore:` 工程维护。

一个 pull request 尽量围绕一个可验收目标。描述应包含：

1. 问题和用户价值；
2. 设计与权威数据边界；
3. 数据或 API 兼容影响；
4. 风险与恢复方式；
5. 测试命令和实际结果；
6. UI 变化的桌面/移动截图；
7. 后续事项。

## Pull request checklist

- [ ] 改动直接服务于长篇创作目标。
- [ ] 新持久字段有版本、校验、迁移和 fixture。
- [ ] 模型输出仍先进入候选/proposal。
- [ ] 版本冲突和恢复路径保持 fail-closed。
- [ ] 没有密钥、私稿、日志或本机绝对路径。
- [ ] `npm run check` 通过。
- [ ] `npm run docs:check` 通过，发布文档没有包外相对链接或本机绝对路径。
- [ ] `npm test` 通过。
- [ ] `npm run quality:check` 通过。
- [ ] `npm audit --omit=dev` 通过。
- [ ] npm 打包清单只含白名单内容。
- [ ] 用户文档、架构文档和 changelog 已同步。

## Security issues

涉及密钥、私稿泄露、路径越界、跨项目访问、CSRF、Provider 边界、权威写入或恢复绕过的问题，请按 [`SECURITY.md`](./SECURITY.md) 使用私密报告渠道。
