# Story Studio 独立版架构（0.7.0 / Schema V5 / Prompt Profile V2 / Retrieval V1 / Workflow V1+V2 / Quality V1）

本文描述 `<repo>` 当前实现的运行方式、数据一致性机制和安全边界。`<repo>` 表示 StoryStudio 仓库根目录。StoryStudio 由 SillyTavern（酒馆）改造、拆分而来，但当前代码已经重构为独立服务；“来源于酒馆”不等于“依赖酒馆运行时”。本文面向后续维护者，事实以当前源码和测试为准。

## 1. 总体结构

Story Studio 是一个本地单进程 Web 应用：Node.js 进程同时提供静态前端、JSON API、文件存储和 OpenAI 兼容 Provider 适配。

```text
浏览器
  |
  | 同源 HTTP + JSON + CSRF
  v
Express 应用
  |-- /                    public/ 静态工作区
  |-- /icons/              lucide-static 本地图标
  |-- /api/bootstrap       启动信息与进程级 CSRF Token
  |-- /api/provider        Provider 配置
  |-- /api/provider/test   Provider 连接测试
  |-- /api/generate        兼容用单次生成入口
  `-- /api/story-studio/   作品、Dashboard、资源、上下文、候选、检索、Workflow/Copilot 与采纳
          |
          v
      data/ 文件存储
```

主要分层如下：

- `server.js`：解析端口和数据目录，固定监听 `127.0.0.1`，处理进程退出信号。
- `src/app.js`：装配 Express、中间件、静态资源、Provider 和作品路由。
- `src/story-studio-router.js`：作品、章节、资源和底层采纳的 HTTP 路由合同。
- `src/story-studio-store.js`：校验、版本控制、文件布局、锁、原子写和恢复。
- `src/generation-router.js`：上下文预览、NDJSON 流、候选历史、蒸馏和采纳路由。
- `src/generation-service.js`：生成上下文快照、预算、Provider 调用和候选状态机。
- `src/generation-store.js`：候选正文、父版本、完成原因、诊断和 ChangeSet 的独立持久化。
- `src/retrieval-index.js`：稳定分块、中文分词、MiniSearch 召回、BM25 风格确定性评分和过滤纯逻辑。
- `src/retrieval-store.js`：派生索引快照、增量差异、异步重建任务、来源哈希和可选 Provider 重排边界。
- `src/workflow-schema.js`：严格 Workflow Definition V1、有限 condition AST、DAG 校验、内置 V1 11 步与 V2 12 步章节闭环及 Definition hash。
- `src/planning-copilot.js`：确定性策划诊断、POV 安全 evidence catalog、缺失章纲建议和候选补丁校验。
- `src/project-dashboard.js`：从权威项目快照确定性投影进度、焦点章节、下一步、章纲过期、伏笔债务和近期章节，不写入第二套状态。
- `src/workflow-authority.js`：章卡、审校和收尾恢复使用的项目/章节不变量摘要与精确版本判定。
- `src/workflow-store.js`：Definition、run、Artifact、command receipt 的 sidecar 布局、状态机、记录哈希与幂等提交。
- `src/workflow-service.js`：把 V1/V2 内置步骤连接到检索、受信模型 intent、生成、蒸馏、采纳、取消、同章 writer 租约和权威版本检查。
- `src/workflow-v2-runtime.js` / `src/workflow-contracts.js`：构造隔离的 V2 模型任务，解析严格输出，并校验方向、计划、正文、UTF-16 审查锚点、定向替换和最终采纳血缘。
- `src/workflow-router.js`：Definition 查询、Copilot 诊断、run 枚举/创建/读取和统一命令入口。
- `src/copilot-schema.js`：独立策划 Copilot 的结构化响应、3 至 6 个互斥方向、设定/Lorebook 候选 Diff 和证据引用校验。
- `src/copilot-store.js` / `src/copilot-service.js` / `src/copilot-router.js`：只读 Copilot 的设置、上下文快照、session/attempt 持久化、NDJSON 生成与取消。
- `src/builtin-writing-profiles.js`：8 套不可原位覆盖的网文 Prompt Profile V2，以及 5 类可选题材 overlay。
- `src/quality-linter.js`：确定性章节质量规则、UTF-16 定位、章纲/卷目标/伏笔覆盖和 POV 知识泄漏检查。
- `src/quality-regression.js` / `src/quality-baseline.js`：固定非用户私稿回归集、Profile 编译矩阵、基线清单与退化门禁。
- `src/quality-store.js` / `src/quality-service.js` / `src/quality-router.js`：质量预览、持久报告、回归运行/比较和 HTTP 合同。
- `src/chapter-version-store.js`：正式稿追加式快照、完整性校验、差异摘要和恢复数据装配。
- `src/provider-store.js`：Provider 普通配置与密钥的持久化及公开视图。
- `src/openai-provider.js`：六种协议的请求适配、非流式调用与 SSE/NDJSON 流解析。
- `public/app.js`：浏览器状态、今日工作台、Copilot/Workflow 交接、自动保存、冲突处理和候选应用。
- `public/dashboard-ui.js`：Dashboard V1 的异步视图状态归约与受限工作区跳转映射。
- `public/volume-ui.js`：卷章树投影、卷/章移动、搜索投影和章纲过期判断等纯函数。
- `public/prompt-engine.js`：角色卡、Persona、世界书、Preset、宏和 instruct 的兼容装配。
- `public/prompt-profile-compiler.js`：Profile V2 变量、条件、顺序、依赖、预算、Messages 与 hash 的纯编译器。
- `public/prompt-profile-ui.js`：V2 编辑草稿、兼容报告、保存前编译和诊断投影的纯 UI 模型。
- `public/context-compiler.js`：按 POV 知识边、故事时间、地点、提及、事件、关系、开放事项和人工覆盖生成安全故事状态与连续性预检。
- `public/core.js`：任务提示词、动态预算、ChangeSet Schema、响应解析和三方合并等纯函数。

默认端口是 `8123`。默认数据根目录由 `server.js` 解析为项目内的 `data/`；可通过 `PORT` 和 `STORY_STUDIO_DATA_ROOT` 覆盖。

### 1.1 Prompt Profile V2 运行链

V2 生成路径是 `compat-import -> prompt-profile-compiler -> core -> generation-service -> provider adapter`。导入器把 SillyTavern prompt/order 转换为受限模块数据，递归移除连接密钥，并只记录脚本/EJS/TavernHelper 告警。编译器不执行字符串代码，只解释结构化条件 DSL，并输出确定性的 `{ messages, generation, profileHash, diagnostics }`。

`prompt-engine` 在 Profile 外层强制加入 StoryStudio runtime contract、V5 连续性预检和当前 task。连续性预检是独立 `system` 模块，必须完整保留，预算不足会阻断请求。缺少 marker 的角色、Persona、世界书、章节与连续性数据进入 managed context；已有 marker 的槽位不重复。Chat Provider 保留消息角色和顺序，Text Completion 才使用 instruct sequence 序列化。

`generation-service` 在任何网络调用前拒绝编译错误，按编译后的任务级 `contextTokens/maxTokens` 重新预算，并把每个参数交给 Provider capability matrix。适配器诊断明确记录 `sentParameters` 和 `droppedParameters`，未知参数不能静默消失。

## 2. 进程与请求路径

`server.js` 只启动一个 HTTP 服务，不启动数据库、队列或后台 Worker。`createApp()` 在进程启动时创建：

1. 一个 `StoryStudioStore`，根目录为 `<dataRoot>/story-studio`；
2. 一个 `ProviderStore`，根目录为 `<dataRoot>`；
3. 一个 `RetrievalStore`，根目录为 `<dataRoot>/retrieval`；
4. 一个 `WorkflowStore`，根目录为 `<dataRoot>/workflows`，以及连接作品、生成、检索和章节版本服务的 `WorkflowService`；
5. 一个 `CopilotStore`，根目录为 `<dataRoot>/copilot`，以及只读的 `CopilotService`；
6. 一个 `QualityStore`，根目录为 `<dataRoot>/quality`，以及确定性 `QualityService`；
7. 一个随机的、仅在本次进程生命周期内有效的 CSRF Token。

作品 API 的主要路径是：

```text
GET    /api/story-studio/projects
POST   /api/story-studio/projects
POST   /api/story-studio/projects/import
GET    /api/story-studio/projects/:projectId
GET    /api/story-studio/projects/:projectId/dashboard
PATCH  /api/story-studio/projects/:projectId
GET    /api/story-studio/projects/:projectId/export
POST   /api/story-studio/projects/:projectId/volumes
PATCH  /api/story-studio/projects/:projectId/volumes/:volumeId
DELETE /api/story-studio/projects/:projectId/volumes/:volumeId
POST   /api/story-studio/projects/:projectId/structure
POST   /api/story-studio/projects/:projectId/chapters
POST   /api/story-studio/projects/:projectId/chapters/reorder
GET    /api/story-studio/projects/:projectId/chapters/:chapterId
PATCH  /api/story-studio/projects/:projectId/chapters/:chapterId
DELETE /api/story-studio/projects/:projectId/chapters/:chapterId
GET    /api/story-studio/projects/:projectId/chapters/:chapterId/versions
GET    /api/story-studio/projects/:projectId/chapters/:chapterId/versions/:versionId
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/versions/:versionId/restore
GET    /api/story-studio/projects/:projectId/resources
POST   /api/story-studio/projects/:projectId/resources/import
PATCH  /api/story-studio/projects/:projectId/resources/activation
GET    /api/story-studio/projects/:projectId/retrieval/status
POST   /api/story-studio/projects/:projectId/retrieval/preview
POST   /api/story-studio/projects/:projectId/retrieval/rebuild
GET    /api/story-studio/projects/:projectId/retrieval/rebuild/:jobId
GET    /api/story-studio/projects/:projectId/resources/:resourceType/:resourceId
PATCH  /api/story-studio/projects/:projectId/resources/:resourceType/:resourceId
DELETE /api/story-studio/projects/:projectId/resources/:resourceType/:resourceId
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/adopt
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/retrieval/preview
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/generation-preview
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/generations/stream
GET    /api/story-studio/projects/:projectId/chapters/:chapterId/generations
GET    /api/story-studio/projects/:projectId/chapters/:chapterId/generations/:generationId
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/generations/:generationId/distill
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/generations/:generationId/adopt
GET    /api/story-studio/workflows/definitions
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/copilot/diagnose
GET    /api/story-studio/projects/:projectId/chapters/:chapterId/workflow-runs
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/workflow-runs
GET    /api/story-studio/projects/:projectId/chapters/:chapterId/workflow-runs/:runId
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/workflow-runs/:runId/commands
GET    /api/copilot/settings
PUT    /api/copilot/settings
POST   /api/copilot/settings/test
POST   /api/story-studio/projects/:projectId/copilot/context-preview
GET    /api/story-studio/projects/:projectId/copilot/sessions
POST   /api/story-studio/projects/:projectId/copilot/sessions
GET    /api/story-studio/projects/:projectId/copilot/sessions/:sessionId
POST   /api/story-studio/projects/:projectId/copilot/sessions/:sessionId/generate
POST   /api/story-studio/projects/:projectId/copilot/sessions/:sessionId/cancel
GET    /api/story-studio/prompt-profiles/builtins
GET    /api/story-studio/prompt-profiles/builtins/:profileId
POST   /api/story-studio/projects/:projectId/prompt-profiles/builtins/:profileId/copies
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/quality-preview
POST   /api/story-studio/projects/:projectId/chapters/:chapterId/quality-reports
GET    /api/story-studio/projects/:projectId/chapters/:chapterId/quality-reports
GET    /api/story-studio/projects/:projectId/chapters/:chapterId/quality-reports/:reportId
GET    /api/story-studio/quality-regression/suite
GET    /api/story-studio/quality-regression/baseline
POST   /api/story-studio/quality-regression/runs
GET    /api/story-studio/quality-regression/runs
GET    /api/story-studio/quality-regression/runs/:runId
POST   /api/story-studio/quality-regression/comparisons
GET    /api/story-studio/quality-regression/comparisons
GET    /api/story-studio/quality-regression/comparisons/:comparisonId
```

路由只负责检查请求信封并调用 Store；字段白名单、长度、资源上限和版本判断由 Store 再次执行。异常最终由 `src/app.js` 统一转换为稳定的 JSON 错误结构。

卷与结构 API 使用显式并发信封：

- 新建卷：`POST .../volumes`，请求为 `{ projectVersion, volume }`；`volume` 只接受 `title/goal/outline/summary`。
- 修改卷：`PATCH .../volumes/:volumeId`，请求为 `{ projectVersion, revision, changes }`；同时校验作品版本和卷修订。
- 删除卷：`DELETE .../volumes/:volumeId`，请求为 `{ projectVersion, revision }`；只允许删除空卷，且项目至少保留一卷。
- 重排卷章：`POST .../structure`，请求为 `{ projectVersion, volumes: [{ id, chapterIds }] }`。包络必须恰好包含当前每个卷和每个章节一次；数组顺序同时定义卷顺序、卷内章顺序和全书章号，不能缺失、重复或混入未知 ID。
- 新建章节：`POST .../chapters` 的 `chapter.volumeId` 可指定目标卷；省略时进入末卷。向非末卷插入时，后续章节在同一目录事务中原子顺延。

## 3. 前端状态模型

`public/index.html` 提供固定 DOM 骨架，`public/app.js` 在浏览器内维护单一状态对象。关键状态包括：

- 当前作品列表、完整作品和当前章节；
- `dashboardProjectId/dashboard/dashboardLoading/dashboardError/dashboardRequestSerial`：只读今日工作台绑定、投影与迟到响应隔离；
- `projectBase`、`chapterBase`：最近一次确认的服务端基线；
- `selectedVolumeId`、`volumeBase`、`volumeDirtyFields`：当前卷纲、最近服务端卷基线及卷字段级改动；
- `projectDirtyPaths`、`chapterDirtyPaths`：本地实际改动的字段路径；
- `projectDirty`、`chapterDirty`：是否存在待保存内容；
- `saveQueue`：串行化所有保存动作；
- `navigationEpoch`：识别切换作品或章节后返回的过期异步结果；
- 当前视图、检查器、移动抽屉、AI 类型和生成状态。
- 独立 Copilot session 与 `copilotHandoffOptionId`，以及章节绑定的 Workflow run/Artifact/authority 状态。

页面不是把整个表单反复覆盖回服务端，而是记录字段级脏路径。例如正文是 `content`，章纲目标的技术路径是 `card.goal`，卷纲字段是 `volume.outline`，连续性条目则转换为 `continuityById.<entryId>.<field>`。这既缩小 PATCH 请求，也为冲突合并提供粒度。

AI 结果先写入章节的 `candidate`，不会直接替换正文、章纲、审校记录或连续性账本。用户执行“应用、插入、追加或替换”后，接受内容才进入对应正式字段。

### 3.1 Schema V4 卷章模型（V5 继续保留）

V4 在原有项目和章节之间增加显式卷层级。核心投影如下：

```text
project.volumes[] = {
  id, number, title, goal, outline, summary,
  revision, createdAt, updatedAt
}

