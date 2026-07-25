# 全局安装与版本同步

## 目标

本仓库包含两类东西：

1. Git 仓库中的 Skill：用于版本管理、分享、审查和回滚；
2. 当前用户全局目录中的 Skill：由 Codex 在不同对话中自动发现和加载。

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
```

如果要安装到另一个 Codex 用户目录，可以显式指定目标：

```powershell
.\scripts\install-global.ps1 -GlobalSkillsRoot 'D:\Codex\skills'
.\scripts\verify-global-install.ps1 -GlobalSkillsRoot 'D:\Codex\skills'
```

脚本只会覆盖目标 Skill 自身的同名文件，不会删除目标目录中的其他 Skill，也不会
触碰项目桥接运行时、对话、窗口或生成产物。

## 更新

推荐把 Git 仓库作为唯一分发来源。拉取新版本后重新执行安装和校验：

```powershell
git pull
.\scripts\install-global.ps1
.\scripts\verify-global-install.ps1
```

开发者维护 Skill 时，应先修改并测试仓库版本，再安装到全局目录，最后用校验脚本
确认两边文件一致。这样可以避免“Git 已更新、当前 Codex 仍加载旧副本”的错觉。

## 桥接根目录仍需单独指定

全局安装解决的是 Skill 的发现范围，不会替每个项目选择桥接运行时。执行桥接时，
请使用显式项目根目录，或设置当前进程的环境变量：

```powershell
.\skills\dispatch-chatgpt-bridge\scripts\run-bridge.ps1 `
  -Root 'C:\path\to\your\bridge-project' `
  -Action discover
```

也可以：

```powershell
$env:CODEX_BRIDGE_ROOT = 'C:\path\to\your\bridge-project'
```

不要把某个个人项目路径硬编码进可分享的 Skill。全局 Skill 和项目运行时分离后，
同一份 Skill 才能服务多个项目。

## 是否需要重启

普通脚本和参考文档更新后，通常不需要重启电脑。若当前 Codex 任务已经缓存了旧的
Skill 内容，开启一个新 Codex 任务或重新读取 Skill 即可；安装脚本本身不会发送消息、
创建 GPT 对话、关闭对话或触发生图。

## 验证标准

`verify-global-install.ps1` 会逐文件比较仓库 Skill 与全局 Skill 的 SHA-256。只有在
输出 `PASS` 时，才认为 Git 版本与当前机器实际运行副本一致。
