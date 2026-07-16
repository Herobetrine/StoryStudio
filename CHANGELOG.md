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
- Playwright Chromium 浏览器回归，使用独立临时数据目录和动态端口覆盖跨标签页保存冲突、移动端生命周期 keepalive 与复制标签页草稿隔离；Ubuntu CI 将其作为必过门禁。

### Changed

- npm 打包采用 `files` 白名单，只发布运行所需源码、固定质量 fixture 和稳定文档。
- 稳定文档中的开发机绝对路径替换为 `<repo>`、`<data-root>`、`<evidence-root>` 等可移植占位符。
- Copilot 的设定/Lorebook Diff 继续保持只读；方向卡新增“用此方向开始流程”，通过 Workflow 的人工门和最终采纳承接后续权威写入。
- Copilot handoff V2 的持久快照改为来源坐标与摘要，完整方向保存在 run-scoped Artifact；Workflow GET 保持只读，中断恢复只在认证 POST 对账中执行，标准路径是原始 start POST 重放。
- 文档统一明确：StoryStudio 从 SillyTavern 改造、拆分而来；当前兼容的是角色卡、世界书和 Prompt preset 的资源导入，不是酒馆通用插件运行时。
- Extension SDK 路线补齐声明式/隔离执行模型、服务端 grant、五类类型化合同、贡献面拆分和 `st-bounded-v1` 酒馆适配 Profile。
- “导出作品”统一定义为导入后重映射 ID 的便携内容副本；保持项目身份、Workflow/Copilot/Quality 和版本血缘需要完整 `data` 停服快照。
- Quality Regression V1 明确限定为短文本、单章规则维护门禁，不代表跨章/整卷审查、长章性能或真实作者稿的主观质量验证。
- 浏览器保存并发、三方合并、乐观锁令牌和 PATCH 投影从 `public/app.js` 收束到可直接单测的 `public/save-state.js`，DOM、网络和渲染编排仍留在应用入口。

### Removed

- 本地工具比较、采集分析、内部审查、验收证据和恢复检查点退出公开 Git 树与发布包。
- 公开文档中的内部材料引用、一次性运行记录和外部工具研究清单。
- 新增逐文件公开源码清单门禁；任何新 Git 跟踪文件都必须经过显式清单审查。

### Fixed

- Copilot 流程取消后再次选择同一方向会生成新的交接命令；同一次网络不确定重试仍复用原命令，保留幂等恢复。
- 发布包中的 `mock-provider` 入口迁移到 `scripts/`，发布合同会逐项验证所有直接 Node.js 脚本入口均随包分发。
- Provider 截止计时器在 Node.js 20 下保持有效直到请求清理，避免无额外事件循环句柄的请求提前结束；Mock Provider 中断测试改为等待真实计时器清理事件，CI Actions 同步升级到 Node 24 运行时版本。
- 浏览器在正文、章纲、卷纲或作品设定进入待保存时立即写入按作品、章节和标签页 writer 隔离的本地恢复草稿；移动端切到后台或快速关闭页面时再次持久化，并为纯章节修改尝试 `keepalive` 保存。复制标签页会通过活跃租约探测改用独立 writer，同页刷新只在权威版本精确匹配时自动恢复，其他标签页或旧会话草稿始终先确认；草稿删除使用原始值比较，保存期间产生的新修改不会被误删，清理 CAS 失败时会重新检查同键的新草稿而不是在本次恢复中永久跳过。
- 上下文预览和 Copilot NDJSON 流都按作品、章节、会话、请求序号和中止控制器丢弃迟到结果，旧请求的成功、错误或结束事件不再污染新作品和新会话。
- Copilot 会话列表和详情 `GET` 改为纯读取；异常退出后的 `generating` 会话由带 CSRF 保护的显式 reconcile POST 幂等恢复，并跳过当前仍在执行的请求。列表与详情都会先纯读验证作品仍存在，不会从孤立 sidecar 返回已删除作品的会话。
- Generation 列表、详情、流式恢复和 distillation 读取都会先纯读验证对应作品与章节仍存在；章节删除后遗留的 generation sidecar 不再通过 API 暴露。
- Workflow run 列表和详情 `GET` 改用当前 Schema 的纯读权威快照，不再因 StoryStore 写锁恢复 pending journal 或执行 V4→V5 迁移；待恢复和待迁移状态分别稳定返回 `recovery_required` 与 `migration_required`，认证 POST 仍保留原有恢复路径。
- Windows 启动器依据 shrinkwrap、lockfile 或 `package.json` 的 SHA-256 摘要判断依赖是否陈旧，并用完整生产依赖树发现缺失的传递依赖；安装失败时不写入成功摘要。
- Workflow 新建运行、命令、内置 Quality Profile 复制和资源写操作现在统一在初始保存前锁定跨工作区导航；新建运行也会阻断慢保存期间的重复点击。Workflow 在初始保存完成前禁用取消，取消请求失败时会中止旧的客户端请求并重新读取 run 状态，取消成功或失败对账后都会同步已推进的权威版本，避免“取消后继续执行”、旧版本继续编辑或界面永久停在忙碌状态。
- 自动保存显式追踪正在提交的作品、章节和卷字段；任何并发权威刷新都会合并 `dirty ∪ in-flight` 路径，保存冲突不能先用远端快照覆盖本地内容再只恢复路径名。被保留字段的三方冲突基线和乐观锁版本也会停留在刷新前，直到 409 对账或精确保存成功后再推进，避免旧标签页借用 Workflow 的新 revision 静默覆盖刚采纳的内容。浏览器恢复草稿同样包含正在提交的字段，而精确保存成功响应仍采用服务端规范化结果。Workflow 权威刷新改用单一只读项目/章节快照接口，避免两个独立 GET 组合出不存在的混合版本。

### Security

- Provider 请求使用手工重定向策略，避免跨 Origin 重定向携带自定义密钥头。
- Provider 错误体、JSON、SSE/NDJSON 和最终正文增加传输层大小边界与稳定超限错误。
- 应用启动会先验证顶层数据根；作品主存储、Schema 迁移备份、Provider 密钥，以及 generation history、正式稿版本、检索索引、Copilot、Quality、Workflow sidecar 都会固定初始化时的数据根身份，并在运行时验证规范路径、父目录和链接目标，阻断初始祖先链接、根目录替换、祖先目录替换、junction、符号链接或重解析点把读写引出各自数据根目录。迁移备份根会在 Store 构造时以空目录初始化，未发生迁移时不产生备份内容。
- 角色卡、世界书和 Prompt Profile 的导入、历史资源读取、资源 API 与作品导出统一递归清理明确凭据，包括带 Provider 前后缀、`*_value` 后缀或 Unicode 组合字符的 API key、带语义前缀的 header 容器、Provider/session token、带前缀的 password/passphrase、session cookie、webhook secret、credential，以及带业务前缀的 private/signing/secret/encryption key；嵌入 Character Book 拆分后的角色和 Lorebook 分别记录准确清理路径。Prompt 预设额外清理 URL/endpoint 和账户、项目、区域、部署连接信息，同时保留普通创作 `token`、`secret`、`token_value`、普通 `*_key`、角色/世界书 URL/endpoint 以及 `tokenBudget`、`maxTokens`。
- Provider 非流式错误、流式 HTTP 错误和流内 error 事件统一清除被上游反射的当前 API key，即使同一密钥在错误消息中重复出现也只向浏览器返回 `[REDACTED]`。

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