project.chapters[] = {
  id, number, title, status, summary,
  volumeId, planBasis: { volumeRevision },
  wordCount, updatedAt
}

chapter.volumeId
chapter.planBasis = { volumeRevision }
chapter.card       # 技术字段；用户语义为“章纲”
```

存储不变量是：项目至少一卷和一章；`volume.number` 连续；每章恰好属于 `project.volumes[]` 中的一卷；`project.chapters[]` 按卷顺序和卷内顺序形成全书连续章号，同卷章节在目录中保持连续；章节摘要中的 `volumeId/planBasis` 必须与章节文件一致。

`volume.revision` 只在卷纲语义字段发生真实变化时递增，同值 PATCH 是 no-op。`chapter.planBasis.volumeRevision` 表示章纲最后一次确认所依据的卷纲版本：新建章节时取目标卷当前修订，保存 `chapter.card` 时刷新；卷纲更新不会静默重写章纲，因此旧值自然变为待复核；跨卷移动会显式置为 `0`，强制在新卷语境下复核。卷内排序不改变这个依据。

### 3.2 Schema V5 连续性账本

V5 在原有五类 Story State 上增加 `facts/knowledge/timeline`，并扩展来源与时空字段：

```text
facts[]      = { id, summary, subjectEntityId, sourceChapterId, status,
                 supersededById, confidence, tags }
