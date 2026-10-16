# Windows 11 x64 部署手册（PowerShell）

目标形态：**一台 Windows 电脑上的桌面 DSH**，用其自带的 `@deepseek-ai/dsh-mcp-client`
启动本仓库的 Node stdio MCP server，控制**同机**的 Godot。
**不依赖** macOS、Codex、协作桥、WSL、Git Bash 或任何 POSIX shell。

- 首个支持目标：**Windows 11 x64 + 桌面 DSH**。
- Windows ARM64 / Windows 10 **未验证**，不宣称支持。
- 原生 Windows CI 已通过：Windows Server 2025 x64 × Node 20/24，覆盖安装、MCP 协议、L1、运行时清理和原生导出；**Windows 11 桌面 DSH 的交互验收尚未进行**（见文末「验收状态」）。
- 已验收代码提交：`feaaca6fc4a691c44138ef291aa0b6a550e8cb60`；Node 运行时构建 `5d5ee6f7fb7c`。后续纯文档提交不改变此构建。

---

## 0. 前置条件

| 组件 | 版本 | 说明 |
|---|---|---|
| Windows | 11 x64 | 需自带 `tar`（Win10 1803+ 都有）与 `powershell`/`pwsh` |
| Node.js | **20 或 24**（≥20） | `node -v` 能跑即可；安装时勾选「Add to PATH」 |
| Godot | **4.7.2-stable win64** | 官方 zip；引擎**不随仓库分发** |
| 桌面 DSH | 能打开 GUI 的版本 | MCP 客户端由 DSH 自带，无需另装 |

```powershell
# 推荐用 winget 装 Node（装完重开一个 PowerShell 让 PATH 生效）
winget install --id OpenJS.NodeJS.LTS -e
node -v      # 期望 v20.x 或 v24.x
```

---

## 1. 安装 Godot（官方 zip，可复现）

```powershell
$Version = '4.7.2-stable'
$Dest    = "C:\Godot\$Version"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$zip = Join-Path $env:TEMP "Godot_v$Version`_win64.exe.zip"
Invoke-WebRequest -Uri "https://github.com/godotengine/godot/releases/download/$Version/Godot_v$Version`_win64.exe.zip" -OutFile $zip
Expand-Archive -LiteralPath $zip -DestinationPath $Dest -Force

# 官方 zip 里是**版本化文件名**；解包后必须真的能跑一次再钉路径
$engine = Join-Path $Dest "Godot_v$Version`_win64.exe"
if (-not (Test-Path -LiteralPath $engine)) { throw "没找到 $engine" }
& $engine --headless --version     # 期望输出 4.7.2.stable.official.<hash>
```

> 只有 `Godot_v4.7.2-stable_win64.exe`（GUI）与 `..._win64_console.exe`（带控制台）两个文件。
> 直接用 GUI 那个即可；MCP 不需要控制台版本。

也可以用官方安装器或 scoop/chocolatey —— 仓库的定位逻辑同样覆盖
`%ProgramFiles%\Godot`、`%LOCALAPPDATA%\Programs\Godot`、`~\scoop\apps\godot\current`、
`%ProgramData%\chocolatey\bin`，以及 `PATH` + `PATHEXT`（`godot.exe`/`Godot.EXE` 都能命中）。

---

## 2. 取仓库并接线

```powershell
git clone https://github.com/G0aT-Shen/dsh-godot-mcp.git
cd dsh-godot-mcp

# 显式指定引擎（推荐）：绝对路径会被写进 DSH profile 的 env.GODOT_MCP_GODOT。
# 注意：没有 --godot 这种命令行开关，路径一律通过环境变量或自动探测给出。
$env:GODOT_MCP_GODOT = "C:\Godot\4.7.2-stable\Godot_v4.7.2-stable_win64.exe"

