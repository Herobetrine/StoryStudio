# 长篇工坊（Story Studio）

> [!IMPORTANT]
> **项目来源：** StoryStudio 由 [SillyTavern（酒馆）](https://github.com/SillyTavern/SillyTavern) 改造、拆分而来，继承其创作资源、上下文编排、多候选生成和模型适配思路，并重构为面向中文长篇网文生产的独立工具。它以独立 Node.js 服务、独立 Git 仓库和独立数据目录运行，与用户现有的 SillyTavern 安装及数据保持隔离。
>
> **资源兼容性：** 支持导入 Character Card V1/V2/V3 JSON、带 `chara` 或 `ccv3` 元数据的 PNG 角色卡、SillyTavern World Info / Character Book，以及 instruct、context、采样预设和组合 Formatting Bundle。带 `prompts + prompt_order` 的 Chat Completion 预设会转换为 Prompt Profile V2；纯采样预设进入 Legacy 兼容路径。资源导入后由作者显式激活，详细规则见[“导入与激活创作资源”](#五导入与激活创作资源)。
>
> **插件边界：** 上述兼容是“资源文件导入兼容”，不是 SillyTavern 插件运行时兼容。StoryStudio 当前不加载酒馆扩展目录，也不提供 `SillyTavern.getContext()`、`eventSource / event_types`、`extension_settings`、Slash Command、Quick Reply、STscript、`/api/plugins/*`、JavaScript/CSS 注入或 TavernHelper API；把酒馆插件直接复制进本项目不会运行。

长篇工坊是一套本地优先的中文长篇网文创作工具，默认只监听本机 `127.0.0.1:8123`。

当前应用版本为 **0.7.0**，作品存储格式为 **Schema V5**，Prompt 运行格式为 **Prompt Profile V2**，章节流程同时保留 **Workflow Definition V1/V2**，并提供固定 **Quality Regression V1**。

不配置模型也可以完成作品管理、正文写作、设定维护、类型化故事状态、资源管理、导入导出、本地检索、确定性质量检查、固定回归门禁，以及旧流程中的策划诊断和缺失章纲建议。需要模型的 AI 功能支持 OpenAI Chat、Anthropic Messages、Google Gemini、OpenAI Text Completions、Ollama Generate 与 llama.cpp Completion 六种协议。

## 一、运行要求

- Node.js 20 或更高版本
- Windows、macOS 或 Linux
- AI 功能可选：OpenAI/Anthropic/Gemini API，或 LM Studio、Ollama、llama.cpp、vLLM 等本地服务

## 二、获取与启动

### 克隆仓库

```console
git clone https://github.com/Herobetrine/StoryStudio.git
cd StoryStudio
```

### Windows 推荐方式

在项目根目录打开 PowerShell：

```powershell
.\start-story-studio.ps1
```

脚本会检查 Node.js 版本与依赖完整性。源码仓库或带 lockfile 的发布物使用
`npm ci --omit=dev`；不带 lockfile 的 npm 打包产物使用 `npm install --omit=dev`。
看到服务地址后，在浏览器打开：

[http://127.0.0.1:8123/](http://127.0.0.1:8123/)

如 PowerShell 阻止脚本执行，可只对本次启动放行：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-story-studio.ps1
```

### npm 启动

在项目根目录运行：

```console
npm ci
npm start
```

### 修改端口或数据目录

启动脚本支持参数：

```powershell
.\start-story-studio.ps1 -Port 8125 -DataRoot "$HOME\StoryStudioData"
```

也可以直接设置环境变量：

```powershell
$env:PORT = '8125'
$env:STORY_STUDIO_DATA_ROOT = "$HOME\StoryStudioData"
npm start
```

服务只绑定 `127.0.0.1`，不会向局域网或公网开放。

## 三、第一次使用：项目 → 卷纲 → 章纲 → 正文

1. 点击顶部的“新建作品”，填写作品名与类型。新作品会同时创建第一卷和第一章，不需要先手工搭目录。
2. 打开“设定”，填写一句话卖点、核心命题、主角与欲望、对立力量、世界规则、力量体系、文风约束、总纲和禁写项。这一层定义全书边界。
3. 在同一页的“卷纲”区域选择当前卷，填写卷名、本卷目标、卷纲和卷摘要。左侧文件夹加号可新建下一卷；卷纲区域的上下箭头可调整整卷顺序，空卷可删除。
4. 回到“写作”，在左侧卷章树选择或新建章节。中间顶部的“所属卷”可以把章节移到其他卷；章节编号会按卷顺序和卷内顺序自动连续重排。
5. 打开右侧“章纲”，填写本章摘要、目标、冲突、价值转折、章尾钩子、视角、时间、地点以及必须兑现/避免的内容。也可以在“AI 候选”选择“章纲”，生成结构化候选后点击“应用到章纲”。
6. 在“AI 候选”切换到“正文”，先点搜索图标检查本地检索命中，再用上下文预览确认“当前卷纲”和检索资料已注入；确认内容后采纳、插入或追加到中间的正式正文。
7. 打开“账本”的“连续性工作区”，按事实、人物知识、时间线、关系、伏笔和幕后事件六个视图检查权威状态。权威 JSON 只读；事实、人物知识和时间线也不能经普通项目 API 直接修改。人工修改先进入绑定当前章节的本地待处理 ChangeSet，确认后再通过原子采纳写入。
8. 打开顶部“策划”，手选卷、章节、人物、世界书和检索证据；选择独立 Profile/模型后生成 3–6 个互斥推进方向。设定 Diff 和世界书 Diff 只供复制、导出与人工判断；需要继续生产时，可在方向卡点击“用此方向开始流程”。
9. 打开顶部“流程”，继续由策划方向创建的 V2 运行，或手工选择默认的“网文章节生产闭环 V2”并新建运行。依次完成人工选方向、确认事件链、确认审查范围、确认定向修复和确认最终采纳包；最后一次“应用”才原子写入正文、章纲、审校、状态与 Story State。
10. 打开顶部“质量”，先对当前正文做本地预检；需要长期留档时保存权威版本绑定的报告。这里也可以复制 8 套内置网文 Profile、叠加 5 类题材规则，并运行固定回归集与 baseline 比较。
11. 在“资源”导入角色卡、世界书和 Prompt Profile，再选择哪些资源参与上下文。角色可以单独设为作者 Persona。
12. 内容修改约 700 毫秒后自动保存。顶部状态显示“已保存”后即可刷新或关闭页面。

桌面端采用章节、正文、检查器三栏布局；在手机上，顶部的章节图标和检查器图标会打开左右抽屉。

### 从“今日”工作台开始每天创作

顶部“今日”是当前作品的只读工作台。它直接从同一份权威项目快照计算，不维护第二套待办数据库：

1. 选择作品后打开“今日”，查看总字数、目标进度、章节状态、当前焦点章和系统计算的确定性下一步。
2. “今日工作项”会优先列出继续修订/写作、章纲复核、紧急或逾期伏笔；章纲债务可直接进入对应章节，伏笔债务会打开“账本 → 伏笔”。
3. “开放伏笔”“过期章纲”“Story State”和“近期章节”用于快速检查长期债务与最近改动；带有效目标的卡片可以跳到写作、设定、账本或流程工作区。
4. 点击主操作按钮（例如“打开对应章节”或“复核章纲”）进入下一步；需要完整章节闭环时点击“进入章节流程”。没有有效章节或目标的动作会保持禁用，不会跳到错误位置。
5. 工作台提供刷新、重试、载入、空状态和错误状态。切换作品或章节时，旧请求的迟到响应会被丢弃；它不会覆盖新作品的工作台。

当前 Dashboard V1 只聚合作品、章节、章纲、伏笔与 Story State。今日字数目标、连续更新、存稿、待审批 Workflow、质量 blocker 和发布排期仍属于后续路线图。

### 管理卷章结构

左侧卷章树和“设定”中的卷纲工具共同维护正式目录：

- 卷上移/下移会带着卷内全部章节一起移动；卷内的章节上移/下移只改变该卷内顺序。两者都会按最终卷章顺序重新生成连续的全书章节编号，不改写正文。
- 在非末卷新建章节时，新章插入该卷末尾，后续各卷章节会自动顺延编号。
- 修改“所属卷”会把当前章节移动到目标卷末尾，并显示“章纲待复核”。这是因为旧章纲是在原卷上下文中制定的；复核后修改并保存任一章纲字段，标记才会消失。
- 卷纲内容发生变化后，所有仍基于旧卷纲版本的所属章节也会显示“章纲待复核”；系统不会擅自改写章纲。
- 只能删除空卷，且作品必须保留至少一卷；删除章节前会弹出确认，且作品必须保留至少一章。
- 操作前会先保存当前编辑；卷章结构一旦遇到并发冲突，前端会读取最新目录并取消本次操作，由用户检查后重试，不会在新顺序上自动重放“上移/下移”或静默删除其他窗口刚更新的内容。

当前版本尚未提供已删除章节的恢复入口。需要保留的内容应先复制到其他章节或导出作品备份。

### 查看与恢复正式稿版本

打开右侧检查器的“版本”页，可以查看当前正式稿以及此前的正式稿快照。系统会在下列正式修改发生前保存旧稿：

- 手动编辑正文、标题、状态、章纲、审校或笔记并触发自动保存；
- 采纳 AI 正文与 ChangeSet；
- 从历史版本恢复。

版本详情显示来源、修订号、时间、字数/行数，以及相对当前稿的字段变化和字数/行数增减。选择历史版本后点击“恢复此版本”，系统不会覆盖或删除现有历史，而是先保存当前稿，再以所选内容创建一个新的章节修订。因此恢复后仍可回看恢复前的正文。

这里的“差异”是字段和字数/行数摘要，不是逐行文本 diff。版本历史目前保存在本机数据目录中，不随作品导出包迁移。

## 四、配置 AI 模型

点击右上角的模型设置图标，先选择协议，再填写：

- 接口地址：例如 OpenAI-compatible 的 `http://127.0.0.1:1234/v1` 或 Ollama 的 `http://127.0.0.1:11434`
- 模型：服务端暴露的模型 ID
- API 密钥：本地模型通常可留空，云端接口按服务商要求填写
- 温度、Top P、Top K、停止词、上下文窗口、单次最大输出
- JSON Schema：规划与设定提取需要结构化结果时建议开启

先点击“测试连接”，成功后再“保存设置”。API 密钥只保存在本机服务端的 `data/secrets.json`，保存后不会返回浏览器。

密钥字段的规则：

- 留空：同一接口来源下保留原密钥
- 填入字符串：替换原密钥
- 点击“清除已保存密钥”：删除密钥
- 将接口切换到不同来源（协议、主机或端口变化）：未填写新密钥时自动清除旧密钥，防止误发给新服务

## 五、导入与激活创作资源

打开顶部“资源”页，点击“导入资源”。支持：

- Character Card V1/V2/V3 JSON；
- 带 `chara` 或 `ccv3` 元数据的 PNG 角色卡；
- SillyTavern World Info / Character Book；
- SillyTavern instruct、context、采样预设或组合 Formatting Bundle。

资源导入后不会自动进入 Prompt：

1. 角色勾选“上下文”后才作为故事角色注入。
2. 角色选择“Persona”后作为作者身份注入；Persona 与故事角色激活互不绑定。
3. 世界书勾选“激活”后，内部条目仍需按关键词、常量、位置、扫描深度和预算决定是否命中。
4. Prompt Profile 单选“激活”后，其 Prompt 条目、instruct sequence 和采样参数才应用到生成。
5. 角色卡自带系统指令默认关闭；在资源详情中明确启用后才覆盖基础系统 Prompt。

导入预设中的 endpoint、header、API key 等敏感连接字段会被移除，不会替换模型设置。

### 使用 Prompt Profile V2

带 `prompts + prompt_order` 的 SillyTavern Chat Completion 预设会在导入时转换为 V2 模块；旧式纯采样预设继续走 Legacy 路径，不会被静默改写。选择一个 V2 Profile 后，资源详情提供六个页签：

1. **概览**：修改名称、默认生成参数和 Profile 总预算；
2. **模块**：编辑 `modules[]` 与显式 `order[]`。模块可指定 `system/user/assistant` 角色、数据槽位、启停、条件、依赖、冲突、互斥组及裁剪策略；
3. **变量**：声明 boolean、single、multi、number、text 五类变量及默认值；
4. **任务参数**：维护变量当前值、可复用生成策略和 `draft/plan/review/...` 任务策略；
5. **兼容性**：查看不支持的宏、EJS、脚本字段以及已移除的敏感连接字段；
6. **编译预览**：选择任务、覆盖变量和预算，在保存前查看最终模块、Messages、采样参数、警告、错误和 Profile hash。

保存前会对默认路径及每个任务策略分别编译。只要存在非法条件、悬空依赖、无效变量或未知生成参数，Profile 就不会保存；服务端生成入口还会再次编译，并在调用模型前返回稳定的 `invalid_prompt_profile`。

StoryStudio 运行契约始终是第一条系统消息，当前创作任务始终存在，社区预设不能删除二者。V5 连续性预检使用独立、不可裁剪的系统模块；如果完整预检放不进 Profile 预算，请求会在调用模型前报错，而不是静默丢掉知识边界。预设没有提供角色、Persona、世界书、章节或连续性 marker 时，系统会补一条受管理的上下文消息；预设已经声明的槽位不会重复注入。脚本、EJS 和 TavernHelper 表达式只作为普通文本与兼容告警保存，永不执行。

不同 Provider 对采样参数的支持并不相同。上下文预览中的 Provider Adapter 诊断会区分实际发送和明确丢弃的参数；Chat 协议直接接收有序 Messages，Text Completion 协议按 instruct sequence 确定性序列化。

## 六、AI 生成、停止与候选历史

1. 选择章节并打开右侧“AI 候选”。
2. 选择“章纲”“正文”“审校”或“设定”，可填写本次附加要求。
3. 展开“手工上下文”，可把实体、待兑现事项和检索片段设为“自动”“强制包含”或“排除”。排除始终优先，后续重排不能把片段恢复；这些覆盖只影响当前章节，不会改写权威故事状态。
4. 点搜索图标可以在未配置模型时独立预览检索命中；需要比较候选相关性时，可在“检索片段”下显式开启“模型重排”，失败会保留本地顺序。点眼睛图标打开完整“上下文预览”。这里显示最终 Messages、System/User Prompt、Profile hash、模块取舍、Provider 参数去向、Token 预算、当前卷纲、世界书、检索来源与分数、截断块、故事状态进入原因，以及 POV 知识、时间地点、在场人物、未完成行动和伏笔约束组成的连续性预检。
5. 点击“生成候选”。正文会以流式增量进入候选区。
6. 生成期间同一按钮变为“停止”。停止后已收到文本会以“部分”状态留在候选历史中。
7. 使用历史下拉框切换旧候选；“重新生成”创建兄弟候选，“继续生成”从当前正文候选末尾创建子候选，旧稿不会被覆盖。

Prompt 字符数不再固定限制为 8,000。系统按 Provider 的 `contextTokens` 动态预算；Prompt Profile 若声明更小窗口或输出上限，则取更保守的值。服务端仍保留 1,000,000 字符高位边界以防异常请求。

当任务区本身超出预算时，系统按结构化分段裁剪：本次附加要求和继续生成的父候选具有最高权重，父候选保留首尾；类型化故事状态也保留首尾，避免长设定把真正的本次任务静默挤掉。

在剧情规划层级中，当前 Prompt 的优先级是 **章纲 > 当前卷纲 > 作品总纲**。当前卷纲不是按卷名猜测，而是严格通过当前章节的所属卷关联；上下文预览会单独显示它是否注入、字符数、Token 数和是否被裁剪。章纲为空时仍会明确注入“尚未填写章纲”的提示，不会把卷纲误当成已经确认的本章计划。

### 可追溯检索与分层记忆

StoryStudio 在本机为每个作品维护可重建的 MiniSearch/BM25 风格索引。索引来源仅是正式正文、章摘要、卷目标/纲要/摘要、已激活 Character/Persona、已激活 Lorebook、`facts` 与 `memory`；候选稿和未激活资源不会进入。正文按稳定字符区间分块，每个命中都保留 `sourceType/sourceId/chapterId/start/end/hash`，检查器可以显示进入原因并跳回来源章节。

检索先执行确定性安全过滤，再排名：未来章节、未来才学会的 knowledge、带未来来源章的 memory、退休或已被取代事实会被排除；当前章有 POV 时，只允许该人物有效 knowledge 边可见的事实，任一 `hides`、无法解析 POV 以及与受保护事实重叠的 memory 均 fail-closed。手工包含只提高合格片段的优先级，不能越过这些边界；手工排除在 BM25 和可选 Provider 重排之前生效。请求重排而 Provider 不可用、超时或只返回非法 ID 时，系统保留原确定性顺序，不阻断写作。

索引依据作品、章节和资源的完整规范化 chunk 增量刷新；章节重排、移卷、事实状态、取代链、人物标签等只改元数据的变化也会更新，删除来源会移除旧 chunk。`POST .../retrieval/rebuild` 可执行全量或增量重建，也可返回带进度的异步任务 ID；批量索引会在事件循环间让步。索引是派生缓存，不写入作品 Schema，也不进入导出包；读取时会复算 `indexDigest`，损坏、缺失或摘要不一致时从正式数据自动重建。

## 七、声明式章节流程与策划 Copilot

顶部“流程”把一章从构思推进到可发布状态。0.7 默认使用 `builtin.chapter-cycle.v2`，运行与当前作品、章节、Definition hash 及权威版本绑定，共 12 步：

1. **生成互斥方向（model）**：生成 3–6 个真正互斥的推进方向，每个方向包含主角选择、直接结果、延迟代价、章内承诺和排他理由。
2. **选择创作方向（human gate）**：作者只批准一个方向，后续步骤必须引用该方向的稳定 Artifact 绑定。
3. **生成事件链与章执行卡（model）**：把方向展开为严格因果事件链，并覆盖章纲 `required/avoid`、卷目标和伏笔。若方向来自 Copilot，计划还必须用 `sourceEventCoverage` 把完整 `sourceEventChain` 的每个原始事件按顺序映射到一个或多个合法 plan beat。
4. **确认事件链与章执行卡（human gate）**：人工确认后才允许写正文。
5. **生成正文候选（model）**：只消费已批准计划、POV 安全连续性、Prompt Profile 与可追溯检索证据。
6. **证据定位审查（model）**：每个问题必须绑定正文中的 UTF-16 `start/end`、原文 quote、段落号、严重度、建议和 evidence ID。
7. **确认审查与修复范围（human gate）**：作者决定哪些问题进入修复范围。
8. **定向修复并生成 Diff（model）**：只替换已批准范围，服务端根据原文和替换内容计算完整新正文及 Diff；审查明确无需改写时自动跳过。
9. **确认定向修复（human gate）**：有改写时人工检查替换前后内容；无改写分支与第 8 步一起跳过。
10. **蒸馏连续性与采纳包（model + system）**：模型只从最终候选提取章节摘要和 V5 Story State ChangeSet；服务端再把已批准事件链、最终正文、证据审查、改写血缘、章卡、审校、备注和状态组装成完整采纳包。
11. **确认最终采纳包（human gate）**：最后一次检查所有权威写入字段。
12. **原子采纳章节（system）**：在版本、摘要、血缘和证据全部匹配时，让项目版本与章节修订各前进一次，并同时写入正文、完整章卡、摘要、审校、备注、章节状态与 Story State。

旧 `builtin.chapter-cycle.v1` 仍原样保留，用于重放既有 11 步运行；升级没有改变它的 Definition 内容或 hash。V1 与 V2 的 run、Artifact、模型意图、尝试记录和 command receipt 分别持久化，不能跨项目、章节或运行串接。

### 在界面中运行一章

1. 先选择目标章节并等待顶部显示“已保存”，再打开“流程”。流程页会隐藏写作检查器，保留左侧卷章目录。
2. 在“流程定义”选择“网文章节生产闭环 V2”，点击“新建运行”。运行创建时绑定当前 `project.version`、`chapter.revision` 和 Definition hash。
3. 查看动态 12 步轨道和“当前步骤”。模型/系统步骤使用“执行当前步骤”，人工门使用“审批”，最终 `adopt` 使用“应用”。
4. 每次审批或应用前，在 Artifact 区检查方向、事件链、章执行卡、证据定位审查、定向 Diff 或最终采纳包；“权威版本”同时显示项目、章节、章纲、正文、审校与 Story State 摘要。
5. 浏览器断线或普通服务错误后可点击“重试”，界面会重放原 `commandId + runRevision + payload`；若 Provider 已完成而进程只来不及提交 Workflow，重试会复用已落盘的同一结果。
6. 生成中可以取消。服务端会向 Provider 传播 `AbortSignal`，并在上游真正结束前保持同章 writer 锁；此时第二个写入型流程命令返回 409，避免旧请求在取消后继续落结果。
7. 切换作品或章节时，流程工作区会解除旧绑定并丢弃迟到响应；返回原章节后可从“运行记录”继续尚未完成的运行。

### 独立策划工作台

顶部“策划”不是 Workflow 的快捷壳，而是独立保存上下文与候选的只读 Copilot：

1. 作者显式勾选卷、章节、Story State 人物、世界书和本地检索 evidence；未选择的项目内容不会因为“可能相关”被自动塞入。
2. Context Preview 先固化项目版本、选择集、证据目录和摘要；创建会话时再次核对，过期或伪造 evidence 会在 Provider 调用前阻断。
3. Copilot 有独立 Prompt Profile 与“继承主模型/覆盖模型”设置，不会偷偷激活普通写作 Profile，也不会把密钥写进会话。
4. 模型输出固定为 3–6 个互斥方向、因果事件链、风险/机会，以及惰性的项目设定 Diff 和世界书 Diff。Diff 只能复制或导出；方向可以作为来源受检的构思结果交给 Workflow，但不会直接应用设定或写权威数据。
5. 会话、尝试、流式 NDJSON、错误和取消状态保存在 `data/copilot`；失败/取消后可重试，已完成结果可复制单个方向或导出整份 JSON。
6. Copilot 前后项目版本、章节修订和权威摘要必须相同；若作品在会话期间变化，会话会标记 stale，而不是把旧方案接到新事实上。

### 用 Copilot 方向开始 Workflow

1. 在“策划”中选定当前目标章节，完成上下文预览、创建会话并生成方向。
2. 会话状态为“候选就绪”且没有过期时，每张方向卡会显示“用此方向开始流程”。点击前，StoryStudio 会先保存当前编辑。
3. 服务端只接收 `sessionId + artifactId + optionId`，重新读取并校验会话、候选包、方向、证据目录、项目版本、章节修订和权威摘要；浏览器不会把方向正文伪装成自由输入。
4. 新运行使用内置 Workflow V2：Copilot 的全部兄弟方向会成为 `brainstorm-direction` Artifact，所点方向成为唯一 `approved`，其余方向保留为 `candidate`；`brainstorm` 与“选择创作方向”自动完成，界面直接进入 `plan`。每个方向除 3–8 条摘要化 `eventSeeds` 外，还保留 Copilot 原始 3–12 节点 `sourceEventChain` 的 `order/event/characterChoice/directResult/cost`，不会把长链截成前几项。
5. `plan` 请求会收到完整源链；返回的 `sourceEventCoverage` 必须逐项、按顺序把每个源事件映射到已声明 plan beat。缺项、重复顺序、未知 beat 或普通非 Copilot 方向伪造该字段都会按模型输出错误终止。正文步骤随后同时消费批准计划和该映射，要求落实全部源事件。
6. 成功后页面自动切到“流程”，继续执行事件链、正文、审查、修复、蒸馏与最终采纳。项目/章节已改变、会话过期或当前章已有活动写入流程时，交接会停止并显示原因。
7. 每次作者重新点击交接都会生成新的 command ID；只有同一次网络结果不确定的重试或精确重放复用原 ID。持久化 handoff V2 快照只保存来源 ID、方向坐标和摘要，完整内容保存在 run-scoped Artifact 中；同一 `POST .../workflow-runs` 重放会恢复缺失 Artifact、审批和步骤推进，不再调用 Provider，也不会建立重复 Workflow。对应的 `GET .../workflow-runs` 列表和详情严格只读，只展示中断状态，不以读取请求触发恢复或权威变化。

旧 V1 流程中的确定性策划诊断与缺失章纲建议继续保留，二者不调用 Provider，并继续执行 POV、未来章节、私密状态和本地检索的安全过滤。

Workflow Definition 是严格 JSON 数据，不是脚本运行时：定义最多 64 步，只接受白名单字段和无环依赖；条件仅支持有限 `always/all/any/not/exists/eq/neq/in` AST，数据源限 `input/run/artifact`。字符串表达式、EJS、模板插值、脚本标记、原型路径和模型执行权威写入都会被拒绝。当前 HTTP/UI 只公开读取已安装定义和执行两个内置章节闭环，没有自定义流程编辑或上传入口。

## 八、质量系统与内置网文配方

顶部“质量”提供不依赖模型的确定性检查、可持久化报告和固定回归门禁。

### 内置 Profile 与题材叠层

0.7 内置 8 套不可变 Prompt Profile：

- 网文构思分叉；
- 因果事件链；
- 连载正文；
- 无缝续写；
- 证据定位审查；
- 定向修复；
- 连续性蒸馏；
- 只读策划 Copilot。

每套 Profile 都可以叠加“升级玄幻、都市异能、悬疑探秘、历史权谋、情感关系”之一，也可以保持中性。内置定义本身只读；点击“复制到项目”会通过正式资源事务创建带来源 Profile ID、内置 revision、Profile hash 和 overlay 的可编辑副本。复制需要当前 `project.version`，发生并发变化时不会创建半份资源。

### 章节质量报告

“预检当前章”对浏览器中的当前正文执行即时检查；“保存报告”则重新读取并绑定服务端权威 `project.version + chapter.revision + volume.revision + contentDigest`。持久报告可以来自正式章节，也可以来自仍与当前权威版本匹配的完整生成候选。

每个 issue 都包含稳定 rule ID、严重度、类别、UTF-16 起止位置、原文 quote、段落号、原因、建议和 evidence ID。检查覆盖章纲 `required/avoid`、卷目标、伏笔触达、POV/受保护事实、重复表达、弱开头、段落/句式密度等确定性规则。它不会调用模型给出主观“综合分”，也不会修改正文。

### 固定回归门禁

质量工作台可以运行仓库内固定 regression suite，记录：

- suite/revision、每个 case 与 Profile hash；
- 题材 overlay；
- Provider/模型绑定与参数摘要；
- issue/严重度/规则命中和输出摘要；
- 规范化 `reportDigest`。

候选 run 可与提交的 baseline fixture 或另一个 run 比较。比较结果明确列出缺失/新增 case、Profile 漂移、规则漂移、指标退化和 gate 状态；结果本身也持久化并带防篡改摘要。命令行使用：

```powershell
npm run quality:run
npm run quality:check
```

`quality:baseline` 会重写受版本控制的 baseline，只应在人工确认规则、Profile 和固定用例确实需要升级时使用。

Quality Regression V1 的定位是**短文本、单章、确定性规则维护门禁**。当前固定集用 10 个公开短样例覆盖 14 类规则的阳性合同，并验证 48 个内置 Profile/overlay 编译组合；它不等同于跨章一致性审查、整卷质量判断、30k/100k 长章性能基准，也不代表真实作者稿的主观文学质量或商业表现已经通过验证。

## 九、正文蒸馏与原子采纳

正文候选完成或停止后，可以点击“蒸馏变更”。第二次模型调用只生成待确认 ChangeSet：

- 本章摘要；
- 实体新增或状态变化；
- 关系变化；
- 已发生事件；
- 伏笔、任务或待兑现事项；
- 章节、卷/故事级记忆摘要；
- 可追溯事实与取代关系；
- 人物对事实的已知、怀疑、误信、否认或隐瞒状态；
- 故事时间锚与地点。

蒸馏不会修改正式正文或故事状态。展开 JSON 检查变更后，可选择“采纳正文与变更”“插入光标处”或“追加正文”。采纳时服务端一次检查：

1. 候选生成时的项目版本和章节修订仍然有效；
2. 实体、事实、知识、时间线、关系和章节引用全部存在，取代链没有环；
3. 正文、项目和导出容量仍在限制内；
4. 同一生成 ID 没有被用不同内容重复采纳。

全部通过后，正文、章节摘要、故事状态和采纳记录才通过一个跨文件提交日志写入。任一检查失败，正式数据均不改变。采纳后的状态会进入下一次上下文预览。

## 十、选区工具

在正文中选择一段文字，再在 AI 候选中选择：

- **润色**：保持事实和信息量，修病句、重复与明显 AI 腔；
- **重写**：按“本次要求”重写选区；
- **扩写**：增加动作、选择、反应和有效细节；
- **构思**：给出多个带结果与代价的推进方案，不直接写入正文。

请求只携带选区及前后各约 2,000 字。生成期间若正式正文变化，“替换原选区”会失效，避免用旧基线覆盖新编辑；仍可复制候选后人工合并。

## 十一、建议的长篇创作循环

1. **项目层**：先固定全书命题、人物欲望、规则边界、总纲和禁写项。
2. **卷纲层**：为当前卷确定目标、事件方向、阶段收束和卷摘要。
3. **分叉层**：用只读 Copilot 或 V2 brainstorm 生成 3–6 个互斥方向，人工选择承担得起代价且能推进主线的一条。
4. **章纲层**：把方向展开为因果事件链与章执行卡；看到“章纲待复核”时先处理卷纲变化或跨卷移动带来的偏差。
5. **写作层**：人工写作或按已确认事件链生成正文候选。
6. **审校层**：先检查带原文位置的审查问题，再只批准需要处理的范围并查看定向 Diff。
7. **状态层**：蒸馏最终正文，检查完整章卡、摘要、审校、状态与 Story State，只采纳正文中已经成立的事实。
8. **质量层**：保存权威版本绑定的报告；规则/Profile 或固定用例变化时运行 regression 与 baseline 比较。
9. **备份层**：完成关键章节或一卷后导出 `.story-studio.json` 便携内容副本；需要保持项目身份并保留 sidecar 审计时，停服备份整个 `data`。

## 十二、数据与备份

默认数据目录是项目根目录下的 `data/`。以下以默认目录为例；通过 `-DataRoot` 或 `STORY_STUDIO_DATA_ROOT` 指定其他目录后，最外层就是所指定的数据目录：

```text
data/
  provider.json
  secrets.json
  story-studio/
    projects/<project-id>/project.json
    projects/<project-id>/chapters/<chapter-id>.json
    projects/<project-id>/resources/<type>/<resource-id>.json
  migration-backups/<project-id>/<transaction-id>/manifest.json
  generation-history/<project-id>/<chapter-id>/<generation-id>.json
  chapter-versions/<project-id>/<chapter-id>/r000000000001.json
  retrieval/<project-id>/index.json
  workflows/
    definitions/<definition-id>.json
    projects/<project-id>/runs/<run-id>/run.json
    projects/<project-id>/runs/<run-id>/artifacts/<artifact-id>.json
    receipts/<command-id>.json
  copilot/
    settings.json
    projects/<project-id>/sessions/<session-id>.json
  quality/
    projects/<project-id>/chapters/<chapter-id>/reports/<report-id>.json
    regression/<suite-id>/runs/<run-id>.json
    regression/<suite-id>/comparisons/<comparison-id>.json
```

每章、资源、候选和正式稿历史分别存储，写入采用原子发布；项目锁带所有者令牌与心跳；项目、章节、目录或资源的跨文件更新中断时可通过提交日志恢复。日志恢复采用 fail-closed：只有当前项目和受影响文件能由摘要、字节数、版本及索引证明为事务基线态或目标态时，系统才会重放或清理日志。若项目已分叉，系统不会覆盖新数据；仅当受影响文件仍全部处于可证明的基线态且当前索引自洽时，才把日志改名为 `*.conflict-...json` 隔离保留。若受影响文件内容未知、已分叉或不可读，或日志元数据不可信，恢复会以 `stale_journal` 或 `invalid_storage` 阻断，并保留待检查日志。正式稿历史是本机追加式记录，恢复会创建新修订而不是改写旧快照。单个项目最多 3,000 章，章节与导出聚合数据上限为 100 MiB。

Workflow 是作品 Schema 之外的本机 sidecar。Definition 使用内容 SHA-256；run、Artifact 和 command receipt 各自带随整条记录变化的 `recordHash`，并以原子文件替换写入。Artifact 物理归属于 `project/run`，读取、状态转换和枚举都必须同时携带并核对 `projectId + runId + artifactId`；一个项目或 run 的损坏记录不会进入另一个 run 的枚举。API 还为 Artifact 返回稳定 `bindingHash`：它绑定 ID、项目/run/步骤、kind/source、不可变目标类型与章节、base、payload、evidence 和创建时间，不包含状态、修订或应用结果，所以 `candidate -> approved -> applied` 不会改变它。前端审批/应用优先提交 `bindingHash`；服务端只为旧客户端兼容当前记录的 `recordHash`，它在第一次状态转换后即变化，不能用于跨崩溃重试。

权威写入前仍走作品锁、版本检查、既有提交日志与正式稿快照；工作流记录本身不是跨四个目录的数据库事务。命令先把 `lastCommand` 随 run 原子写入，再发布 receipt；若进程恰在两者之间退出，使用完全相同的命令重试会从 `lastCommand` 重建 receipt。任何后续命令覆盖 `lastCommand` 前也必须先核对上一条 receipt：缺失则从 run 精确补发，已有记录与 `lastCommand` 任一字段不一致则 fail-closed，因而崩溃窗口不会被下一条成功命令掩盖。审批或应用还可能先把 Artifact 状态落盘、随后才提交 run 与 receipt；原命令携带同一 `bindingHash` 重试时只会在版本严格前进一次、目标内容匹配且所有无关项目/章节字段仍等于基线时补齐步骤与 receipt。no-op 或已 applied Artifact 也不接受后来的版本漂移，不能把其他窗口的编辑顺手吸收到当前 run。

正文和审校模型步骤会在 Provider 调用前把 run/step/revision/kind 槽位与命令 payload 摘要写入 generation intent。若模型结果已经完整落盘、但 Artifact 或 run 尚未提交，原命令重试会复用同一 generation，不会再次调用 Provider；同进程并发的同命令共享调用，不同 payload 被 409 阻断。若服务在 generation 仍为 `streaming` 时退出，本机无法判断远端最终是否完成，因此会保留并标记旧尝试，再以 `attempt/retryOf` 开始一次可审计重试。

Copilot 和质量记录同样是作品 Schema 之外的本机 sidecar。Copilot session 保存固定上下文摘要、手选 evidence、Provider/Profile 绑定、尝试链和只读候选；进程重启时会把无法证明已完成的 Provider 窗口恢复为可重试的 `interrupted`。质量报告、regression run 和 comparison 带规范化内容摘要，读取时复算；损坏或被改写的记录会从健康列表中隔离并报告，不会当作有效结果继续使用。

当前作品与导出格式使用 **Schema V5**。V4 的卷章关联保持不变：

- `project.volumes[]`：按顺序保存卷名、目标、卷纲、卷摘要及独立 `revision`；
- `chapter.volumeId`：章节所属卷 ID，项目中的章节摘要索引也保存同一字段；
- `chapter.planBasis.volumeRevision`：该章纲最后一次确认时所依据的卷纲修订号；它与当前卷 `revision` 不同即显示“章纲待复核”；
- `chapter.card`：章纲的技术存储字段名。界面和用户文档统一称“章纲”，保留 `card` 只是为了兼容既有数据与 API。

V5 在 `project.storyState` 中保留原有 `entities/relations/events/promises/memory`，并新增：

- `facts`：带来源章节、置信度、状态和 `supersededById` 的可追溯事实；被取代事实保留为 `retired`，不能从 ChangeSet 中抹掉审计链；
- `knowledge`：人物到事实的知识边，`stance` 只能是 `knows/suspects/believes/denies/hides`；
- `timeline`：故事时间、顺序、章节和地点锚。

关系公开/私下摘要、事件可见范围、人物当前地点与行动、伏笔紧急度及证据章节也进入规范化状态。生成前按当前章 POV 和章节时序做 fail-closed 投影：没有有效知识边的事实、未来才获得的信息、未知可见范围和幕后私密事件不会进入普通生成上下文。

### 便携内容副本

点击“导出作品”，将 `.story-studio.json` 保存到实时数据目录以外的位置，例如另一个磁盘或同步盘。该文件是用于迁移、分享或复制作品内容的 **portable content clone**，不是保持原项目身份的完整灾难恢复包。

作品导出包包含项目、卷章、Schema V5 Story State 和项目资源；导入时会创建新项目身份并重映射项目、卷、章、资源及内部引用 ID。它不包含 `data/workflows`、`data/copilot`、`data/quality`、generation history、正式稿版本历史或可重建检索索引。只导入该包会得到一个内容等价的新项目，应为它新建 Workflow run 和 Copilot 会话，不能把旧项目 sidecar 直接接到新项目上。

### 保持身份的完整备份

需要保留原 `projectId`、Workflow/Copilot/Quality 血缘、候选、正式稿版本、receipt 和恢复证据时，应停止服务并在同一时间点备份整个 `data` 目录。恢复时也应整体恢复这份停服快照；只拼接其中几个 sidecar 目录会造成版本或摘要不一致，并按 fail-closed 合同阻断。当前 UI 没有创建或还原这种 identity-preserving full backup 的一键向导。

### 恢复或迁移

点击“导入作品”并选择导出文件。原先嵌入酒馆版 Story Studio 导出的同格式文件也可直接导入。导入会创建独立项目，不会扫描或改写酒馆数据目录。

V1、V2、V3、V4 导出包仍可导入 V5。V1-V3 会创建默认第一卷并按源版本保留资源与故事状态；V4 保留现有卷章结构和五类故事状态，再补 V5 默认字段与三个空集合。导入严格按源 Schema 的字段能力校验，旧版本不能夹带 V5 字段。所有版本都会重映射项目、卷、章节和资源 ID，避免与现有数据冲突。

磁盘中已有的 V1-V4 项目会在首次受锁访问时迁移到 V5。服务端先恢复旧的 pending 写入/目录/资源日志并验证全部资源文件；随后在 `data/migration-backups/<project-id>/<transaction-id>/` 创建整项目原始字节副本和 SHA-256 manifest，复核成功后才写 `.pending-schema-migration.json`。迁移按“章节先发布、`project.json` 最后发布”执行；中断后只有能由 journal、备份摘要和当前文件证明的状态才会恢复。损坏 journal、损坏备份、缺失资源或路径重解析点都会 fail-closed，并保留恢复证据。

回滚 V5 时必须停止服务，再用某个 `<transaction-id>/snapshot/` 的内容整体替换对应项目目录；不要把 transaction 根目录的控制 `manifest.json` 复制进项目。旧版程序不能直接读取 V5。自动迁移备份不代替日常导出，重要节点仍应另存完整 `data` 目录或作品导出包。

0.7 没有“一键撤销整个 run”。只需撤回章纲、正文、审校或章节状态时，可在“版本”页把章节恢复为新的更高修订；这不会倒退或改写旧快照，也**不会**撤销 `adopt` 已写入的 V5 Story State。需要精确回到运行前的正文与账本时，必须停服并恢复同一时间点的 `story-studio/`、`generation-history/`、`chapter-versions/` 与 `workflows/`；否则旧 run 的版本和摘要会与权威项目不一致并 fail-closed。Workflow receipt 只能重放已提交命令，不能把作品状态反向回滚；Schema 迁移备份也只覆盖迁移前项目目录，不是 Workflow/Copilot/Quality sidecar 备份。

## 十三、多窗口与冲突

作品、卷和章节分别使用 `project.version`、`volume.revision` 与 `chapter.revision`。两个浏览器窗口同时编辑同一内容时，服务端会拒绝过期版本；前端对作品、卷纲和章节尝试按字段进行三方合并，无法无损合并的同字段修改会明确显示冲突，不会静默覆盖。

为减少冲突，建议同一时间只在一个窗口编辑同一章。

## 十四、常见问题

### 页面打不开

确认启动窗口仍在运行，并访问脚本显示的实际端口。端口占用时可改用：

```powershell
.\start-story-studio.ps1 -Port 8125
```

### 提示“Configure a model before generating.”

尚未填写模型 ID。打开模型设置，填写接口地址和模型后测试连接。

### 测试连接失败

依次检查模型服务是否已启动、接口地址是否包含正确的 `/v1` 路径、模型 ID 是否准确，以及云端密钥是否有效。

### 手写功能能否离线使用

可以。除 AI 生成外，写作、自动保存、设定、账本、导入导出、本地检索、章节质量预检、质量报告和固定 regression 都只在本机运行；V1 流程中的策划诊断和缺失章纲建议也不调用模型。独立 Copilot 生成与 V2 的构思、计划、正文、审查、改写和蒸馏步骤需要 Provider。

### 为什么流程停在构思、计划、正文、审查、改写或蒸馏步骤

这些 V2 步骤由模型执行。先确认 Provider 已保存并通过连接测试，再重试当前步骤。旧 V1 的策划诊断和章纲建议成功不代表模型已配置，因为它们是本地确定性逻辑。若错误是 409，先检查刷新后的运行修订、同章 writer 状态和权威摘要；系统不会用旧候选覆盖其他窗口的新编辑。

### 如何彻底迁移数据

停止服务后复制整个 `data` 目录，或为每部作品分别导出。不要在服务运行并正在保存时直接移动实时数据目录。

### 为什么候选显示“已过期”或无法采纳

候选生成后，正式章节或项目上下文发生了变化。旧候选仍保留在历史中，但不能用原子替换覆盖新稿。重新生成，或复制旧候选后人工合并。

### 为什么显示“章纲待复核”

当前章纲记录的卷纲修订号与所属卷的最新修订号不同，或者章节刚从其他卷移动过来。先对照最新卷纲复核本章目标、冲突、转折、钩子和必须兑现项；修改并保存任一章纲字段后，系统会把 `planBasis.volumeRevision` 更新为当前卷纲修订号并清除提示。

### 世界书已激活但没有进入 Prompt

打开“上下文预览”，检查条目是否命中关键词、是否被预算跳过，以及扫描文本中是否出现触发词。激活世界书只是允许扫描，不等于全量注入。

## 十五、验证与开发

在项目根目录运行：

```console
npm test
npm run check
npm run docs:check
npm run quality:check
npm audit --omit=dev
npm pack --dry-run --json
```

目录结构：

```text
public/       浏览器工作区
src/          本地 API、模型适配器、检索与文件存储
tests/        Node.js 测试
server.js     仅本机监听的服务入口
```

底层架构、保存协议和安全边界见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，视觉规范见 [`DESIGN.md`](./DESIGN.md)。

项目治理与后续计划：

- [`ROADMAP.md`](./ROADMAP.md)：0.8 至 1.1 分阶段升级计划与验收标准；
- [`CHANGELOG.md`](./CHANGELOG.md)：版本变化；
- [`SECURITY.md`](./SECURITY.md)：安全边界与报告方式；
- [`CONTRIBUTING.md`](./CONTRIBUTING.md)：开发、测试和提交规范。

## 十六、安全说明

- 仅接受本机 Host 与 Origin。
- JSON 修改请求必须携带当前进程生成的 CSRF 令牌。
- 模型请求由本地服务端发出，密钥不暴露给前端页面。
- `data/`、密钥、日志、依赖目录以及本地研究/验收材料均排除在 Git 之外。
- 导出文件包含作品内容，应按创作原稿进行保管。

## 十七、与 SillyTavern 的设计来源和兼容边界

StoryStudio 参考 SillyTavern 的下列能力，并改造成面向长篇小说生产的语义与工作流：

- 多 Provider、采样参数、流式生成和网络中止；
- swipes 思路对应的多候选、重新生成、继续生成和历史恢复；
- Prompt Manager / instruct / context preset 对应的 Prompt Profile；
- World Info 的关键词、常量、位置、深度、顺序和预算激活；
- Character Card、Persona、角色系统指令覆盖与白名单宏；
- 由上下文管理思路演化出的 POV 知识边、时间线预检和可解释注入诊断；
- 最终 Prompt、Messages 与上下文预算预览。

资源兼容层聚焦角色卡、世界书和 Prompt 预设的**导入**。当前还没有 Character Card、World Info / Character Book 或 SillyTavern preset 的原生文件导出与往返损失报告；PNG 导入也不会持久化原始像素以保证逐字节回导。SillyTavern 的聊天消息数据库、群聊、角色扮演楼层及通用插件运行时未包含在该工具中；对应创作需求由小说专用的项目、卷纲、章纲、正式正文、事实、人物知识、时间线、实体关系、事件、待兑现项、记忆、候选 ChangeSet 和原子采纳承接。

公开仓库只保留实现、用户文档、兼容合同和产品路线。开发过程中的工具比较、采集分析、内部验收与恢复检查点统一保存在本地忽略目录中，不进入 Git 历史或发布包。

## 许可证

AGPL-3.0-only，详见 `LICENSE`。
