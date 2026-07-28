# 全局安装与版本同步

## 目标

本仓库包含三类东西：

1. Git 仓库中的 Skill：用于版本管理、分享、审查和回滚；
2. 当前用户全局目录中的 Skill：由 Codex 在不同对话中自动发现和加载。
3. 当前用户的独立 Bridge Runtime：负责 loopback CDP、GPT 调度和结果回收。

只有把 Skill 放到全局目录，才能保证换一个 Codex 对话后仍然可以使用。单纯把仓库
clone 到任意文件夹，并不会自动完成全局安装。

安装器只管理列出的 Skill/Runtime 目标，不会也不应该修改用户的全局
`AGENTS.md`。Skill 是否被发现，取决于它是否安装到当前用户的
`%USERPROFILE%\\.codex\\skills`，以及 frontmatter 的触发描述是否匹配；这不等于
安装后出现永久后台 daemon。当前 MVP 支持显式批次调度、报告和只读恢复，不支持
无人值守地持续监听或自动把结果回帖给 GPT。

## 安装

在仓库根目录运行：

```powershell
.\scripts\install-global.ps1
.\scripts\verify-global-install.ps1
```

默认目标目录为：

```text
%USERPROFILE%\.codex\skills\dispatch-chatgpt-bridge
%USERPROFILE%\.codex\bridge-runtime\dispatch-chatgpt-bridge
```

如果要安装到另一个 Codex 用户目录，可以显式指定目标：

```powershell
.\scripts\install-global.ps1 `
  -GlobalSkillsRoot 'D:\Codex\skills' `
  -GlobalRuntimeRoot 'D:\Codex\bridge-runtime\dispatch-chatgpt-bridge'
.\scripts\verify-global-install.ps1 `
  -GlobalSkillsRoot 'D:\Codex\skills' `
  -GlobalRuntimeRoot 'D:\Codex\bridge-runtime\dispatch-chatgpt-bridge'
```

脚本只会覆盖目标 Skill 和独立运行时自身的同名文件，不会删除其他 Skill，也不会
发送消息、修改 GPT 对话或触碰生成产物。

## 更新

推荐把 Git 仓库作为唯一分发来源。拉取新版本后重新执行安装和校验：

```powershell
git pull
.\scripts\install-global.ps1
.\scripts\verify-global-install.ps1
```

开发者维护 Skill 时，应先修改并测试仓库版本，再安装到全局目录，最后用校验脚本
确认两边文件一致。这样可以避免“Git 已更新、当前 Codex 仍加载旧副本”的错觉。

## 初始化独立运行时

安装后运行一次：

```powershell
& "$env:USERPROFILE\.codex\bridge-runtime\dispatch-chatgpt-bridge\windows\scripts\start-chatgpt-bridge.ps1"
```

如果 Codex 已经以受验证的 loopback CDP 参数运行，脚本会复用它并写入
`%LOCALAPPDATA%\CodexChatGPTBridge\state.json`。如果 Codex 正在运行但没有
该端点，脚本会停止并要求明确使用 `-RestartExisting`，不会擅自关闭当前 Codex。
获得授权后，启动器会先写入持久化重启记录，再通过 Windows 进程服务创建一个
不依赖当前 Codex 进程树的隐藏 worker。worker 负责关闭已验证的旧 Codex PID、
重新启动官方 Store 包、等待 loopback CDP 就绪并原子写入状态文件。
从 PowerShell 7 调用时，启动器会把 Windows `Appx` 检查自动转交给
Windows PowerShell 5.1，并保留相同参数和退出状态。

重启期间当前命令可能因为 Codex 窗口关闭而在界面中显示“被中断”；这不再作为
重启成败依据。不要手动启动 Codex，等待它自动重新打开，然后查看：

```powershell
Get-Content -Raw "$env:LOCALAPPDATA\CodexChatGPTBridge\restart-report.json"
```

只有报告为 `"status": "complete"` 且 `"ready": true` 时才算重启成功。
`dispatching`、`restart-dispatched`、`stopping-existing` 和 `starting` 表示仍在
进行；`failed` 会保留具体错误。成功后再顺序运行 `discover` 和 `probe`。

初始化后直接执行：

```powershell
$runner = "$env:USERPROFILE\.codex\skills\dispatch-chatgpt-bridge\scripts\run-bridge.ps1"
& $runner -Action discover
& $runner -Action probe
```

只有在开发或自定义部署时才需要 `-Root` / `CODEX_BRIDGE_ROOT`。公共包装器不会
读取旧项目变量，也不会从当前工作目录向上寻找运行时。

