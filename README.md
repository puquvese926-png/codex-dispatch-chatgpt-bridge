# Codex Dispatch ChatGPT Bridge

一个面向 Codex 用户的桥接调度 Skill：把临时并行协作、长期 Codex 对话、
Codex → GPT 任务和 GPT → Codex 执行统一成可识别、可授权、可恢复的工作流。

## 产品介绍

当一个任务同时需要 GPT 的创意与分析、Codex 的本地执行、多个临时工作者的
并行验证，以及一个可以长期维护的独立任务时，单纯依赖“当前可见窗口”很容易
串线、误投递或重复执行。

这个 Skill 提供一层明确的路由和安全协议：先判断任务应该交给谁，再固定目标
身份，要求必要授权，记录结果和失败阶段，并在提交状态不确定时优先只读恢复。

它不是一个新的模型，也不是永久后台机器人；它是连接 Codex、ChatGPT 和多个
Codex 任务的协作控制层。

## 能解决什么问题

- 把临时并行工作与固定长期任务分开管理；
- 让 GPT 负责规划、创意和提示词，Codex 负责本地执行与验收；
- 支持 GPT 生图任务的独立会话、参考图校验、产物回收和生命周期记录；
- 在发送前给出明确的串行/实验并行计划、并发数和最坏等待时间；
- 默认使用主 ChatGPT 串行模式，Quick Chat 仅在显式实验开关下启用；
- 支持长时间生图的持久进度检查点和 detached runner，外层等待超时也不会丢失任务状态；
- 使用跨报告路径的全局控制锁，阻止多个进程同时抢占同一个 ChatGPT 主界面；
- 让 GPT 通过严格的 `CODEX_HANDOFF` 把经过用户批准的计划交给 Codex；
- 防止把可见 UI 卡片、最新窗口或模糊任务名称误当成可靠目标；
- 为失败、断连、提交状态不明和恢复过程提供统一处置规则。

完整的产品定位、角色分工、使用场景和预期效果见
[产品介绍](docs/product-overview.md)。

## 全局安装（跨 Codex 对话）

Skill 要跨不同 Codex 对话可用，必须安装到当前用户的全局 Skill 目录：

```powershell
.\scripts\install-global.ps1
.\scripts\verify-global-install.ps1
```

默认安装位置是 `%USERPROFILE%\\.codex\\skills\\dispatch-chatgpt-bridge`，独立
运行时安装到 `%USERPROFILE%\\.codex\\bridge-runtime\\dispatch-chatgpt-bridge`。
安装后，Skill 和运行时都不依附某一个对话或业务项目；`-Root` 与
`CODEX_BRIDGE_ROOT` 只用于显式覆盖独立运行时位置。

详细说明见 [全局安装与版本同步](docs/global-install.md)。
本次项目解耦的原因、架构和验收结果见
[独立 Bridge Runtime 修复报告](docs/standalone-runtime-repair-report.md)。

## 四条路由

| 路由 | 用户术语 | 作用 |
| --- | --- | --- |
| `codex-subagent` | 子智能体 | 临时、有边界的并行 worker，结果回到当前主任务 |
| `codex-conversation` | 子代理 | 固定、长期的 Codex 对话或执行流程，保留独立历史 |
| `codex-to-gpt` | Codex → GPT | 把自包含分析、提示词、写作或生图任务交给 GPT |
| `gpt-to-codex` | GPT → Codex | GPT 提出 handoff，用户批准后由 Codex 执行 |

## 典型效果

```text
GPT 规划 → 用户批准 → Codex 执行 → 测试验收 → 回读结果
参考图 → 提示词拆解 → GPT 生图 → Codex 校验 → 产物归档
主任务 → 临时子智能体并行审查 → 汇总
主任务 → 子代理长期负责文档/发布/专项流程
```

## 目录

- `skills/dispatch-chatgpt-bridge/SKILL.md`：Skill 权威内容；
- `skills/dispatch-chatgpt-bridge/references/`：原生 Codex 契约、GPT 桥接契约、handoff 契约和故障库；
- `skills/dispatch-chatgpt-bridge/scripts/run-bridge.ps1`：桥接动作包装器；
- `docs/dispatch-chatgpt-bridge-guide.md`：使用场景和触发示例；
- `docs/product-overview.md`：面向分享和介绍的产品说明；
- `docs/global-install.md`：跨 Codex 对话的全局安装、更新和校验；
- `scripts/install-global.ps1`：把仓库中的 Skill 安装到当前用户全局目录；
- `scripts/verify-global-install.ps1`：比较 Skill、运行时和全局副本的 SHA-256；
- `windows/scripts/chatgpt-bridge.mjs`：独立桥接运行时；
- `windows/scripts/chatgpt-bridge-product-control.mjs`：路由计划、能力缓存和全局控制锁；
- `windows/scripts/start-chatgpt-bridge.ps1`：验证或启动 Codex loopback CDP 并写入独立状态；
- `windows/tests/standalone-runtime-tests.mjs`：项目解耦、安装和启动回归测试；
- `windows/tests/chatgpt-bridge-product-control-tests.mjs`：产品路由和控制平面回归测试；
- `windows/tests/run-tests.ps1`：独立桥接全量测试入口；
- `windows/tests/native-codex-bridge-skill-tests.mjs`：术语和原生路由回归测试。

本仓库同时维护 Skill、独立运行时、契约、文档和测试，不包含任何皮肤、图片素材或
业务项目代码，也不需要从其他项目借用 `chatgpt-bridge.mjs`。

## 适合谁

- 想让 GPT 和 Codex 分工协作的个人开发者；
- 需要管理多个 Codex 任务的项目负责人；
- 需要把提示词、参考图和生成结果纳入可追溯流程的创作者；
- 需要在“规划—批准—执行—验收”之间保留人工控制的团队。

## 安全边界

所有发送都需要明确授权和精确目标身份；`watch` 与 `resume` 保持只读；`unknown-after-submit` 和 `timeout-after-submit` 不自动重发；不手写或抓取 `<codex_delegation>` 元数据。