knowledge[]  = { id, entityId, factId, stance, learnedChapterId, status }
timeline[]   = { id, label, storyTime, sequence, chapterId, locationEntityId, status }
```

`knowledge.stance` 仅允许 `knows/suspects/believes/denies/hides`。实体可记录当前位置、当前目标/行动及更新章节；关系分离公开/私下摘要与起始章节；事件关联时间锚、地点、进度和可见范围；伏笔记录类型、紧急度和证据章节；记忆记录状态、取代链、置信度和来源章节。

引用在整个 ChangeSet 合并后统一校验，因此同一原子采纳可以先增加事实再增加知识边，也可以按依赖反序删除完整子图。被取代事实自动成为 `retired`；取代链禁止自指和循环，进入审计链后不能通过普通 ChangeSet 删除或清空链路。

浏览器连续性工作区只读显示权威状态。`facts/knowledge/timeline` 不能经新建项目或普通项目 PATCH 写入，只能由导入/迁移恢复既有权威数据，或通过确认后的 ChangeSet 原子采纳。人工编辑保存在按项目和章节绑定的浏览器本地 pending ChangeSet；确认采纳时对规范化内容计算稳定 SHA-256 generation ID，并通过既有项目/章节原子提交路径写入。网络响应丢失后重试同一 ChangeSet 会命中幂等采纳记录，不会重复记账。

### 3.3 Retrieval V1 可追溯检索

`RetrievalStore` 是派生缓存，不修改 `project.json`、不进入导出包。每个项目的索引位于 `data/retrieval/<project-id>/index.json`，其中保存索引 Schema、作品版本、来源摘要、chunk 快照、稳定索引摘要和上次差异统计。文件缺失、损坏或来源摘要不一致时，Store 从权威作品数据重建。

来源固定为正式章节正文、章节摘要、卷目标/纲要/摘要、已激活 Character/Persona、已激活 Lorebook、V5 `facts` 和 `memory`。候选稿、未激活资源和 Provider 返回内容都不进入索引。每个 chunk 是 JSON 可审计记录：`sourceType/sourceId/chapterId/start/end/hash` 为必有溯源字段，另带卷、人物、章节号、状态、故事时间、事实与 knowledge 元数据。中文按 Han 字符、拉丁词和数字分词；MiniSearch 做本地召回，自有 BM25 风格评分与稳定 tie-break 决定最终次序。

检索先做服务器端确定性过滤，再允许手工包含、BM25 和可选 Provider 重排。带章节上下文的预览强制上限为当前章号，强制使用权威 POV knowledge 边，并按 `learnedChapterId` 裁掉未来知识；任一 `hides`、无知识边、未来 `sourceChapterIds`、退休及被取代事实都会 fail-closed，与受保护事实重叠的 memory 也不能旁路泄漏。调用方提供的筛选字段不能放宽这些边界。手工排除最先执行，重排只能重排已通过过滤的候选；手工包含仅提升已合格 chunk 的次序。Provider 重排使用受限 JSON Schema，只返回现有 hit ID；模型未配置、超时、失败或只返回非法 ID 时自动回退到确定性顺序。

普通预览使用 `POST .../retrieval/preview` 或章节别名 `POST .../chapters/:chapterId/retrieval/preview`，可带 `projectVersion/chapterRevision`、查询、手工包含/排除和收紧筛选；覆盖引用有数量、字段和长度上限。重建支持 `incremental/full`；异步请求返回绑定项目的短生命周期 job ID 和分批进度，任务状态只在进程内保留。增量刷新比较旧/新完整规范化 chunk，正文哈希相同但章号、卷、状态、取代链、来源章、人物或标签变化时仍会更新。持久化文件读取时复算规范化 `indexDigest`，不匹配则丢弃并从权威来源重建；进程内缓存只能复用与该摘要严格匹配的 MiniSearch 实例。

### 3.4 Workflow Definition V1、V2 与同章写租约

Workflow 是 Schema V5 之外的章节级 sidecar，不向 `project.json` 或章节文件增加流程字段。V1 与 V2 共用同一个 Definition Schema：

```text
definition = {
  schemaVersion: 1,
  id, name, description, revision,
  steps: [{ id, title, kind, actor, dependsOn, artifactKind, condition }],
  definitionHash
}
```

Definition 最多 64 步，步骤 ID 唯一，依赖必须存在且形成 DAG。`kind` 使用固定枚举，当前包含 `diagnose/propose/approve/apply/brainstorm/plan/draft/distill/adopt/review/rewrite/human_gate/closeout`；`actor` 只允许 `system/model/user`，Artifact kind 同样使用固定枚举。所有对象拒绝未知字段；标题和描述拒绝 EJS、`${...}`、`{{...}}` 与 `javascript:` 等执行/模板标记。模型步骤必须产生类型化候选 Artifact，不能执行 `apply/adopt/closeout`；`apply/adopt` 必须由 system 执行；`human_gate` 必须由 user 对类型化 Artifact 执行。

`condition` 不是表达式字符串，只能是有限 AST：`always`，逻辑 `all/any/not`，以及 `exists/eq/neq/in`。引用源仅为 `input/run/artifact`，路径为 1 至 8 个安全自有属性段并拒绝 `__proto__/prototype/constructor`；条件最大深度 8、总节点 64，`in` 最多 32 个标量。条件为 false 的 ready 步骤会以确定性内部 command ID 标记为 `skipped`；`skipped` 依赖视为已经终结，因此后继仍能继续。运行时每次只推进 Definition 顺序中的一个满足依赖的步骤，不提供同一 run 内的并行步骤执行。

Definition 去掉 `definitionHash` 后按稳定键序 JSON 计算 SHA-256。已存 Definition 每次读取都会复算摘要；内置 Definition 内容不匹配会以 `workflow_definition_tampered` 阻断。`builtin.chapter-cycle.v1` 保留原有内容与 hash，不在原位升级；新能力由独立 `builtin.chapter-cycle.v2` 提供。Store 虽能保存保留命名空间之外的不可变 Definition，但当前 HTTP 没有 Definition 创建、编辑或上传路由，`WorkflowService` 也只分派这两个内置执行合同，因此它仍是“声明式描述并校验的内置章节闭环”，不是任意代码工作流引擎。

内置 `builtin.chapter-cycle.v1` 是兼容用线性 11 步 DAG：

| 步骤 | actor | Provider | 产生或使用的 Artifact | 权威修改 |
| --- | --- | --- | --- | --- |
| `diagnose` | system | 不需要 | 生成并自动批准 `diagnosis` | 无 |
| `propose-card` | system | 不需要 | 生成 `chapter-card` candidate | 无 |
| `approve-card` | user | 不需要 | 准确绑定并批准前一步候选 | 无 |
| `apply-card` | system | 不需要 | 应用已批准 `chapter-card` | 更新正式章纲 |
| `draft` | model | 需要 | 生成 `chapter-draft` candidate | 无 |
| `distill` | model | 需要 | 从 draft 生成 `state-change-set` candidate | 无 |
| `approve-state` | user | 不需要 | 准确绑定并批准 ChangeSet | 无 |
| `adopt` | system | 不需要新调用 | 应用 ChangeSet，并把 draft 标记 applied | 原子写正文、摘要与 Story State |
| `review` | model | 需要 | 生成 `chapter-review` candidate | 无 |
| `apply-review` | system | 不需要新调用 | 批准并应用审校 candidate | 更新 `review/notes` |
| `closeout` | system | 不需要 | 生成并应用 `closeout` 证据 | 校验后把章节设为 `done` |

内置 `builtin.chapter-cycle.v2` 是 12 步章节生产闭环：

| 步骤 | actor | Provider | Artifact / 约束 | 权威修改 |
| --- | --- | --- | --- | --- |
| `brainstorm` | model | 需要 | 一次生成 3 至 6 个成套 `brainstorm-direction`，每对方向都要解释互斥 | 无 |
| `select-direction` | user | 不需要 | `human_gate` 精确批准一个方向 | 无 |
| `plan` | model | 需要 | `chapter-plan`：4 至 12 拍连续因果链、完整章执行卡与覆盖表；Copilot 方向还必须带 `sourceEventCoverage` | 无 |
| `approve-plan` | user | 不需要 | `human_gate` 批准计划 | 无 |
| `draft` | model | 需要 | 只返回完整正文，形成 `chapter-draft` | 无 |
| `review` | model | 需要 | `chapter-review`：严重度、类别、UTF-16 offset、quote、段落号、证据和覆盖状态 | 无 |
| `approve-review` | user | 不需要 | `human_gate` 同时批准审查结论与允许修复的精确范围 | 无 |
| `rewrite` | model | 条件需要 | 只返回批准范围的 replacement 与完全相同的 issue IDs，形成 `rewrite-diff` | 无 |
| `approve-rewrite` | user | 条件需要 | `human_gate` 批准定向替换 | 无 |
| `distill` | model | 需要 | 从最终正文生成 `chapter-adoption`：摘要、完整章卡、Story State ChangeSet 与血缘摘要 | 无 |
| `approve-adoption` | user | 不需要 | `human_gate` 批准最终采纳包 | 无 |
| `adopt` | system | 不需要新调用 | 复核完整血缘和权威指纹后采纳 | 原子写正文、摘要、章卡与 Story State |

V2 的 `rewrite` 和 `approve-rewrite` 使用同一个 `artifact.rewriteRequired == true` 条件。审查通过时两步都确定性跳过，`distill` 直接消费原 draft；需要修复时，服务端只允许替换审查批准的 `[start,end)`，并重新物化最终正文。方向集合摘要、方向摘要、计划摘要、正文摘要、审查摘要、替换摘要、采纳摘要和 authority fingerprint 构成完整血缘；任一 Artifact、generation、offset、quote、issue IDs 或摘要不一致都 fail-closed。

普通 V2 brainstorm 的模型合同仍只允许每个方向提交 3–8 条 `eventSeeds`。只有服务端从已验证 Copilot Artifact 物化方向时，才通过受信 `materializeTrustedBrainstormPayloads()` 增加 3–12 节点的 `sourceEventChain`，逐项保留 `order/event/characterChoice/directResult/cost`。因此模型不能借普通 brainstorm 伪造 Copilot 来源链。存在该链时，`plan` Prompt 要求把每个源事件按顺序映射到一个或多个已声明 beat，严格输出等长 `sourceEventCoverage[{ sourceOrder, beatIds }]`；缺失、重复顺序、未知 beat 或无源链却提交该字段都会在 Artifact 创建前失败。`draft` 同时消费批准计划和映射并被要求落实全部源事件。普通非 Copilot 路径不增加这两段专用提示，也不产生 `sourceEventCoverage`。

每个模型步骤在 Provider 调用前先创建受信 `workflowGeneration` intent。slot 精确绑定 `projectId/chapterId/runId/stepId/runRevision/kind`，另有 `slotDigest`、`commandDigest` 和 `commandId`；V2 generation 还持久化 `operation/materialsDigest/promptDigest` 等 `workflowV2` prompt binding。相同 slot 和命令可复用已完成结果或共享同进程 Promise，不同命令内容冲突；重启后遗留的 `streaming` 记录标记 failed，新尝试记录 `attempt/retryOf`。V2 禁止 `attach-generation`，只能消费自己预先落盘并与 prompt 绑定的 generation；模型返回的 JSON 在 Artifact 创建前由 `workflow-v2-runtime.js` 和 `workflow-contracts.js` 严格物化，非法输出保留审计记录并把该 generation 标记为失败。

同一章节同时只允许一个状态为 `running/waiting_approval/failed` 的写能力 run。创建第二个 V1/V2 writer 返回 `workflow_active_run_exists`；同一 run 同时只执行一个命令，相同命令共享 Promise，不同命令返回 `workflow_command_in_progress`。`cancel` 命令先以 receipt 把当前步骤和 run 标记为 `cancelled`，再触发该 run 的 `AbortController`。已经完成的权威提交不会回滚；尚未完成的上游调用被终止，已收到候选文本和审计记录按各自状态保留。被取消的 Provider Promise 尚未完全退出时，该操作仍占用同章 writer drain，新 writer 以 `workflow_cancellation_in_progress` 阻断；只有旧操作 finally 清理后才释放租约。

V1 的章纲与连续性 ChangeSet 有独立 user 审批步骤；审校沿用系统应用。V2 的所有关键选择都经过 `human_gate`。两版模型都不直接写权威文件。审批/应用命令必须携带精确 `artifactId + artifactHash`；API 返回的 `bindingHash` 是首选 `artifactHash`，它绑定 Artifact 的不可变身份、目标类型、base、payload、evidence IDs 和 `createdAt`，不随状态转换变化。服务端仍接受与**当前**记录相符的 `recordHash` 兼容旧客户端，但它不能承担跨状态转换重试。

`planning-copilot.js` 仍提供 Workflow 内的确定性诊断：它从当前项目/卷/章、前章、`compileStoryContext()` 的 POV 安全投影和强制 `rerank:false` 的本地检索构造 evidence catalog，再报告缺失章纲字段、卷纲基线过期、POV 未解析、转场、受保护知识与伏笔时点。这个诊断不调用 Provider，也不同于下一节的独立生成式 Copilot。

Workflow HTTP 合同为：

```text
GET  /workflows/definitions
POST /projects/:projectId/chapters/:chapterId/copilot/diagnose
     { projectVersion, chapterRevision, retrieval? }