最小触发验证是在 `verify-global-install.ps1` 输出通过后，新建一个 Codex 任务，
明确写一句：`请使用 dispatch-chatgpt-bridge 做一次只读 discover/probe，不发送 GPT`。
如果任务未自动选择 Skill，再明确写 `使用 dispatch-chatgpt-bridge Skill` 并查看它
是否按路由规则执行。换一个 Codex 对话后重复该显式短句即可验证跨对话发现；不需要
修改 `AGENTS.md`，也不要把普通聊天改造成全局自动触发。

## 是否需要重启

普通脚本和参考文档更新后，通常不需要重启电脑。若当前 Codex 任务已经缓存了旧的
Skill 内容，开启一个新 Codex 任务或重新读取 Skill 即可；安装脚本本身不会发送消息、
创建 GPT 对话、关闭对话或触发生图。

## 验证标准

`verify-global-install.ps1` 会逐文件比较仓库 Skill、独立运行时与两个全局副本的
SHA-256。只有在输出 `PASS` 时，才认为 Git 版本与当前机器实际运行版本一致。

## 安装清单与事务边界

每次安装都会为两个目标写入相同的 `deployment-manifest.json`。清单的受管文件
集合来自仓库中的 Skill 树和 `windows/scripts` Runtime 树；Runtime 条目相对
Runtime 部署根记录完整路径，例如 `windows/scripts/chatgpt-bridge.mjs`，而不是
只记录 basename。清单还包含 `schemaVersion`、`bridgeVersion`、
`protocolVersion`、`sourceCommit`、`sourceCommitStatus`、目标绝对路径、每个受管
文件的 SHA-256 和 `manifestHash`。`manifestHash` 计算时排除自身字段，所以可以
独立复算。两个目录的清单必须规范化后完全相同；额外用户文件会保留、不会被纳入
受管集合，也不会被安装器删除或覆盖。

`sourceCommitStatus=exact-clean` 只表示 Git HEAD 存在且 worktree 干净；有未提交
改动时明确写成 `dirty-worktree`，此时 HEAD 只是来源线索，清单中的文件哈希才是
实际部署内容。没有可用 Git 时写成 `unavailable`，不能伪造精确提交。

安装在各目标同卷 sibling staging 目录中完成复制、清单生成、哈希校验和路径绑定
校验，然后把旧目标移动到带随机事务 ID 的 backup，再切换新目标。journal 位于
Skill 根旁边，记录精确的 staging、backup、target 路径和事务状态；所有清理/移动
都先验证父目录、固定前缀和事务 ID。安装失败会恢复原来的两棵树；如果原目标不存在，
失败后仍不存在。跨 Skill 目录和 Runtime 目录不可能获得真正的双目录原子性，因此
进程被强杀的瞬间可能处于半切换状态，但下一次安装会读取并验证本次 journal：两棵
树都属于已提交清单时清理残留，否则恢复 backup。无法验证的 journal 或残留不会被
盲删，而是拒绝继续并保留现场供审计。

安装器的故障注入只在同时提供 `-TestOnly` 和
`CODEX_BRIDGE_INSTALL_TEST_MODE=1` 时有效，生产默认不可触发。

## Runner 版本门禁

`run-bridge.ps1` 在调用 Node、访问 loopback CDP 或写业务输出之前，会比较当前
Skill 副本和最终选中的 Runtime 的两份 manifest、规范化 hash、版本、协议、目标路径
和受管文件哈希。`batch`、`resume`、`watch`、`approve`、`cleanup` 以及 `plan` 在
门禁失败时都不会启动 Node；错误会给出实际 Skill/Runtime 路径和重新安装/验证命令。
只有 `discover` 与 `probe` 作为明确的只读诊断允许在清单缺失或不匹配时继续，以便
定位安装问题。显式 `-Root` 不会绕过生产门禁；开发目录没有 manifest 时只能做诊断，
不能执行 UI mutation。

## 另一用户的可移植 smoke test

要验证另一台 Windows 用户目录而不改真实全局目录，可将两个目标放到临时目录，
只执行安装、验证、discover 和 probe：

```powershell
$smoke = Join-Path $env:TEMP ('dispatch-bridge-smoke-' + [guid]::NewGuid().ToString('N'))
$skills = Join-Path $smoke 'skills'
$runtime = Join-Path $smoke 'runtime'
./scripts/install-global.ps1 -GlobalSkillsRoot $skills -GlobalRuntimeRoot $runtime
./scripts/verify-global-install.ps1 -GlobalSkillsRoot $skills -GlobalRuntimeRoot $runtime
$smokeRunner = Join-Path $skills 'dispatch-chatgpt-bridge/scripts/run-bridge.ps1'
& $smokeRunner -Root $runtime -Action discover
& $smokeRunner -Root $runtime -Action probe
```

该 smoke 只证明 Skill/Runtime 清单、路径绑定和只读诊断可用；它不发送、恢复、批准
或删除任何 GPT 对话，也不验证永久后台自动化。
