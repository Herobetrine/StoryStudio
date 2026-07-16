# Changelog

StoryStudio 的重要变化记录在此文件中。

格式参考 Keep a Changelog，版本号遵循语义化版本。当前仓库从 0.7.0 开始维护公开变更记录；更早的开发历史请查阅 Git 提交。

## Unreleased

### Added

- Windows / Ubuntu、Node.js 20 的 GitHub Actions CI。
- 发布文档门禁 `npm run docs:check`，按 npm `files` 清单校验 Markdown 相对链接和开发机绝对路径；CI 同时执行包清单 dry-run。
- PowerShell 启动器在 lockfile 存在时使用确定性 `npm ci --omit=dev`，在 npm 打包产物缺少 lockfile 时回退到 `npm install --omit=dev`；补齐公开仓库元数据。
- 分阶段路线图、安全政策和贡献指南。
- Dashboard V1 只读项目投影与 `GET /api/story-studio/projects/:projectId/dashboard`，用于作品进度、焦点章节、下一步和创作债务聚合。
- 顶层“今日”工作台，包含确定性下一步、总字数与章节状态、今日工作项、伏笔债务、过期章纲、Story State 摘要、近期章节，以及桌面/移动端的载入、空、错误和重试状态。
- Copilot 方向到 Workflow V2 的来源绑定交接：完整方向集合进入 `brainstorm-direction` Artifact，作者所选方向成为唯一批准项，新 run 直接进入 `plan`，并支持幂等重放、中断恢复、活动 run 冲突和权威状态变化阻断。
- Copilot 长链交接：每个方向完整保留 3–12 节点 `sourceEventChain`，Plan 用严格 `sourceEventCoverage` 把每个源事件映射到互不复用的合法 beat，Draft 继续消费该映射。
- Quality Regression V1 revision 2 固定集，使用 10 个公开短文本样例覆盖单章确定性规则合同。
- 网文创作升级优先队列：酒馆原生 JSON 资源导出、稳定锚点批注、Voice/术语 Bible、类型化状态包、Story Tests、研究资料库、Reader Room 和作品包装。
- 普通角色卡和世界书资源详情新增“导入兼容性”面板，直接显示保留但未完整执行或采用近似语义的 SillyTavern 字段。

### Changed

- npm 打包采用 `files` 白名单，只发布运行所需源码、固定质量 fixture 和稳定文档。
- 稳定文档中的开发机绝对路径替换为 `<repo>`、`<data-root>`、`<evidence-root>` 等可移植占位符。
- Copilot 的设定/Lorebook Diff 继续保持只读；方向卡新增“用此方向开始流程”，通过 Workflow 的人工门和最终采纳承接后续权威写入。
- Copilot handoff V2 的持久快照改为来源坐标与摘要，完整方向保存在 run-scoped Artifact；Workflow GET 保持只读，中断恢复只在认证 POST 对账中执行，标准路径是原始 start POST 重放。
- 文档统一明确：StoryStudio 从 SillyTavern 改造、拆分而来；当前兼容的是角色卡、世界书和 Prompt preset 的资源导入，不是酒馆通用插件运行时。
- Extension SDK 路线补齐声明式/隔离执行模型、服务端 grant、五类类型化合同、贡献面拆分和 `st-bounded-v1` 酒馆适配 Profile。
- “导出作品”统一定义为导入后重映射 ID 的便携内容副本；保持项目身份、Workflow/Copilot/Quality 和版本血缘需要完整 `data` 停服快照。
- Quality Regression V1 明确限定为短文本、单章规则维护门禁，不代表跨章/整卷审查、长章性能或真实作者稿的主观质量验证。

### Removed

- 本地工具比较、采集分析、内部审查、验收证据和恢复检查点退出公开 Git 树与发布包。
- 公开文档中的内部材料引用、一次性运行记录和外部工具研究清单。
- 新增逐文件公开源码清单门禁；任何新 Git 跟踪文件都必须经过显式清单审查。

### Fixed

- Copilot 流程取消后再次选择同一方向会生成新的交接命令；同一次网络不确定重试仍复用原命令，保留幂等恢复。
- 发布包中的 `mock-provider` 入口迁移到 `scripts/`，发布合同会逐项验证所有直接 Node.js 脚本入口均随包分发。

### Security

- Provider 请求使用手工重定向策略，避免跨 Origin 重定向携带自定义密钥头。
- Provider 错误体、JSON、SSE/NDJSON 和最终正文增加传输层大小边界与稳定超限错误。

## 0.7.0 - 2026-07-16

### Added

- Schema V5 Story State：实体、关系、事件、开放事项和记忆，并保留 facts、knowledge、timeline。
- 内置 Workflow V2 十二步章节闭环、类型化 Artifact、人工门、幂等 receipt 和恢复机制。
- 独立只读策划 Copilot，支持手选上下文、3–6 个方向、设定 Diff 和 Lorebook Diff。
- Prompt Profile V2、八套内置网文 Profile 和五类题材 overlay。
- MiniSearch/BM25 风格本地检索、稳定来源定位和 POV/未来信息过滤。
- 章节正式稿版本历史与恢复。
- 章节质量报告、固定 Quality Regression V1、baseline、HTTP API 和 CLI。
- V1-V4 项目到 V5 的验证、原始字节备份、迁移 journal 和恢复。
- 桌面与移动端的 Workflow、Copilot 和质量工作区。

### Changed

- StoryStudio 从 SillyTavern 主项目拆分为独立 Node.js 服务、Git 仓库和数据目录。
- Chat Completion 预设的 `prompts + prompt_order` 转换为 Prompt Profile V2。
- 作品、章节、资源和 Story State 写入统一使用版本检查、项目锁、原子文件替换和恢复日志。

### Security

- 默认只监听 `127.0.0.1`。
- 写 API 使用同源、CSRF、JSON 类型、请求大小和严格字段校验。
- Provider 密钥只保存在服务端密钥文件，公开 API 仅返回脱敏状态。
- Prompt 中的脚本、EJS 和 TavernHelper 表达式按惰性文本处理。
- Workflow 条件使用有限 AST，模型步骤没有权威应用权限。