node scripts/setup.mjs --check     # 先看它要动什么（不写任何文件）
node scripts/setup.mjs             # 真写：自检 + 备份 + 写 profile + 起一次 server 自检
```

`setup.mjs` 会：

1. 校验 Node 版本并取 **node 绝对路径**（固定版本与位置，避免依赖 PATH 的搜索顺序）；
2. 定位 Godot（显式 env → 随包 `tools\` → 系统安装目录 → `PATH`+`PATHEXT`），
   解包官方 zip 时**先校验 zip 头**，解包后**真跑一次 `--version`**，通过才把绝对路径钉进 profile；
3. 在 DSH profile（默认 `%USERPROFILE%\.dsh\profiles\desktop`）的 `cordis.patch.yml` 写入/更新
   `godot-mcp-client` 条目：值没变一个字节都不改；改了先备份成
   `cordis.patch.yml.before-setup-<时间戳>`（回退用，见 §5）；
4. 用配置里那条命令**真的起一次 server**（`initialize` + `tools/list`），确认 5 个工具都在。

其他位置：

```powershell
node scripts/setup.mjs --profile "D:\DSH 配置 #1"     # 自定义 profile 目录（含空格/`#` 都支持）
node scripts/setup.mjs --download-godot               # 缺引擎时自动下到 tools\
node scripts/setup.mjs --godot-zip "C:\下载\Godot_v4.7.2-stable_win64.exe.zip"   # 离线解包
```

---

## 3. 让 DSH 真正用上

```powershell
# 按 profile 里的配置再验一遍接线（会真起一次 server，检查 5 个工具 + 构建指纹）
node scripts/verify-wiring.mjs "$env:USERPROFILE\.dsh\profiles\desktop"
```

然后重启 DSH（或等 mcp-client 热重连），在 DSH 里调用一次 `mcp__godot__godot_status`，应当看到：

- `godot.path` 指向 `C:\...\Godot_v4.7.2-stable_win64.exe`，`godot.version` 是 4.7.2；
- `opsEngine.ok: true`；
- `server.build.loaded == server.build.onDisk` 且 `stale: false`；
- `sessions` 为空数组（还没有常驻会话）。

---

## 4. 升级

先在 DSH 中调用 `godot_session(action="stop", kind="game")` 和 `godot_session(action="stop", kind="editor")`，确认没有 `running:true` 的受管会话，核对临时注入已恢复。然后正常退出桌面 DSH，备份 profile 的 `cordis.patch.yml` 和 `package.json`，记录当前提交，再更新：

```powershell
git rev-parse HEAD
git pull --ff-only
node scripts/setup.mjs --check
node scripts/setup.mjs
```

重新打开 DSH，调用 `godot_status` 确认构建 `stale:false`，再使用工具。移动仓库、引擎或升级 Node 后也应重跑安装器，更新绝对路径。

Windows 的 `Stop-Process` 会硬杀进程，不能代替正常清理。强杀后应先确认相关 Godot/MCP 进程都已停止，备份项目和 `override.cfg.mcp-backup`，再使用显式 `godot_session(action="cleanup")` 并检查恢复结果。不要承诺断电或强杀后自动恢复，也不要清除其他活跃会话的文件。

---

## 5. 回退（回到接线之前）

`setup.mjs` 改动 profile 前都会留备份（`cordis.patch.yml` 与 `package.json` 各自一份）：

```powershell
# 注意：$PROFILE 是 PowerShell 的内置只读变量，别用这个名字（大小写不敏感）
$taskProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop"

# 1) 还原接线
$patchBackup = Get-ChildItem "$taskProfileDir\cordis.patch.yml.before-setup-*" |
               Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item -LiteralPath $patchBackup.FullName -Destination "$taskProfileDir\cordis.patch.yml" -Force

