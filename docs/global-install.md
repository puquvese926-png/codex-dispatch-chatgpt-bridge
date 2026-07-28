# 全局安装与版本同步

## 目标

本仓库包含三类东西：

1. Git 仓库中的 Skill：用于版本管理、分享、审查和回滚；
2. 当前用户全局目录中的 Skill：由 Codex 在不同对话中自动发现和加载。
3. 当前用户的独立 Bridge Runtime：负责 loopback CDP、GPT 调度和结果回收。

只有把 Skill 放到全局目录，才能保证换一个 Codex 对话后仍然可以使用。单纯把仓库
clone 到任意文件夹，并不会自动完成全局安装。

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

## 是否需要重启

普通脚本和参考文档更新后，通常不需要重启电脑。若当前 Codex 任务已经缓存了旧的
Skill 内容，开启一个新 Codex 任务或重新读取 Skill 即可；安装脚本本身不会发送消息、
创建 GPT 对话、关闭对话或触发生图。

## 验证标准

`verify-global-install.ps1` 会逐文件比较仓库 Skill、独立运行时与两个全局副本的
SHA-256。只有在输出 `PASS` 时，才认为 Git 版本与当前机器实际运行版本一致。