GET  /projects/:projectId/chapters/:chapterId/workflow-runs
POST /projects/:projectId/chapters/:chapterId/workflow-runs
     { commandId, definitionId, definitionHash?, projectVersion, chapterRevision, input }
GET  /projects/:projectId/chapters/:chapterId/workflow-runs/:runId
POST /projects/:projectId/chapters/:chapterId/workflow-runs/:runId/commands
     { commandId, runRevision, type: "execute" | "attach-generation" | "cancel", payload }
```

`attach-generation` 仅供 V1，可绑定同一项目、章节、kind 和权威版本上的既有合格 generation。普通 payload 只允许 `stepId/artifactId/artifactHash/instruction/contextOverrides/retrieval/generationId`；取消 payload 只允许 `stepId/reason`。run 视图返回完整 `run/definition/artifacts/currentArtifact/authority/operation`，其中 `operation` 区分 `executing` 与取消后的 `draining`。创建 run 同时核对 Definition hash、`project.version` 与 `chapter.revision`，并从 `projectId + chapterId + commandId` 生成稳定 run ID；后续命令使用 `runRevision` 比较交换，审批/应用再绑定 Artifact hash，权威写入必须匹配 run 基线或最近 applied Artifact 记录的版本。

### 3.5 独立只读策划 Copilot

独立 Copilot 使用 `CopilotStore + CopilotService + copilot-router` 保存自己的 session/attempt，不在策划阶段复用 Workflow run，也没有 apply/adopt 路由。它的目标是把作者手选材料送入一个可审计的生成 session，返回只读候选：

1. `context-preview` 在指定 `project.version` 上校验手选卷、章、人物和 Lorebook，按需执行 `rerank:false` 的本地检索；
2. 服务端把项目设定、所选目标、Lorebook 条目和检索命中转换为 evidence catalog，并冻结可编辑目标的 `targetSnapshot`；
3. `contextDigest` 绑定项目/锚点章/卷/章/Lorebook 修订、选择、检索条件、全部 evidence 和目标快照；
4. 创建 session 时作者必须提交 1 至上限范围内的真实 evidence IDs、3 至 6 的方向数、Profile 引用和指令；session 同时冻结 Profile 快照/hash、prompt digest 与 Provider config hash；
5. `generate` 通过 `application/x-ndjson` 依次发送 `meta/delta/done`，错误在已发 header 后作为 `error` 事件；客户端断连和显式 `cancel` 都中止上游请求；
6. 结构化输出必须恰好包含请求数量的互斥方向，每个方向有 3 至 12 个连续事件，并只能引用冻结 evidence ID；
7. `settingEdits` 只能指向所选 project story、卷或章卡允许字段；`lorebookEdits` 只能指向所选 Lorebook，服务端根据 target snapshot 计算 before/after digest 和 Diff；
8. 完成后只保存状态为 `candidate` 的 `planning-bundle` Artifact，没有任何代码路径把这些 Diff 写入作品；
9. ready 且未 stale 的方向可以通过 `{ sessionId, artifactId, optionId }` 交给新建的 Workflow V2 run。服务端重新验证 session、Artifact 摘要、evidence catalog、目标章节和 authority，把全部方向及各自完整 3–12 节点事件链转换为 `brainstorm-direction`，只批准所选项，自动完成 `brainstorm/select-direction` 并停在 `plan`。

Copilot 模型设置只有 `inherit/override` 两种模式：凭据和其他 Provider 参数仍来自主 ProviderStore，override 只替换模型名。内置默认 Profile 是独立的 `builtin.planning-copilot.v1`；也可冻结项目内 Prompt Profile V2。session ID 从 `projectId + commandId` 确定性派生，同内容重试复用，不同内容重用 command ID 会冲突。生成 attempt 保存原始输出、状态、错误、模型、usage 和 finish reason；相同生成命令完成后可幂等重放，同 session 的并发生成共享正在运行的 Promise。

交接复用普通 `POST .../workflow-runs` 合同，但 `input.copilotHandoff` 只接受上述三个 ID。run ID 仍由 `projectId + chapterId + commandId` 确定性派生；浏览器每次新的作者点击生成新的 command ID，只有同一次网络结果不确定的重试或精确重放复用原 ID。handoff V2 在 `run.input` 中只保存来源身份、authority、方向坐标，以及 direction、`sourceEventChain`、evidence 和集合的摘要，不复制完整方向 payload，实际源链保存在 run-scoped Artifact 中。若 run 在方向物化或选择推进之间中断，相同 POST 会验证坐标并继续同一 run：完整 Artifact 集可直接恢复，部分 Artifact 集只从固定 Copilot 来源重建缺项，且 `ensureArtifact()` 保持确定性 ID。已有活动写入 run 时返回 `workflow_active_run_exists`；创建记录后 authority 再变化时，旧 run 保留审计证据但不再物化旧方向。兄弟方向保留为 `candidate`，被点击方向是唯一 `approved`；Copilot 的 setting/Lorebook Diff 不随交接进入权威写入。读取合同刻意分离：`GET .../workflow-runs` 和 `GET .../workflow-runs/:runId` 只报告持久状态，不物化 Artifact、不推进步骤、不取消 stale run；恢复只发生在带 CSRF 的写请求中，标准路径是重放原始幂等 `POST .../workflow-runs` start payload，run command POST 也会先对已存 handoff 做同一恢复对账再校验命令。

独立 Copilot HTTP 合同为：

```text
GET  /api/copilot/settings
PUT  /api/copilot/settings
POST /api/copilot/settings/test

