# 独立 Bridge Runtime 修复报告

## 结论

`dispatch-chatgpt-bridge` 已从“全局 Skill + 项目私有运行时”改为“全局 Skill +
独立运行时”。默认执行不再需要 Dream Skin 或其他业务项目，也不会从当前工作目录
或旧 worktree 自动选择 `chatgpt-bridge.mjs`。

## 原问题

旧架构只把 Skill 放到了全局目录，真正的 `chatgpt-bridge.mjs` 仍位于业务项目。
包装器还保留项目专用环境变量和祖先目录搜索。因此：

- 在不同项目或 worktree 中运行时，实际加载的 runtime 版本可能不同；
- `discover` / `probe` 可以连接成功，但连接到的是不兼容的旧协议；
- 使用者会误以为桥接与业务项目绑定；
- Git 仓库不能独立安装并运行完整桥接。

## 新架构

```text
Git 仓库
├── skills/dispatch-chatgpt-bridge
├── windows/scripts/chatgpt-bridge.mjs
├── windows/scripts/start-chatgpt-bridge.ps1
└── windows/tests
        ↓ install-global.ps1
全局 Skill
%USERPROFILE%\.codex\skills\dispatch-chatgpt-bridge
        ↓
独立 Runtime
%USERPROFILE%\.codex\bridge-runtime\dispatch-chatgpt-bridge
        ↓
独立状态
%LOCALAPPDATA%\CodexChatGPTBridge\state.json
```

业务项目只负责准备提示词、参考文件和验收结果，不再提供桥接运行时。

## 主要修复

1. 将桥接核心、生命周期模块和 handoff 模块纳入独立 Git 仓库。
2. 全局安装器同时部署 Skill 与 Runtime，并逐文件校验 SHA-256。
3. 包装器只按以下顺序解析运行时：
   - 显式 `-Root`；
   - `CODEX_BRIDGE_ROOT`；
   - 已安装的独立 Runtime；
   - 当前仓库内的 Runtime（仅开发使用）。
4. 删除项目专用环境变量和祖先目录自动搜索。
5. 使用 `%LOCALAPPDATA%\CodexChatGPTBridge\state.json` 保存通用状态。
6. 增加独立启动器，可复用受验证的现有 Codex CDP 端点；需要重启时必须显式
   使用 `-RestartExisting`。
7. PowerShell 7 调用启动器时，自动转交 Windows PowerShell 5.1 处理 `Appx`，
   并保留参数与退出码。
8. 更新调用方说明、handoff 合同和故障手册。
9. 将 `-RestartExisting` 改为持久化 detached restart handoff：先写重启请求与
   `restart-report.json`，再由 Windows 进程服务创建独立 worker，避免当前 Codex
   被关闭时把负责重启的 PowerShell 子进程一并中断。
10. 增加 ready→ack 协议：worker 先以无 BOM UTF-8 写出 `worker-ready`，父进程
    严格核验 operationId、最终 PID、受控状态目录和 deadline 后写入一次性 ack；
    worker 在真正 `stopping-existing` 前再次核验。无 ack、过期、损坏或路径重绑定
    只会留下 `failed`/恢复提示，不会关闭 Codex。CIM 创建成功但未能归属时不宣布
    成功，也不授权自动重试；PowerShell 入口使用绝对 Windows PowerShell 5.1 路径。

## P1.0 跨电脑适配补充

启动器现在将端口选择分为四种可审计原因：`explicit`、`existing-verified`、
`preferred` 和 `scanned`。没有显式端口时只检查当前已验证 Codex 的唯一调试端口，
或在 loopback `9335..9399` 中做真实可绑定性扫描；多端口、未验证监听和全部占用
都会停止。`portSelection` 只在启动结果中返回，持久 schema-v1 state 只保存
权威 `port`，因此旧 runtime 的 state 校验仍兼容。

发现先读取当前 Store 包身份和版本。升级导致的版本变化会分类为
`stale-after-update`，带有有界 saved/current version 和
`start-chatgpt-bridge.ps1` 修复命令；同版本的 package family、安装根、签名和
监听进程变化不会被放宽。成功的 discover/probe/plan 会带
`versionCompatibility`；未知版本不调用未知 Quick Chat RPC，而是保持主 ChatGPT
串行路径。端口和版本都是机器/安装实例属性，不应写死在调用方。

## 验证

- 独立运行时、安装、根目录解析和启动回归：PASS；
- 桥接协议、DOM、CDP、安全状态和生命周期测试：PASS；
- 原生 Codex 路由测试：PASS；
- 全量测试：52/52 PASS；
- Skill 结构校验：PASS；
- Git、全局 Skill、独立 Runtime 和项目兼容副本哈希校验：PASS；
- 在 Dream Skin 之外的工作目录中，不传 `-Root`：
  - `discover`：PASS；
  - `probe`：PASS。

真实只读验收使用 Codex `26.715.10079.0`，独立状态记录端口 `9345`。验收过程
没有发送 GPT 消息、没有创建生成任务、没有关闭对话，也没有重启 Codex。

重启能力边界：已验证 loopback CDP 端点时优先热复用；运行中的 Electron 若没有
该端点，不承诺可以热开启调试口，只能在用户明确授权后走 ready/ack 重启。协议自测
使用临时目录和无破坏 worker，不代表已对真实 Codex 做过重启验收。

## 使用

```powershell
.\scripts\install-global.ps1
.\scripts\verify-global-install.ps1

& "$env:USERPROFILE\.codex\bridge-runtime\dispatch-chatgpt-bridge\windows\scripts\start-chatgpt-bridge.ps1"

$runner = "$env:USERPROFILE\.codex\skills\dispatch-chatgpt-bridge\scripts\run-bridge.ps1"
& $runner -Action discover
& $runner -Action probe
```

普通调用不再需要项目路径。只有自定义部署运行时时，才使用 `-Root` 或
`CODEX_BRIDGE_ROOT`。
