# Security Policy

## Supported versions

| Version | Security updates |
| --- | --- |
| `0.7.x` | Current |
| `< 0.7` | Upgrade to the current release before reporting |

支持范围会随新版本更新，并在本文件和 [`CHANGELOG.md`](./CHANGELOG.md) 中记录。

## Reporting a vulnerability

请优先在 GitHub 仓库的 **Security** 页面使用 **Report a vulnerability** 私密报告入口。

若该入口尚未显示，可创建一条不含复现细节、密钥、私稿或个人信息的简短 issue，请维护者建立私密沟通渠道。完整复现、日志和样本随后通过私密渠道提供。

报告建议包含：

- 受影响版本或提交；
- 影响组件与攻击前提；
- 最小复现步骤；
- 预期行为和实际行为；
- 影响评估；
- 已尝试的缓解方式；
- 可共享的测试 fixture。

维护者目标：

- 7 天内确认收到报告；
- 复核后给出严重度、修复计划或补充证据请求；
- 修复可用后协调披露时间；
- 在 `CHANGELOG.md` 和 release notes 中记录受影响版本及升级方式。

## Sensitive data

安全报告、issue、测试、截图和日志中请移除：

- Provider API 密钥、Authorization、自定义密钥头；
- `data/secrets.json`；
- 未发布小说正文、角色设定和作品导出包；
- 本机用户名、绝对路径和设备标识；
- 第三方服务账户、cookie、token 和私有端点。

如需构造复现，请使用 `TARGET`、`HOST`、`TOKEN` 等占位符和最小化合成作品。

## Security model

StoryStudio 是本地优先的单用户 Web 应用：

- 默认监听 `127.0.0.1`；
- 没有账户、登录和多租户隔离；
- 浏览器与服务端通过同源 JSON API、CSRF token 和严格内容类型通信；
- Provider 密钥保存在服务端数据目录，API 只返回脱敏状态；
- 作品、章节和 Story State 使用版本检查、项目锁、原子写和恢复日志；
- Workflow 模型步骤产生候选 Artifact，权威写入由系统步骤和人工审批完成；
- Prompt Profile 条件使用结构化 DSL，脚本/EJS/TavernHelper 文本不执行。

本机上能访问回环端口或读取 `<data-root>` 的进程处于同一信任边界。StoryStudio 目前按“一个 `<data-root>` 对应一个服务进程”设计；共享目录、多用户主机和远程暴露需要额外隔离。

## Provider boundary

Provider 是服务端主动访问的外部边界：

- 回环地址可用于 LM Studio、Ollama、llama.cpp 等本地服务；
- 非回环 Provider 推荐使用 HTTPS；
- 重定向、超时、错误体、流式事件和最终正文都应保持显式上限；
- 自定义密钥头只发送到用户配置的目标 Origin；
- 上游输出始终按不可信数据解析；
- Provider 返回的结构化内容仍需经过 Schema、引用和版本校验。

## Plugin and preset boundary

StoryStudio 兼容 SillyTavern 角色卡、世界书和 Prompt 预设数据，但当前没有 SillyTavern 通用插件运行时。导入的脚本、EJS、TavernHelper 表达式和未知宏按惰性文本保存并产生兼容告警。

未来 Extension SDK 将使用版本化 manifest、能力权限、项目级存储和 proposal/人工采纳边界。扩展不得直接绕过项目版本、POV 知识边或权威事务。

## Deployment guidance

1. 保持服务绑定回环地址。
2. 将 `<data-root>` 放在仅当前用户可读写的位置。
3. 对 `secrets.json` 和备份目录应用操作系统级最小权限。
4. 远程 Provider 使用 HTTPS，并在保存前测试目标地址。
5. 关键节点停服备份整个 `<data-root>`；作品 JSON 导出不含全部 sidecar 历史。
6. 不要从同步盘同时启动两个 StoryStudio 实例。
7. 不要把实时 `data/`、`logs/`、`.env`、密钥或私稿提交到 Git。
8. 更新依赖后运行全量测试、质量门禁和 `npm audit --omit=dev`。

## Scope priorities

优先级较高的报告包括：

- Provider 密钥或私稿发送到非预期目标；
- 跨项目或跨 run 数据访问；
- 路径越界、符号链接/junction 绕过；
- CSRF、Origin 或内容类型边界绕过；
- 版本检查、原子采纳或恢复日志被绕过；
- Workflow/Copilot/Quality 记录伪造被当作有效权威证据；
- 导入资源触发脚本执行；
- 超大响应、请求或文件导致稳定资源耗尽；
- 备份或迁移在校验失败后继续发布。

单纯的模型幻觉、文风偏好和第三方 Provider 自身故障不属于软件安全漏洞；若它们导致 StoryStudio 的权限、隐私或权威写入边界失效，则属于安全报告范围。