POST /api/story-studio/projects/:projectId/copilot/context-preview
GET  /api/story-studio/projects/:projectId/copilot/sessions
POST /api/story-studio/projects/:projectId/copilot/sessions
GET  /api/story-studio/projects/:projectId/copilot/sessions/:sessionId
POST /api/story-studio/projects/:projectId/copilot/sessions/:sessionId/generate
POST /api/story-studio/projects/:projectId/copilot/sessions/:sessionId/cancel
```

### 3.6 内置网文 Profile 与 Quality V1

`builtin-writing-profiles.js` 提供 8 套不可原位覆盖、可复制为项目资源的 Prompt Profile V2：

| Profile | task |
| --- | --- |
| 网文构思分叉 | `brainstorm` |
| 因果事件链 | `plan` |
| 连载正文 | `draft` |
| 无缝续写 | `draft` |
| 证据定位审查 | `review` |
| 定向修复 | `rewrite` |
| 连续性蒸馏 | `continuity` |
| 只读策划 Copilot | `copilot` |

每套 Profile 都可选择 `none` 或 5 类互斥题材 overlay：升级玄幻、都市异能、悬疑探秘、历史权谋、情感关系。overlay 是受限 `system` 模块，通过 `genreOverlay` 单选变量和 `exclusiveGroup` 编译；内置对象深度冻结，HTTP 只提供 list/get/copy。copy 会生成普通项目 Prompt Profile 资源并记录 `copiedFrom`，不会修改内置源。这个目录是通用配方库；Workflow V2 仍使用自己固定、受信的步骤合同，独立 Copilot 默认使用 `builtin.planning-copilot.v1`，不会把目录中的配方偷偷写入项目。

`QualityService` 的章节质量路径完全确定性，不调用 Provider。它在请求给定的 `project.version + chapter.revision` 上读取当前正文，或读取绑定同一权威版本的 completed/partial/adopted generation；分析前后各复核一次权威版本。`compileStoryContext()` 提供 POV 安全事实、人物、卷目标和待触及伏笔，`quality-linter.js` 运行 14 类规则：重复句首、重复意象、同构段落、描写/对白机械循环、回顾式开头、总结式结尾、下一章预告、时间倒退、称呼漂移、POV 知识泄漏，以及 chapter required/avoid、卷目标和伏笔覆盖。每个 issue 都带稳定 ID、严重度、rule/category、UTF-16 `[start,end)`、quote、段落号、建议和 evidence IDs；报告带 content/report digest、统计、覆盖表和 blocker/major 通过门槛。

`quality-preview` 只返回即时报告；`quality-reports` 把当前章或 generation 来源、权威基线、完整 linter input 和报告保存到 `QualityStore`。Store 以严格字段、路径 ownership、32 MiB 单记录上限、`recordHash` 和 `write-file-atomic` 保护章节报告、回归 run 与 comparison；枚举时损坏记录进入 `corrupt` 列表，不把健康记录一起隐藏。

质量回归使用仓库内固定的非用户私稿 `fixtures/quality-regression-v1.json`。每次 run 同时：

- 对固定 case 运行同一 linter 并核对必有/禁有规则和 blocker/major 上限；
- 编译 8 套 Profile 在 `none + 5 overlay` 下的全部 48 个组合，记录 Profile hash、警告、错误和生成参数；
- 记录 Provider 协议、模型和参数的 `modelBinding` 作为审计元数据；当前回归本身不向模型发请求；
- 汇总 case/profile 通过率及每千内容单位 blocker/major 密度。

`quality-regression-baseline-v1.json` 是套件 revision、suite digest、内置 Profile revision、report digest 和核心指标的固定 manifest。读取基线会按当前实现重跑确定性报告并精确核对 manifest；比较要求相同 suite 和完整 Profile 目录，case/profile 通过率不能下降，blocker/major 密度不能上升，任一 Profile 编译失败也会阻断。HTTP 支持 suite/baseline、run 列表与详情、comparison 列表与详情；CLI 提供：

```powershell
npm run quality:run
npm run quality:check
npm run quality:baseline
```

`quality:run` 持久化一次 run；`quality:check` 同时保存 run 和相对固定基线的 comparison，门禁失败返回进程码 1；`quality:baseline` 必须显式给出 `--write`，原子写入新的 manifest。

Quality Regression V1 当前是短文本、单章、确定性规则的维护门禁：revision 2 固定集包含 10 个公开样例，用来覆盖 14 类 linter 合同，并编译 48 个 Profile/overlay 组合。它没有证明跨章或整卷一致性，没有覆盖 30k/100k 长章性能，也不把真实作者稿的主观文学质量、读者反馈或商业结果归约为已通过的工程门禁。

### 3.7 Dashboard V1 今日工作台

`buildProjectDashboard(project)` 是对已验证项目快照的纯只读投影。它按章节状态和章号选择焦点章节，优先输出过期章纲复核，再依次建议继续修订、继续初稿、开始计划或规划下一章；同时计算总字数/目标进度、章节状态分布、开放和逾期伏笔、活动连续性条目、Story State 数量及最近更新章节。投影只返回展示与跳转所需字段，不保存到项目或 sidecar。

`GET /api/story-studio/projects/:projectId/dashboard` 复用 `StoryStudioStore.getProject()` 的同一权威读取路径，返回带 `dashboardVersion: 1` 的投影。前端进入“今日”时绑定项目 ID 和单调递增的 request serial；切换作品、刷新或重新载入后，旧请求只有在项目 ID 和 serial 仍匹配时才可提交到界面。

`dashboard-ui.js` 只接受白名单顶层工作区：`editor/write`、`bible/settings`、`ledger`、`copilot`、`workflow`、`quality`、`resources`。卡片目标可携带章节、卷和伏笔 ID；跳转前会核对章节/卷仍存在并遵守 pending ChangeSet 导航规则，伏笔目标固定打开连续性账本的 `promises` 视图。没有合法目标的按钮保持禁用。UI 提供 no-project/loading/empty/error/ready 五态、显式刷新/重试，并在 820px/480px 断点下改为单列而不依赖水平溢出。

## 4. 700 ms 自动保存

字段发生变化时，`public/app.js` 会：

1. 更新内存中的作品或章节；
2. 把字段路径加入对应 Dirty Set；
3. 将保存状态改为“待保存”；
4. 重置一个 `700 ms` 定时器。

用户停止输入约 700 ms 后，定时器调用 `enqueueSave()`。`saveQueue` 使用 Promise 链保证同一页面中的保存请求严格串行，避免较早请求晚于较新请求落盘。

保存循环依次处理作品级改动、当前卷纲改动和章节级改动。发请求前会从 Dirty Set 暂时移出本批字段；保存期间产生的新输入会留在集合中，当前请求成功后继续下一轮。因此，正在保存时继续输入不会被成功响应覆盖。

切换作品、切换章节、新建章节、导入、导出和发起 AI 生成之前都会先刷新待保存内容。保存失败时 Dirty Set 仍保留在内存中，页面显示错误；它不是离线持久队列，关闭页面前仍应确认状态为“已保存”。

## 5. 乐观版本与三方合并

服务端维护三级版本：

- `project.version`：作品设置、卷、卷章结构或章节发生真实持久化变化时递增；
- `volume.revision`：卷名、目标、卷纲或卷摘要发生真实变化时递增；
- `chapter.revision`：该章节内容更新或结构位置实际变化时递增。

卷 PATCH/DELETE 同时提交 `projectVersion` 和卷 `revision`，章节 PATCH 同时提交 `projectVersion` 和章节 `revision`。任一值过期，服务端返回 `project_conflict`、`volume_conflict` 或 `chapter_conflict`，不会静默覆盖磁盘数据。`/structure` 以完整卷章投影配合 `projectVersion` 做目录级比较交换。

前端冲突处理使用三方数据：

```text
base   = 本窗口上次确认的服务端版本
remote = 冲突后重新读取的服务端最新版
local  = 本窗口当前内存值
```

`public/core.js` 的 `findConflictingPaths()` 只检查本地 Dirty Set。若某字段的 `remote` 已偏离 `base`，且 `remote` 又不同于 `local`，该字段才是真冲突。不同字段的并发修改会自动合并：以 `remote` 为新底稿，只把本地脏字段覆盖其上。

真正的同字段冲突由用户选择：保留本窗口值，或采用服务端值。卷纲使用独立 `volumeBase` 做同样的三方比较；若正在编辑的卷被另一窗口删除，则 fail-closed，不把本地卷纲覆盖到其他卷。连续性账本先按条目 ID 转成 `continuityById` 视图，因此两端修改不同条目时不会把整个数组互相覆盖。可幂等的字段保存可在忙锁或版本冲突后有界重试；“上移/下移”等相对结构命令不会在冲突后自动重放，而是刷新最新目录并要求用户重试。

## 6. 文件布局与写入一致性

默认布局如下：

```text
data/
  provider.json
  secrets.json
  story-studio/
    projects/
      <project-id>/
        project.json
        chapters/
          <chapter-id>.json
        resources/
          characters/<resource-id>.json
          lorebooks/<resource-id>.json
          prompt-profiles/<resource-id>.json
        .pending-write.json              # 仅事务未完成时存在
        .pending-resource-write.json     # 仅资源事务未完成时存在
        .pending-chapter-operations.json # 仅目录事务未完成时存在
        .pending-schema-migration.json   # 仅 Schema 迁移未完成时存在
      <project-id>.lock/                  # 仅持锁时存在
  migration-backups/
    <project-id>/<transaction-id>/
      manifest.json                       # 路径、字节数与 SHA-256
      snapshot/...                        # 迁移前项目目录的原始字节副本
  generation-history/
    <project-id>/<chapter-id>/<generation-id>.json
  chapter-versions/
    <project-id>/<chapter-id>/r000000000001.json
  retrieval/
    <project-id>/index.json                # 可重建的本地检索派生缓存
  workflows/
    definitions/<definition-id>.json       # 不可变 Definition + definitionHash
    projects/<project-id>/runs/<run-id>/run.json
    projects/<project-id>/runs/<run-id>/artifacts/<artifact-id>.json
    receipts/<command-id>.json              # 全局幂等命令 receipt
  copilot/
    settings.json                            # inherit/override 模型选择
    projects/<project-id>/sessions/<session-id>.json
  quality/
    projects/<project-id>/chapters/<chapter-id>/reports/<report-id>.json
    regression/<suite-id>/runs/<run-id>.json
    regression/<suite-id>/comparisons/<comparison-id>.json