# 2) 如果 setup 动过 profile 的 package.json（移除历史 link 依赖），也一起还原
$pkgBackup = Get-ChildItem "$taskProfileDir\package.json.before-setup-*" -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($pkgBackup) {
  Copy-Item -LiteralPath $pkgBackup.FullName -Destination "$taskProfileDir\package.json" -Force
}
```

还原后重启 DSH 即可回到接线之前的状态。

完全卸载：恢复上面的备份（或手工删掉 `- id: godot-mcp-client` 那个条目）后删除仓库目录即可。
仓库不改系统环境变量，也不写注册表；Godot 与 Node 由你自己安装，卸载时自行处理。

---

## 6. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `找不到 Node 可执行文件（嵌套执行需要它）` | 嵌套 op（导入/导出/run_project/deep parse_check）要自己起 Node 助手。server 会自动注入 `GODOT_MCP_NODE`；手动跑 `ops.gd` 时请自行设置该变量或把 `node` 放进 PATH |
| `GODOT_NOT_FOUND` | 错误里会列出**查过的全部候选**（随包 `tools\`、Program Files、LOCALAPPDATA、scoop、chocolatey、PATH 名）。照清单确认是没装还是路径写错 |
| 端口被占用 / 连到别的项目 | 每个游戏会话可以用 `godot_session(game, runtimePort=…)` 指定端口，端口会写进项目 `.godot\mcp_bridge\port.cfg`，运行时脚本启动时读取。`godot_connect` 会做**有期限就绪探测 + 项目归属校验**：接错项目报 `PROJECT_MISMATCH`，外来服务占用报 `PORT_OCCUPIED` |
| `taskkill` 之后仍有残留 | 杀树必须在**根进程还活着**时按 pid 枚举后代（Windows 没有进程组）。仓库已经这么做：取消/超时会**有界等待**确认，返回里记录杀树结果；POSIX 还会列出快照中的残留 pid，失败会如实上报而不是假装成功 |
| 停止常驻游戏时提示只能强杀 | headless 控制台进程通常拒绝优雅退出（`taskkill /T` 不带 `/F` 会失败）。仓库会如实记录原因后 `/T /F`。**强杀不保证落盘**，也不回滚已执行的 GDScript |
| 项目文件被占用 | 会话停止后才清理注入的文件；结果文件先落盘、等 helper 退出再删，并对 Windows 文件占用做有限重试 |
| 中文输出乱码 | 一次性操作输出按字节累计并流式解码；达到上限会标记截断 |
| UNC 项目路径 | **未验收，当前保守拒绝**（`\\server\share\...`）：本版本只在**本机磁盘路径**上做过真实回归，UNC 归属判断与写入行为没有实测证据，所以遇到 UNC 直接报 `UNC_UNSUPPORTED`，不猜也不冒险。需要时请用本机绝对路径（或映射为盘符后自行验证）。 |

诊断入口：`godot_status`（引擎、构建指纹、桥端口、会话、待回收注入）。

---

## 7. 验收状态

| 项目 | 状态 |
|---|---|
| 源码适配（无 POSIX shell 依赖、Windows 定位/杀树/端口/路径） | **已实现并在原生 Windows CI 验证** |
| `.github/workflows/windows.yml`（Node 20/24、官方引擎与模板、隔离 profile） | [第四轮全部通过](https://github.com/G0aT-Shen/dsh-godot-mcp/actions/runs/38872012852)；每组单元 145/145、wiring 15/15、MCP 17/17、操作 19/19、诊断 24/24、运行时 63/63、导出 10/10 |
| 本机 macOS 桌面 DSH 五工具 | 最终构建真实调用通过，`stale:false`、`rt.eval=42`、配置原样恢复且端口关闭 |
| Windows 11 桌面 DSH 五工具 + 交互式场景 | **待验收**（本轮无交互式 Windows 宿主） |

完整结果、已修复问题及平台边界见 [实施与验收报告](../verification/WINDOWS-IMPLEMENTATION-20261016.md)。Windows CI 的通过不覆盖桌面 DSH 客户端重连、真实窗口、截图/输入、锁屏唤醒；诊断套件也未以 macOS 权限探针代替 Windows ACL 验证。

实机验收最低清单：五个工具真实可用、`stale: false`、L1 建项目/导入/深检查/运行/导出、
L2 编辑器读写与 UndoRedo、L3 属性/方法/输入/截图、取消与超时无残留后代、
`override.cfg` 逐字节恢复、UNC 按上面的保守拒绝行为记录实测结果。
每次记录系统与工具版本、commit、退出码、产物与残留进程。