```

`project.json` 保存作品元数据、设定、`volumes[]`、连续性账本和带卷归属的章节摘要索引；每章完整正文、章纲（技术字段 `card`）、候选和审校内容单独保存在章节文件中。拆分的目的，是避免每次正文输入都重写整本书。

固定质量套件和基线不在 `data/` 中，而是随源码位于 `fixtures/quality-regression-v1.json` 与 `fixtures/quality-regression-baseline-v1.json`。`data/copilot` 与 `data/quality` 都是独立审计 sidecar，不进入作品 Schema 或导出包；删除它们不会改变作品权威正文，但会丢失对应 session、质量报告和回归历史。

所有 JSON 单文件写入都通过 `write-file-atomic`：先写同目录临时文件，再以文件系统重命名替换目标。新建作品和导入使用 `.staging-<uuid>` 目录，全部文件写完后再把目录重命名为正式项目目录，避免半个项目出现在列表中。

### 6.1 项目锁

每个项目使用独立锁目录。抢锁依赖 `mkdir` 的原子性；锁内 owner 文件记录随机 Token、PID 和进程实例 ID。持锁期间约每 10 秒刷新一次心跳。

锁超过 30 秒未刷新后才进入过期判断；仍然存活的 owner 会阻止普通接管。锁有 24 小时硬过期上限，导入暂存目录有 7 天硬过期上限。释放锁时还会核对 owner Token，过期持有者不能删除后来者的锁。

项目读取、章节读取、更新和导出都会在项目锁内进行；项目列表只读取各项目摘要，不持有单项目写锁。

### 6.2 跨文件提交日志

Store 对正常写入使用三种 JSON 意图日志，对 Schema 迁移使用第四种日志。每种日志都先完整写入，再发布受影响文件，最后发布目标 `project.json`；只有全部发布完成才删除日志。摘要是对稳定键序 JSON 的 SHA-256，`baseProjectInvariantDigest` 则删除该事务允许修改的项目字段后再计算，用于拒绝日志夹带无关项目字段。

`.pending-write.json` 用于既有单章更新与正文采纳，字段为：

```text
transactionId
baseProjectVersion
baseProjectDigest
baseProjectInvariantDigest
baseChapterIds
baseProjectChapterBytes
baseChapterDigest          # 兼容的新章哨兵为 null
baseChapterBytes           # 兼容的新章哨兵为 0
baseChapterRevision        # 兼容的新章哨兵为 null
baseChapterNumber          # 兼容的新章哨兵为 null
baseChapterCreatedAt       # 兼容的新章哨兵为 null
baseChapterVolumeId        # V4 基线所属卷
baseChapterPlanBasis       # V4 基线卷纲修订依据
project                    # 完整目标项目
chapter                    # 完整目标章节
```

其项目不变量只允许 `chapters`、`chapterBytes`、`storyState`、`version`、`updatedAt` 变化。V4 新章插入统一走 `.pending-chapter-operations.json`；单章日志保留空基线哨兵只是兼容恢复合同。V4 单章写日志还固定所属卷，只允许 `planBasis` 保持基线值或在保存章纲时刷新为当前卷修订；单章 PATCH 不能借日志跨卷。恢复还会核对基础/目标章节 ID 集、章节摘要、修订号、编号、创建时间、聚合字节数和目标项目转换；标题、卷目录、资源等其他项目字段不能随日志变化。

`.pending-resource-write.json` 用于资源导入、覆盖、删除，以及删除资源时同步清理激活引用，字段为：

```text
transactionId
baseProjectVersion
baseProjectDigest
baseProjectInvariantDigest
baseResourceReferences    # 基线 characterIds/lorebookIds/promptProfileIds
baseResources[]           # { type, resourceId, exists, digest, bytes, revision, createdAt }
project                    # 完整目标项目
operations[]              # { operation: write|delete, type, resourceId, resource }
```

删除操作的 `resource` 必须为 `null`；写操作必须携带完整、可校验的目标资源。每个操作必须有且只有一个基线记录：基线存在时要求摘要、字节数、修订号和创建时间，不存在时这些字段使用 `null`/`0` 哨兵。既有资源写入必须把修订号恰好加一、保留创建时间并让更新时间等于事务的项目更新时间；新资源必须从修订 1 开始，创建/更新时间均等于项目更新时间。目标资源索引的增删必须与操作一一对应，目标投影还会重新检查资源数量/字节上限、导出上限以及角色内嵌世界书引用。项目不变量只允许 `resources`、`version`、`updatedAt` 变化。

`.pending-chapter-operations.json` 用于卷章重排、结构插章或删除一章，字段为：

```text
transactionId
baseProjectVersion
baseProjectDigest
baseProjectInvariantDigest
baseChapterIds
baseProjectChapterBytes
baseChapters[]             # V4 另含 volumeId、planBasis
project                    # 完整目标项目
operations[]               # { operation: write|delete, chapterId, chapter }
```

`baseChapters` 必须按基础目录顺序覆盖每一章；结构插章允许额外记录一个 `exists: false` 的新章基线，其他基线均必须存在。写操作携带完整目标章节，删除操作的 `chapter` 必须为 `null`。V4 结构操作可改变卷顺序、章节编号和所属卷；同卷移动保持 `planBasis`，跨卷移动必须把它改为 `{ volumeRevision: 0 }`，新章则使用目标卷当前修订。所有变化都以基础摘要重建并校验，未移动章节必须与基础摘要完全相同。项目不变量只允许 `volumes`、`chapters`、`chapterBytes`、`continuity`、`storyState`、`version`、`updatedAt` 变化。

恢复时，项目态和受影响文件态分别判定：

三类事务的目标 `project.version` 都必须严格等于真实 `baseProjectVersion + 1`；提交阶段从实际基础项目记录该版本，恢复阶段不接受由目标项目反推或自报的跳级基线。

- **base 项目态**：当前 `project.json` 的版本与完整基础摘要匹配；单章日志还要求章节 ID 序列匹配，资源日志要求三类主资源 ID 引用匹配。
- **target 项目态**：当前 `project.json` 与日志中的完整目标项目逐字段相同。
- **branched 项目态**：两者都不匹配。
- **base/target 文件态**：每个受影响文件分别与其基线摘要、字节数或目标完整记录匹配；删除目标态是文件不存在。不可读或两边都不匹配即为 divergent/未知态。

恢复矩阵如下：

| 日志 | base 项目态 | target 项目态 | branched 项目态 | 非法或未知状态 |
| --- | --- | --- | --- | --- |
| 单章 | 章节为 base 或 target 时写入目标章节和目标项目，再删除日志 | 仅当该章精确为 target，且全部章节文件与当前项目索引一致时删除日志 | 仅当该章仍为 base 且当前章节索引自洽时，将日志改名为 `.pending-write.conflict-...json` 隔离；否则阻断 | Schema、摘要、字节或转换元数据非法时报 `invalid_storage`；章节 divergent/不可读时报 `stale_journal`，原日志保留 |
| 资源 | 所有操作文件均非 divergent 时允许 base/target 混合，幂等重放全部操作和目标项目，再删除日志 | 必须所有操作文件均为 target；复检目标资源投影后幂等发布并删除日志 | 仅当所有操作文件均为 base 且当前资源索引自洽时，将日志改名为 `.pending-resource-write.conflict-...json` 隔离；否则阻断 | 非法元数据或目标投影报 `invalid_storage`；divergent/不可读时报 `stale_journal`，原日志保留 |
| 卷章操作 | 所有操作文件均非 divergent 时允许 base/target 混合，幂等重放全部写入/删除和目标项目，再删除日志 | 必须所有操作文件均为 target，且全部章节文件与目标索引一致，才删除日志 | 仅当所有操作文件均为 base 且当前章节索引自洽时，将日志改名为 `.pending-chapter-operations.conflict-...json` 隔离；否则阻断 | 非法元数据或项目转换报 `invalid_storage`；divergent/不可读时报 `stale_journal`，原日志保留 |

`stale_journal` 响应带 `recoveryBlocked: true`。隔离分支保留冲突日志但不覆盖当前分叉项目；除此之外，系统不会猜测或拼接未知状态。因此这里提供的是基于原子文件替换、项目互斥锁、强基线和 fail-closed 重放的本地事务，而不是数据库事务。

当前 Schema 的早期项目可能缺少后来追加的 `chapterBytes`。正常读取会从章节文件重建该值；journal 恢复则不能依赖可能已部分发布的文件，因此使用日志记录的基础字节值，仅对当前 `project.json` 做结构规范化后再比较摘要。这样兼容字段缺失不会被误判为并发分叉，同时未知文件状态仍按上表阻断。

### 6.3 卷章结构事务

卷排序、卷内章排序、跨卷移动、向非末卷插章、章节删除和全量重排使用同一项目锁，并要求请求携带当前 `project.version`；章节删除还要求当前 `chapter.revision`。`/structure` 请求必须恰好包含作品现有的全部卷与章节 ID，不能缺失、重复或混入其他作品的数据。服务端按卷数组和各 `chapterIds` 数组连续编号，仅给结构实际变化的章节增加修订号；卷换序会更新 `number/updatedAt`，但不会伪造卷纲内容修订。

结构操作先写 `.pending-chapter-operations.json` 意图日志，再逐个发布章节文件，最后提交 `project.json`。恢复条件及日志结构见 6.2；`project.json` 始终作为最后的权威提交点。跨卷移动把章纲依据置零，卷内排序不使章纲过期；插章会原子发布新章和所有需要顺延编号的后续章节。删除章节时还会清理故事状态中对该章节的引用；服务端拒绝删除作品的最后一章。卷本身的新增、文本更新和空卷删除只改 `project.json`，仍受项目锁、卷修订和完整卷章布局校验保护。

### 6.4 正式稿版本快照与恢复

`ChapterVersionStore` 把正式章节的标题、状态、章纲、正文、审校和笔记保存为追加式 JSON 快照。快照仍以技术字段 `card` 保存章纲。快照 ID 由章节修订号和完整快照哈希构成，同时单独保留正文哈希；写入先暂存，再以硬链接原子发布，同一修订只有完全相同的可恢复字段才视为幂等。读取会校验路径、结构、正文哈希和完整快照哈希，标题、章纲、正文或备注等任一字段被篡改都会隔离为损坏记录。

系统采用“先快照、后变更”：普通章节 PATCH 在版本基线有效后、正式稿变更前记录 `manual` 快照；AI 采纳在正文与 ChangeSet 原子提交前记录 `adopt` 快照；历史恢复则先记录当前稿的 `restore` 快照，再通过正常章节更新创建一个更高修订。`current` 不是持久快照，而是路由即时读取的权威章节，因此版本页始终先显示当前正式稿，再显示与当前修订不同的历史记录。

恢复仍需同时匹配 `project.version` 和 `chapter.revision`，过期页面不能覆盖新编辑。恢复不会改写旧快照，也不会把章节修订号倒退。目前版本比较提供字段变化以及字数/行数增减摘要，不提供逐行文本 diff；版本目录也不进入作品导出包。已删除章节的快照可能仍保留在数据目录，但当前没有枚举或恢复入口。

### 6.5 Workflow sidecar、幂等与崩溃恢复

Workflow Definition、run、Artifact 和 receipt 都是独立 JSON 记录，并通过 `write-file-atomic` 以 `0o600` 原子替换；Windows 上仅容忍 `chmod` 不可用。路径 ID 有严格字符白名单，所有父路径拒绝符号链接/junction 和根目录越界。Artifact 文件直接位于所属 `projects/<projectId>/runs/<runId>/artifacts/`；读取、转换和路径 API 都要求 `projectId + runId + artifactId` 并复核记录内 ownership，枚举只打开目标 run 的目录，因此其他项目的损坏 Artifact 不会阻断健康项目。Definition 使用 `definitionHash`；run、Artifact、receipt 则各自去掉 `recordHash` 后对稳定键序 JSON 计算 SHA-256。`recordHash` 保护当前完整记录，会随 Artifact 状态和应用目标变化；面向审批/应用 API 的 `bindingHash` 只覆盖 Artifact 不可变身份/base/payload/evidence/createdAt。读取会复算记录摘要并核对路径中的 ID、项目/run/步骤归属和 Definition，不接受仅 JSON 语法正确但语义被改写的文件。

run 记录持久化 Definition ID/hash、章节、状态、单调 `revision`、当前步骤、每步状态/尝试次数/Artifact ID、输入权威基线，以及最近一次已提交命令 `lastCommand`。Artifact 持久化不可变来源、目标类型、base 项目/章节版本、payload、evidence ID 和 `candidate/approved/applied/rejected/superseded` 状态；应用时才记录目标项目版本、章节修订和权威内容摘要。Artifact ID 从包含 `runId` 的完整 identity 派生，因此同一章节和权威快照上的多个 run 不共享文件。receipt 绑定全局唯一 command ID、项目、run、命令类型、期望 revision、完整命令摘要、已提交 revision 和响应。

命令提交的持久化顺序是：先把步骤变化和 `lastCommand` 随 run 原子发布，再写 receipt。若进程在两次写入之间退出，相同 `commandId + runRevision + type + payload` 的重试会从 run 的 `lastCommand` 重建 receipt；同一 command ID 的不同内容会 409。提交任何下一条命令前，Store 还会把当前 `lastCommand` 重建成期望 receipt 并与磁盘对账：缺失时先原子补发，已有 receipt 若在 ownership、摘要、revision、响应或时间戳上不一致则以存储损坏阻断，只有对账成功后才允许覆盖 `lastCommand`。候选 Artifact 在 run 推进前单独落盘；相同的 run-scoped Artifact identity 被再次构造时会复用，identity 相同但内容不同则阻断。

Copilot handoff 的创建中断遵守更窄的读写合同：Workflow 的两个 GET 读取入口只返回磁盘上已经存在的 run/Artifact，不调用 `resumeCopilotHandoff()`。标准恢复方式是客户端重放最初那个认证 `POST .../workflow-runs`；服务端用相同 command ID、request digest、authority 和 V2 坐标验证后，才补齐缺失方向、选择状态、run revision 与 receipt。run command POST 在处理命令前也会先调用已存 handoff 恢复对账。两条 POST 路径都不会重新调用 Provider。这样，页面刷新可以观察中断，但爬虫、预览、轮询或只读 API 不会因为一次 GET 改变持久状态。

V1 的 `draft/distill/review` 与 V2 的 `brainstorm/plan/draft/review/rewrite/distill` 都在调用 Provider 前把可信 `workflowGeneration` intent 写入 generation 记录：slot 绑定项目、章节、run、步骤、run revision 和 kind，另一个摘要绑定 command ID、命令 type 与完整 payload。V2 再保存严格 prompt 的 operation、materials/prompt digest 和权威版本 binding。相同 slot 的可复用 generation 会被重试直接复用；同进程相同命令共享正在运行的 Promise，不同 payload 以 409 阻断。服务重启后遗留的 `streaming` 结果无法证明 Provider 是否完成，因此旧记录保留并标记 failed，新尝试以 `attempt/retryOf` 关联；这个外部结果未知窗口不能承诺 Provider 端严格 exactly-once。`attach-generation` 只对 V1 开放，V2 必须使用自己预写 intent 和 prompt binding 的 generation。

同章写租约和取消状态也属于恢复边界。写能力 Definition 的 active run 只能有一个；同一 run 的 `runOperations` 只能登记一个正在执行的命令。取消先提交 run/step/receipt，再 Abort 上游；因此客户端立即看到 `cancelled` 时，进程内 Provider Promise 可能仍在清理。这个窗口以 `operation.status=draining` 暴露，并继续阻断同章新 writer，直到 Promise 的 `finally` 删除 operation。已提交权威状态不做反向事务；取消只终止尚未完成的调用。若进程在 drain 中退出，内存 operation 自然消失，而持久 run 保持 `cancelled`，遗留 streaming generation 按下一次读取/重试规则转为失败审计记录。

审批/应用存在另一个有意覆盖的恢复窗口：Artifact 可先从 `candidate` 写成 `approved` 或 `applied`，随后 `completeStep()` 才提交 run 和 receipt。若进程在两者之间退出，run 仍停在原步骤、receipt 不存在，而 Artifact 的 `recordHash` 已变化。前端最初提交的稳定 `bindingHash` 仍匹配；同一命令重试会接受已经转换的 Artifact，应用处理器重新核对权威目标/采纳历史，然后只补齐 run 与 receipt。之后再次发送同一命令由 receipt 返回 `replayed: true`，不会重复增加作品版本。旧客户端若首次提交的是 candidate/approved 的 `recordHash`，只能完成当次请求；状态落盘后该值不再匹配，无法覆盖此崩溃恢复窗口。

Workflow 记录之间没有一个覆盖四个目录的总 journal。权威章纲、正文、Story State、审校和状态写入仍由 `StoryStudioStore` 的项目锁/提交日志保护，并在适用时先由 `ChapterVersionStore` 记录 `workflow` 快照；正文与 ChangeSet 的 `adopt` 继续使用生成采纳的跨文件事务。章卡、审校和收尾候选在写入前记录操作专用的 project/chapter 不变量摘要；权威写入后、Artifact/run 标记前中断时，只有版本严格从 base 各增加 1、目标字段摘要匹配且所有非目标语义仍等于基线才允许补齐。no-op 不允许吸收任何版本漂移。已 applied Artifact 还必须与其记录的目标项目版本和章节修订完全相等。采纳恢复额外要求同一 generationHistory 记录、精确正文/摘要/Story State 目标和 `base + 1` 版本；两个采纳 Artifact 分别补齐。任何无关编辑或更晚版本都以 `workflow_authority_changed` fail-closed。

作品导出包是便携内容副本，不是保持身份的完整备份。它不包含 `data/workflows`，导入后会生成新项目 ID，旧项目 run 不能迁接到新项目，应创建新 run。Schema 迁移备份也只快照迁移前项目目录。要保存原 `projectId`、完整审计与重放证据，应停服备份整个 `data` 目录。0.7 没有 run 级反向事务：版本页只能把章纲、正文、审校、备注和章节状态恢复为新的更高修订，不能撤销 `adopt` 写入的 V5 Story State。精确 Workflow 灾难恢复至少必须使用同一时间点的 `story-studio/`、`generation-history/`、`chapter-versions/` 和 `workflows/`；只恢复其中一部分会让旧 run 的版本或目标摘要与权威项目不匹配，并按上述规则阻断。receipt 只能幂等确认已提交命令，不能执行反向事务。

### 6.6 Copilot 与 Quality sidecar 的恢复和防篡改

`CopilotStore` 把设置和每个 session 写成 `0o600` 原子 JSON。路径中的 project/session ID 使用严格白名单，读取时复核记录身份与路径，session/attempt 使用精确字段集合和状态组合。session 没有权威写能力，但其 `requestDigest/contextDigest`、base 版本、所选 evidence、target snapshot、Profile snapshot/hash、prompt digest 和 Provider config hash 会在生成前重新核对；项目后来改变时公开视图标记 `stale`，不会把旧候选伪装成当前结果。进程重启后仍为 `generating`、但内存中没有对应 inflight Promise 的 attempt 会改成 `interrupted`，session 改成失败状态；同一生成 command 已完成时可重放，已失败、取消或中断的 command 不会被当成成功。原始模型输出和错误保留在 attempt 中，结构化 Artifact 只有通过 evidence/目标/差异 Schema 后才进入 `ready`。

`QualityStore` 对章节报告、回归 run 和 comparison 去掉 `recordHash` 后计算稳定 SHA-256；读取会复算摘要、复核 kind、路径 ownership、suite/project/chapter 身份、严格字段和记录大小。根目录、所有父路径和目标文件拒绝符号链接/junction 与越界；写入使用 `write-file-atomic`。列表接口逐条验证，单个损坏文件进入 `corrupt`，读取该记录则 fail-closed。章节报告还绑定项目/章节/卷版本和 content digest；generation 来源必须在分析时仍绑定同一权威版本。固定 baseline manifest 同时绑定 suite revision/digest、内置 Profile revision、report digest 和指标，源码、套件、Profile 或 linter 漂移却未更新基线时以 `quality_baseline_mismatch` 阻断。

作品导出和 Schema 迁移备份都不包含 `copilot/` 与 `quality/`。恢复作品权威内容不依赖这两个目录；恢复完整策划与质量审计历史则必须从同一停服快照一起恢复 `story-studio/`、`copilot/` 和 `quality/`。Copilot session 永远没有可重放的权威采纳动作，Quality comparison 也只是报告门禁；两者都不能被用来覆盖项目版本检查。

## 7. Provider、上下文与生成链路

Provider 普通设置保存在 `provider.json`，API 密钥单独保存在 `secrets.json`。服务端以 `0o600` 模式写入，并在 Windows 上容忍 `chmod` 不可用；密钥仍是本机明文文件，不是系统凭据库。

浏览器读取 Provider 时只得到 `hasApiKey` 和尾部掩码，不会得到原始密钥。更新密钥有三态语义：

- 省略 `apiKey`：仅当新旧 `baseUrl` 属于同一 origin 时保留；
- 字符串：替换密钥；
- `null`：清除密钥。

若 `baseUrl` 的协议、主机或端口发生变化，省略密钥会清除旧密钥，防止旧密钥被发送到新 origin。同 origin 仅改变 API 路径时可以继续使用。连接测试遵守相同解析规则，但测试本身不持久化表单内容。

主生成路径如下：

1. 服务端在 `project.version + chapter.revision` 上读取当前章、前后章、`chapter.volumeId` 指向的当前卷和激活资源；读取结束后再次核对版本，避免拼出混合快照。
2. `context-compiler.js` 先按当前章号和时间锚排除未来记录，再解析 POV 实体。事实只有存在该 POV 的有效 knowledge 边才进入；未知 visibility、私密事件及其专属时间锚、关系私下摘要、已退休/被取代记录均 fail-closed。编译结果同时给出已知/怀疑/误信/否认/隐瞒信息、地点移动、在场人物、未完成行动和伏笔约束。
3. `RetrievalStore` 从同一稳定快照增量刷新本地索引，以当前章号、权威 POV knowledge、事实状态和取代链过滤命中；手工包含/排除在进入 Prompt 前完成，排除不可被重排恢复。
4. `core.js` 构造任务分段：已确认章纲、按 `chapter.volumeId` 精确匹配的当前卷纲、作品总纲、可追溯检索和其他作品设定。剧情规划层级的预算优先级为 **章纲 > 当前卷纲 > 作品总纲**；章纲不因卷纲存在而被替代。
5. `prompt-engine.js` 按固定顺序装配 Prompt Profile、角色卡、Persona、关键词激活的世界书、章节上下文、连续性数据和当前任务。Profile V2 额外注入优先级高于普通 task 的独立连续性预检 `system` 模块，使用 `clipPolicy=error`；实际 compiled module 缺失、截断或内容变化均产生阻断错误。Context Inspector 单列当前卷纲、预检和检索命中诊断。
6. 当前任务不是一个不可解释的大字符串，而是基础任务、当前卷纲、相邻章约束、类型化状态、检索命中、本次附加要求和续写父候选等带权分段。超预算时分段独立首尾裁剪，本次要求与续写父候选优先保留。
7. 输入预算由 Provider 的实际 `contextTokens` 计算。若 Prompt Profile 声明更小的窗口或输出上限，取两者较小值；不足时逐轮压缩低优先级块。
8. Context Inspector 可向预览、生成、重生成、继续生成和蒸馏传递临时 `contextOverrides` 与 `retrieval` 覆盖。实体、待兑现事项和检索片段支持手工包含/排除；排除优先。
9. `generation-service.js` 创建不可变生成 ID，再由 `openai-provider.js` 按协议读取 SSE 或 NDJSON，并把统一 `meta/delta/done/error` NDJSON 发给浏览器。
10. 浏览器停止或断连会中止上游请求；已收到文本以 `partial` 状态保存在候选仓库。
11. `generate/regenerate/continue` 分别创建独立记录，并通过 `parentId` 形成候选树，不覆盖旧稿。
12. 正文候选可进行第二轮结构化蒸馏。蒸馏只保存待确认 ChangeSet，不修改项目或章节。
13. 采纳时一次检查项目/章节版本、实体与章节引用、文件容量和幂等哈希，再通过 `commitProjectAndChapter()` 同时写正文、摘要、故事状态和轻量采纳历史。

旧 `/api/generate` 仍保留给兼容调用和 Provider 测试；浏览器正式创作流程不再使用它。

Provider 输出上限和上下文窗口是两个独立配置。服务端会把请求输出量限制到 `maxTokens`。单次上游请求默认 120 秒超时。启用结构化输出时使用 `response_format.json_schema`；只有上游明确报告不支持时才移除该字段重试。若上游明确要求 `max_completion_tokens`，适配器才从 `max_tokens` 切换。

Provider 请求使用 `redirect: 'manual'`，任何 3xx 都以 `provider_redirect_rejected` 结束，避免 Anthropic/Gemini 等自定义密钥头跟随跨 Origin 重定向。响应读取同时执行 `Content-Length` 预检和实际读取计数；超限会取消 reader，并统一返回 `provider_response_too_large`。当前边界为：

- 流式响应原始总量：16 MiB；
- SSE/NDJSON 单行：8 MiB；
- SSE 单事件：8 MiB；
- 非流 JSON：16 MiB；
- Provider 错误体：64 KiB；
- 最终正文：5,000,000 字符。

关键请求边界包括：

- 普通 API JSON：12 MiB；
- 导入 API JSON：100 MiB；
- generation `prompt` / `systemPrompt`：各自 1,000,000 字符的高位防滥用边界；正常限制来自模型 token 窗口；
- JSON Schema：序列化后 1,000,000 字节；
- Provider `maxTokens`：256 至 200,000；
- Provider `contextTokens`：2,048 至 2,000,000。

## 8. 导入、导出与资源限制

导出格式仍标识为 `sillytavern-story-studio`，当前 Schema Version 为 `5`。这个字符串只用于兼容此前嵌入版内容包，不代表运行时依赖。导出时会重新读取并验证每个卷、章节和资源，重新计算实际字节数，不信任旧元数据。该包包含项目、卷章、Story State 和项目资源；不包含 generation history、正式稿版本、Workflow、Copilot、Quality 或检索 sidecar，导入又会重映射身份，所以它应称为 **portable content clone**。保持原身份的灾难恢复必须使用同一时点的完整 `data` 停服快照。

导入先按源 Schema 的字段能力校验顶层、项目、全部章节与 Story State，再生成新的 ID。V1-V3 输入创建默认第一卷；V4 保留卷章结构并补 V5 状态默认值；V5 保留完整八类状态。旧版本夹带新版本集合或字段会被拒绝，不会借导入绕过 feature gate。随后统一重映射项目、卷、章节、资源、实体引用和 Persona 引用，暂存完整后才原子发布。

磁盘中的 V1-V4 项目在首次进入项目锁时迁移。恢复顺序是普通单章 pending 日志、目录 pending 日志、资源 pending 日志、已有 Schema 迁移日志，最后才创建新迁移；因此 V4 的三类未完成事务会先恢复。V1-V3 仍创建默认卷并升级到 V5；V4 只改变 Schema 标识并补 Story State 默认字段，保留项目/卷/章节版本、时间戳、正文、资源及既有状态字段。

迁移先完整验证源项目、章节和所有资源引用，再在 `data/migration-backups` 下创建原始字节 snapshot 与 SHA-256 manifest。备份根及路径组件拒绝符号链接、Windows junction/reparse point 和越界 realpath；项目自带 `manifest.json` 位于 snapshot 内，不会与控制清单碰撞。备份复核后才持久化 `.pending-schema-migration.json`，其中同时绑定 manifest digest、完整基线和完整 V5 目标；发布顺序固定为逐章、最后 `project.json`。恢复前再次验证备份；未知、分叉、损坏或运行态依赖缺失均保留证据并 fail-closed。

每个项目的主要资源限制是：

- 最多 3,000 章；
- 最多 1,000 卷，且至少保留一卷；
- 单个 `project.json` 最多 5 MiB；
- 单个章节记录最多 10 MiB；
- 完整导入/导出包络最多 100 MiB；
- 聚合章节字节和导出包络都会在写入前检查。

项目缺失旧版 `chapterBytes` 元数据时，读取会从章节文件重建；后续写入再持久化。资源判断同时保留项目元数据和 JSON 包络的空间，不能只用章节摘要里声称的字节数绕过。

## 9. HTTP 安全边界

当前防护以“只供本机浏览器使用”为前提：

- 进程只监听 `127.0.0.1`；
- Host 只接受 `127.0.0.1`、`localhost` 或 `::1`；
- 存在 Origin 时，只接受本地主机名的 HTTP(S) Origin；
- 所有 POST、PUT、PATCH、DELETE API 请求必须是 JSON，并携带进程级 CSRF Token；
- Helmet 设置 CSP、禁止 framing，并关闭技术标识；
- API 响应使用 `Cache-Control: no-store`；
- 项目和章节 ID 有严格字符白名单，不能构造目录穿越；
- 图标来自本地 `lucide-static`，前端不依赖远程脚本。

`GET /api/story-studio/projects/:projectId/dashboard` 是只读 Dashboard V1 投影：它从 `getProject()` 返回的同一权威快照计算进度与下一步，不维护单独的工作台数据库；顶层“今日”界面也只消费该投影并跳转到既有工作区。

该服务没有用户账户和登录系统。本机上能够直接访问回环端口的其他进程仍属于信任边界内。Provider 是服务端主动访问的外部边界；远程 Provider 应使用 HTTPS，密钥文件也应按本机敏感文件管理。

## 10. 与 SillyTavern 的关系

StoryStudio 从 SillyTavern 改造并拆分为独立版，但没有 SillyTavern 运行时依赖：

- `package.json` 只依赖 Express、Helmet、Lucide 静态图标、MiniSearch 和 `write-file-atomic`；
- 源码不导入 SillyTavern 模块，也不调用其 API、事件系统、宏系统或用户管理；
- 默认监听独立端口，使用独立进程；
- 默认只读写 `<repo>/data`，不会扫描父级 SillyTavern 数据目录；
- 前端资源、Provider 设置、密钥和作品存储均由本项目自行提供。

当前兼容面是 Character Card V1/V2/V3 JSON/PNG、World Info / Character Book、instruct/context/sampling/Formatting Bundle 和 `prompts + prompt_order` preset 的受限导入。脚本、EJS、宏和 TavernHelper 表达式不会作为代码执行。当前没有 Character Card、World Info 或 preset 的原生文件导出/损失报告，也没有 SillyTavern 通用插件运行时：`manifest.json` 扩展生命周期、`SillyTavern.getContext()`、`eventSource / event_types`、`extension_settings`、Slash Command、Quick Reply、STscript、`/api/plugins/*`、JavaScript/CSS 注入和 TavernHelper API 都不在实现中。插件目录直接复制过来不会加载；后续只通过版本化 Extension SDK 与有界适配器开放经过审计的能力。

保留的 `sillytavern-story-studio` 仅是 JSON 内容包格式标识，用于导入旧数据。改变这个标识时应采用“导出新标识、导入同时接受旧标识”的迁移方式，避免让已有内容包失效。

## 11. 维护入口与不变量

常见改动应从以下位置进入：

- 新增作品字段：同步修改 `src/story-studio-store.js` 的白名单/规范化、`public/app.js` 的 Dirty Path 和渲染、导入合同及测试。
- 新增 API：在 `src/story-studio-router.js` 或 `src/app.js` 注册，并保留 JSON、CSRF、错误结构和请求上限。
- 修改保存策略：同时检查 `project.version`、`chapter.revision`、Dirty Set、三方合并和 pending-write 恢复。
- 修改卷章结构：同时检查 `project.volumes[]`、`chapter.volumeId`、`planBasis.volumeRevision`、`/structure` 全量投影与 chapter-operations 恢复。
- 修改生成模式：优先在 `public/core.js` 保持纯函数，在 `src/openai-provider.js` 保持服务端边界。
- 修改 Workflow：同时检查 Definition hash、V1 兼容、V2 Artifact 血缘、generation intent、condition skip、receipt 恢复、取消 drain、同章写租约，以及 Copilot handoff 的完整方向集合与唯一批准项。
- 修改独立 Copilot：同时检查 context/target snapshot、evidence ID、Profile/prompt/Provider binding、attempt 恢复、NDJSON 断连取消、“没有 apply/adopt 路由”的只读不变量，以及 handoff 只接受稳定 ID 并重新验证 authority。
- 修改 Dashboard：保持 `buildProjectDashboard()` 纯只读、`dashboardVersion` 显式、迟到响应隔离、目标白名单、伏笔视图定位和移动端无水平溢出。
- 修改内置网文配方：提升 `BUILTIN_WRITING_PROFILE_REVISION`，验证 8 套 Profile 在 `none + 5 overlay` 下的完整编译矩阵，并同步固定质量基线。
- 修改质量规则或回归集：同步检查 UTF-16 定位、权威版本绑定、`recordHash`、suite/baseline digest、HTTP 与 CLI 比较门禁；基线只能通过要求 `--write` 的 baseline CLI 更新，仓库的 `npm run quality:baseline` 已固定传入规范路径。
- 修改存储 Schema：提升 `STORY_STUDIO_SCHEMA_VERSION`，提供明确迁移或兼容读取，不能只改字段形状。

提交前至少运行：

```powershell
npm test
npm run check
npm run docs:check
npm run quality:check
npm audit --omit=dev
npm pack --dry-run --json
```

当前测试分别覆盖 HTTP/Provider 合同、前端纯函数和文件 Store。涉及真实 DOM、焦点、抽屉、下载或浏览器生命周期的改动，还需要桌面与移动视口的浏览器验收。
