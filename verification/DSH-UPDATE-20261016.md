# DSH 实际加载的 Godot MCP 更新到 698790c：真实工具验收 + Windows 部署障碍评估

- 日期：2026-10-16（Asia/Hong_Kong）
- 执行者：DSH Agent（执行者角色）；规划与最终审查：Codex
- 目标提交：`G0aT-Shen/dsh-godot-mcp` `main` = `698790cc929ad036610ca813bdc21369781a07e5`
- 验收通道：**仅使用本桌面 DSH 会话当前实际广告的 `mcp__godot__*` 工具**（未使用仓库测试脚本或独立 Node MCP 客户端作为验收替身）
- 结论：**验收通过**。DSH 真实加载的 server 已切到目标提交对应的构建（`stale:false`），五个工具做了一轮**冒烟验证**（状态 → 临时项目 → L1 运行 → L3 runtime 控制与错误读取 → 退出清理），用户 `override.cfg` 逐字节保留，测试进程与注入残留全部收尾。
- **本轮未覆盖**：L2 编辑器桥（9089）、`export_project` / `import_assets`、以及 DSH 侧的用户取消入口（详见第 7 节）。冒烟通过不等于功能全覆盖。
- Windows：**本轮不实施 Windows 适配、不声称 Windows 实测**。第 5 节是只读源码审阅 + 迁移方案，明确区分「Mac 实测 / 静态证据 / Windows 待测」。

---

## 1. 更新动作与 build 证据

### 1.1 更新前的真实状态

`mcp__godot__godot_status`（DSH 工具，第一次调用）：

```json
{"ok":true,"server":{"pid":53885,
 "build":{"loaded":"62ca74a95b38","onDisk":"3e3aa064b2a1","stale":true,"files":12,
 "checkedAt":"2026-10-16T01:28:27.353Z",
 "note":"磁盘上的源码与当前进程加载的不一致……"}}}
```

即：**磁盘上已是目标提交，但活体 server 进程仍是旧构建**（`stale:true`）。这正是本任务要修的状态。

### 1.2 运行进程归属确认（不是猜的）

```
$ pgrep -fl 'bin/godot-mcp.mjs'
53885 /Users/hanyangshen/.local/share/node-v24.21.0/bin/node /Users/hanyangshen/杂活/godot-mcp/bin/godot-mcp.mjs

$ lsof -p 53885 | awk '$4=="cwd"'
node    53885 hanyangshen  cwd  DIR  ...  /Users/hanyangshen
```

- 命令中的 node 绝对路径与 `cwd` 与 profile 配置（`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `godot-mcp-client` 条目，第 82–91 行）完全一致。
- 该 PID 由 `godot_status` 自报，即**它就是本会话 `mcp__godot__*` 调用的服务方**。

### 1.3 目标提交内容（与本次修复面吻合）

```
$ git log -1 --format='%H%n%ci%n%s'
698790cc929ad036610ca813bdc21369781a07e5
2026-10-16 09:25:00 +0800
fix: preserve injection state and support MCP cancellation
```

改动文件：`README.md`、`package.json`、`scripts/verify-l3.mjs`、`src/bridge.mjs`、`src/inject.mjs`、`src/mcp-stdio.mjs`、`src/processes.mjs`、`src/server.mjs`、`test/lifecycle.test.mjs`、`verification/FIXES-20261016.md`（+571/−99）。其中 `src/*.mjs` 全部属于构建指纹输入 → **必须重启进程才生效**。

### 1.4 重启（只重启这一个 server 子进程，不动整个 DSH）

```
$ kill -TERM 53885          # exit 0，仅目标 server PID
$ sleep 7 && pgrep -fl 'bin/godot-mcp.mjs'
62501 /Users/hanyangshen/.local/share/node-v24.21.0/bin/node /Users/hanyangshen/杂活/godot-mcp/bin/godot-mcp.mjs
```

`mcp-client` 监管器在数秒内自动拉起新进程（**未重启 DSH 应用**：`DeepSeek Harness` 的 27554/27555/27560 等进程自始至终未变）。

### 1.5 更新后的真实状态（`stale:false` 来自实际工具结果）

`mcp__godot__godot_status`：

```json
{"ok":true,"server":{"pid":62501,
 "build":{"loaded":"3e3aa064b2a1","onDisk":"3e3aa064b2a1","stale":false,"files":12,
 "checkedAt":"2026-10-16T01:29:17.849Z"}},
 "godot":{"ok":true,"path":"/Users/hanyangshen/杂活/godot-mcp/tools/Godot.app/Contents/MacOS/Godot",
 "version":"4.7.2.stable.official.ed1daf0bf"},
 "bridges":{"editor":{"port":9089,"listening":false},"runtime":{"port":9091,"listening":false}},
 "sessions":[]}
```

### 1.6 指纹与目标提交的独立校验（关键：证明「加载的就是目标提交」）

`godot_status` 只说明 loaded==onDisk，不能证明 onDisk==目标提交。因此另做一次交叉验证——用 `git archive HEAD` 导出目标提交的纯净树，再用仓库自身的 `computeBuildId()`（`src/build.mjs`，12 个 `BUILD_INPUTS`）分别对「导出树」「工作树」求指纹：

```
$ git archive HEAD | tar -x -C /private/tmp/godot-mcp-head-698790c
$ node --input-type=module -e "import {computeBuildId} from '/Users/hanyangshen/杂活/godot-mcp/src/build.mjs'; ..."
archive(HEAD 698790c) = 3e3aa064b2a1 files= 12 missing= []
worktree            = 3e3aa064b2a1 files= 12 missing= []
tool_reported_loaded= 3e3aa064b2a1
MATCH_ARCHIVE_VS_TOOL = true
MATCH_WORKTREE_VS_TOOL = true
```

外加 `git rev-parse HEAD` = `git rev-parse origin/main` = `698790cc…`，`git status --porcelain` 无源码改动。
**结论：DSH 当前加载的构建 == 目标提交 698790cc 的内容（指纹 `3e3aa064b2a1`，12 文件全部命中、无缺文件）。**

> 说明：本小节只是一次**只读的指纹交叉校验**（用于把「loaded==onDisk」升级为「loaded==目标提交」），**不替代也不冒充 DSH 工具验收**——下文第 2 节的每一格都来自 `mcp__godot__*` 的真实调用结果。

---

## 2. DSH 实际广告工具的调用记录（全部为真实工具结果）

本会话实际广告并调用的工具共 5 个：
`mcp__godot__godot_status`、`mcp__godot__godot`、`mcp__godot__godot_batch`、`mcp__godot__godot_session`、`mcp__godot__godot_connect`。

专属临时项目：`/private/tmp/godot-mcp-dsh-verify-20261016`（项目名 `DshVerify20261016`，`gl_compatibility`）。

> **证据留存说明**：该临时项目、`rt.screenshot` 产物 `shot.png` 与导出树 `/private/tmp/godot-mcp-head-698790c` 均已在收尾时删除（见第 8 节）。因此本节可留存的是**工具调用与返回的公开结果**，不含可再打开的产物文件。这些调用不重建、不重跑。

| # | 工具 | 参数（要点） | 实际结果 |
|---|---|---|---|
| 1 | `godot_status` | — | pid 53885 / `stale:true`（更新前） |
| 2 | `godot_session` | `action=list` | `sessions:[]` |
| 3 | `godot` | `op=create_project`，`name=DshVerify20261016`，`renderer=gl_compatibility` | `created:true`，`path=/tmp/godot-mcp-dsh-verify-20261016`，1228ms |
| 4 | `godot` | `op=create_scene`，`root_type=Node2D`，`root_name=Main` | `overwritten:false`，687ms |
| 5 | `godot` | `op=write_file`，`res://main.gd` | `bytes:295`，355ms |
| 6 | `godot` | `op=attach_script`，节点 `.` → `res://main.gd` | ok，371ms |
| 7 | `godot` | `op=parse_check`，`deep=true` | `checked:1, errors:[], unique_errors:0` |
| 8 | `godot` | `op=read_scene`，`max_depth=2` | 树 `Main(Node2D)`，`properties.script=res://main.gd` |
| 9 | `godot` | `op=project_info` | `godot_version=4.7.2-stable`，`name=DshVerify20261016` |
| 10 | `godot` | `op=run_project`，`headless=true, quit_after=3` | `exit_code:0`，`stdout` 含 `@@VERIFY@@ ready hp=42` |
| 11 | `godot_session` | `action=game`，`scene=res://main.tscn`，`headless=false` | 会话 `game-2c81b79a`，pid 62679，`bridge.mode=transient`，`injected:true`，`projectFileUntouched:true` |
| 12 | `godot_connect` | `target=runtime, op=rt.info` | 首次 `ECONNREFUSED 127.0.0.1:9091`（启动竞态，见 6.3）；4s 后成功：`listening:true`、`gate:"open: editor"`、`scene:"/root/Main"`、`clients:1` |
| 13 | `godot_connect` | `op=rt.scene_tree` | `/root` 下 `McpRuntime`（注入脚本）+ `Main`（`res://main.gd`） |
| 14 | `godot_connect` | `op=rt.get_property hp` | `value:42, type:int` |
| 15 | `godot_connect` | `op=rt.call_method add_hp args=[8]` | `result:50` |
| 16 | `godot_connect` | `op=rt.get_property hp` | `value:50`（**写操作真实生效并持久**） |
| 17 | `godot_connect` | `op=rt.screenshot`，`path=/tmp/…/shot.png` | `width:1152, height:648, bytes:4476, captured_frame:3262, headless:false` |
| 18 | `godot_connect` | `op=rt.call_method boom` | ok（触发 `push_error`） |
| 19 | `godot_connect` | `op=rt.errors` | `total:1`，含完整回溯：`main.gd:14 boom → mcp_bridge…_op_call_method:503 → _execute:329 → _run_job:299 → _process:171` |
| 20 | `godot_session` | `action=logs` | stdout：`@@VERIFY@@ ready hp=42`、`@@VERIFY@@ add_hp -> 50`；stderr：`ERROR: @@VERIFY@@ intentional runtime error` + `@@VERIFY@@ intentional stderr line` |
| 21 | `godot_connect` | `op=rt.quit` | `quitting:true, exit_code:0` |
| 22 | `godot_session` | `action=list` | `game-2c81b79a`：`running:false`、`endedAt` 有值、`exitCode:0`（**自然退出即完成清理**） |
| 23 | `godot_session` | `action=game`（headless） | 会话 `game-389216cd`，pid 62866 |
| 24 | `godot_session` | `action=attach`（同项目） | `shared:true`、`injected:false`（**复用现有注入，未重复注入**） |
| 25 | `godot_session` | `action=detach` | `deferred:true, reason:"project-in-use"`（**不提前拆除仍被游戏使用的注入**） |
| 26 | `godot_session` | `action=stop, id=game-389216cd` | `bridgeCleanup:{restored:true, removedScript:true, removedOverride:false}` |
| 27 | `godot_session` | `action=cleanup` | `swept:[], count:0`（无残留可回收） |
| 28 | `godot_batch` | `steps=[project_info, list_scenes]` | 两步 `ok:true`；`total:1`，`res://main.tscn` |
| 29 | `godot_status` | 收尾复核 | pid 62501，`stale:false`，两桥端口均未监听，所有会话 `running:false` |

---

## 3. 用户原有配置保留验证（`override.cfg`）

零足迹注入的语义：往 `override.cfg` 追加 `[autoload] McpRuntime=…`，用户原文件先备份为 `override.cfg.mcp-backup`（`src/inject.mjs:33-34,156-214`）。

验证用哨兵文件（**在任何注入之前**由验证者生成，172 字节，md5 `1079b8168a6e11cf378d558329051bbb`）：

```ini
; SENTINEL-USER-OVERRIDE-20261016 — written by verifier before any MCP injection
[rendering]
renderer/rendering_method="gl_compatibility"
anti_aliasing/quality/msaa_2d=1
```

| 阶段 | `override.cfg` md5 | 备份文件 | `.godot/mcp_bridge/` | `transient.json` |
|---|---|---|---|---|
| 注入前（哨兵） | `1079b8168a6e11cf378d558329051bbb` | 无 | 无 | — |
| 会话 1 运行中 | `8d7ae3ba12bb4815ccdc7ce172db38c9`（追加 autoload） | `override.cfg.mcp-backup`，md5 **= 哨兵** | 有 `godot_mcp_runtime.gd` | 有该项目条目，`hadOwnOverride:true` |
| 第 2 次 `game` + `attach` 重叠注入 | — | md5 **仍 = 哨兵**（未丢失原始备份） | autoload 计数 = **1**（无重复块） | 单条目 |
| `detach`（游戏仍在跑） | autoload 计数 = 1（**保留**） | md5 **= 哨兵** | 仍在 | 仍在 |
| `stop` + 自然退出后 | **`1079b8168a6e11cf378d558329051bbb`（逐字节还原）** | **已删除** | **已删除** | `{"projects":{}}` |
| `cleanup` 后 | 同上 | 无 | 无 | 无残留（`swept:[]`） |

- 会话 1 为**自然退出（rt.quit）**路径：无需显式 stop 即完成还原，且会话记录无 `cleanupError`。
- 会话 2 为**显式 stop** 路径：`bridgeCleanup.restored:true`。
- 进程侧收尾：`pgrep -fl 'godot-mcp-dsh-verify'` 无输出（rc=1），游戏与 `caffeinate` 包装进程均已退出。
- 项目本身 `project.godot` 全程未被改动（会话回报 `projectFileUntouched:true`）。

---

## 4. 范围与合规

| 约束 | 实际做法 | 证据 |
|---|---|---|
| 不修改 MCP 源码 | 未编辑任何**已有**文件（`src/`、`godot/`、`scripts/`、桥插件均为原样）；本任务对仓库的唯一写入是**新增**本报告 | 本任务收尾时 `git status --porcelain` 只有两份未跟踪报告（本报告 + 主审的 `WINDOWS-MIGRATION-20261016.md`）；HEAD 未变 |
| 不提交 / 不推送 / 不发布 | 未执行 git 写操作 | `git rev-parse HEAD` == `origin/main` == 目标提交 |
| 不更新桥插件 | 从未调用 `godot_session(action="setup")`；仅用零足迹瞬态注入 | 仓库无改动；临时项目注入脚本随会话清除 |
| 不重启整个 DSH | 只 `kill -TERM` 那一个 server 子进程 | DSH 应用进程 27554/27555/27560 全程未重启 |
| 不杀其他任务进程 | 只操作 53885 与自建会话 PID | 收尾 `pgrep` 仅剩 1 个 godot-mcp server |
| 不读/打印凭据 | 只读 profile 的 godot 条目（第 79–91 行） | 报告未含任何密钥 |
| profile 未被改动 | 本次**无需**改配置：`command/args/cwd/toolCallTimeoutMs` 均已指向仓库路径，而仓库已在目标提交 | `cordis.patch.yml` mtime 仍为 `Oct 15 20:43`，md5 `6292eb6e9a3e3831976b82264d9bafeb` |

> **归属说明（2026-10-16 09:36 返工复核）**：返工收尾时 `git status` 另见 ` M README.md`（+3 行：在「平台」段落之后加「Windows DSH 独立使用尚未就绪」，并链接本报告与主审的迁移报告）。该改动**由主审在其迁移工作中进行，与本任务无关**；执行者未编辑 README.md，也不会改动或回退它。

说明：因「无需改配置」，未生成新的 profile 备份（备份目标是工作区外路径，DSH `workspace-write` 沙箱会拒绝写入）。现有历史备份仍在 `~/.dsh/profiles/desktop/cordis.patch.yml.before-*`。本次改动**不含** profile 文件。

---

## 5. 仅 Windows DSH 部署的障碍评估（只读源码审阅 + 迁移方案）

> 本节全部为**静态证据**（源码位置）+ 推论。**没有任何 Windows 实测**；标记「Windows 待测」的条目必须在真实 Windows + DSH 上复验后才能定级。

### 5.1 硬阻塞（会让功能在 Windows 上直接失败）

**W0｜profile 接线的两处配置层缺陷会阻止 Windows 自动接线（主审已本机复现）**

主审报告 [WINDOWS-MIGRATION-20261016.md](WINDOWS-MIGRATION-20261016.md) 的「已确认的问题」与「配置问题的本机复现」两节给出了复现结果。以下行号由本次只读核对确认：

- **盘符被结构自检拒绝**：`scripts/lib/profile-patch.mjs:118`（`validatePatchText`）里的 command 规则是 `['command', /^ {8}command: \//m]`（`:129`）——要求值以 `/` 开头。Windows 的 `C:\…\node.exe` 不匹配，于是 `scripts/setup.mjs:252` 在写入前判「缺少 command」并**放弃写入**（原文件不改动）。
- **路径未加引号 → 真实 YAML 截断**：`scripts/lib/profile-patch.mjs:38`（`buildEntryBlock`）把 `command`（`:45`）、`args` 项（`:47`）、`cwd`（`:48`）、`GODOT_MCP_GODOT`（`:53`）直接拼成 YAML 普通标量。主审用当前 DSH profile 内的真实 `yaml` 包解析复现：`C:\DSH #1\Godot` 被截为 `C:\DSH`（` #` 起注释），而仓库自带兜底解析器仍回完整字符串 → **自检与实际加载不一致**。
- 影响：这两条直接推翻「在 Windows 上重跑 setup 即可正确接线」。**必须先适配**（校验接受盘符/UNC；所有路径标量统一加引号并核对解析结果），才谈接线。
- 证据边界：主审复现是 macOS 上的 JavaScript/YAML 字符串处理，**不是 Windows 系统执行**。

**W1｜`sh_capture()` 硬编码 `/bin/sh` + POSIX shell 脚本（最高优先级）**

- 位置：`godot/ops.gd:525`（函数）、`:552`（`#!/bin/sh` 脚本）、`:589`（`OS.execute("/bin/sh", …)`）。
- 脚本内容用了一整套 POSIX 语义：`&` 后台、`$!`、`wait`、`$?`、`kill -9`、`pkill -9 -P`、`2>/dev/null`（`ops.gd:553-561`）。
- 调用点（`ops.gd:1623, 1705, 1814, 1902, 2077`）覆盖：`run_project`、`export_project`、`import_assets`、deep `parse_check`、`gdscript` 逃生舱。
- Windows 无 `/bin/sh`、无 `kill`/`pkill`/`$!` → 这些 op 会退化为 `spawn_error`/超时。
- 缓解（不改源码）：**L0（`godot`/`godot_batch` 里的非嵌套 op）不受影响**——`src/operations.mjs:117-119` 直接 `spawn(Godot, ['--headless','--path',…,'--script',ops.gd,…])`，不走 shell。受影响的只有 ops.gd 内部再起子进程的那 5 类 op。
- 该限制仓库自己已记录：`README.md:41`、`verification/ops-gd.md:503`、`verification/SUMMARY.md:154`（均为「Windows 需替换实现」的待办，非实测结论）。

**W2｜运行时 Godot 可执行文件自动发现是 macOS-only，且「让 setup 钉定 exe 路径」当前也走不通**

- 位置：`src/godot.mjs:21-25`（`tools/Godot.app/Contents/MacOS/Godot`、`tools/godot`、`…_macos.universal/Godot.app/…`）与 `:27-31`（`/Applications/Godot.app/…`、`~/Applications/Godot.app/…`）。**没有任何 `_win64.exe` 候选。**
- 兜底 PATH 探测（`src/godot.mjs:91-98`）只试 `godot4`/`godot`/`Godot` 三个无扩展名名字，Windows 上实际是 `godot.exe` → 探测不到。
- 运行时唯一的绕过办法是显式路径：`src/godot.mjs:71-84` 接受 `GODOT_MCP_GODOT` / `GODOT_PATH` / `GODOT4` / `GODOT`（严格语义：给了却不可执行就直接失败，不回退到别的版本）。
- **但「让 setup 把 exe 路径写进 profile」这条路在 Windows 上当前走不通**：`scripts/setup.mjs:213-219` 经 `buildEntryBlock` 把 `GODOT_MCP_GODOT` 写进条目 `env`，而这次写入先要过 `validatePatchText` —— 见 **W0**，带盘符的 `command` 会被判缺失并放弃写入；即便绕过校验，路径若含空格加 `#` 等 YAML 特殊组合，未引用的标量也可能被真实 YAML 截断。
- 因此 W2 的准确表述是：**自动发现不可用 + 自动钉定不可用**，两侧都需适配；不能当成「配个环境变量就绕过」。
- 相关但**从未被调用**的死代码：`scripts/setup.mjs:138` 定义 `locateGodotBinary`（`:144` 的 `/^Godot.*\.(exe)?$/i` 确实能认出 `.exe`），但**全文件仅此一处出现、零调用点** → 它不构成安装能力，不能据此认为下载/解包后能找到官方版本化 exe（详见 W6）。

**W3｜setup 自检探针写死 POSIX 最小环境**

- 位置：`scripts/lib/probe-mcp.mjs:22`（函数 `probeMcpServer` 起于 `:16`；主审报告记为 `:25`，指同一处）：
  `env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', … }`
- 问题：PATH 是**冒号分隔**（`:`，Windows 为分号 `;`），`/usr/bin:/bin` 在 Windows 上无意义；且缺 `SystemRoot`/`COMSPEC`/`PATHEXT`/`TEMP`/`APPDATA` 等基础变量。用绝对路径起 node 尚可，但子进程再 spawn 会不稳。
- 影响面：安装自检与 `scripts/verify-wiring.mjs` 共用的启动探针，不是运行时热路径 → 表现为**安装自检不可信**（可能假失败，也可能证明不了 Windows DSH 的真实启动环境），它**不能**替代 Windows 实机探针。
- 该处**需要适配**，属源码改动范围（不在本轮授权内）。

### 5.2 部分可用（会退化，需 Windows 验证）

**W4｜进程树回收与「优雅停止」在 Windows 语义不同**

- `src/processes.mjs:99-100` 与 `src/godot.mjs:238-239`：`process.platform === 'win32'` 时只 `child.kill(name)`（=直接子进程），其余走 `process.kill(-pid, …)`（整进程组）。
- Windows 上 `kill('SIGTERM')` 落到 `TerminateProcess`：不可捕获、立即生效 → `src/processes.mjs:115-119` 的「SIGTERM → 宽限期 → SIGKILL」退化为「立刻杀」，Godot 没有机会落盘/清 `.godot` 锁；`godot/ops.gd` 里 Godot 拦截 SIGTERM 正常退出（见 `src/processes.mjs:8-9` 注释）的行为在 Windows 不成立。
- `detached: process.platform !== 'win32'`（`src/processes.mjs:61`、`src/godot.mjs:201`）：Windows 不建独立进程组 → 整组回收依赖 `taskkill /T` 之类的替代实现（当前没有）。
- 代码具备 `stop` 和 `rt.quit` 两个入口：前者发送进程信号，后者通过运行时请求退出。Windows 的实际退出与后代进程回收仍待验证，**衍生子进程可能变孤儿**。

**W5｜server 优雅关停依赖 `SIGTERM`**

- `src/mcp-stdio.mjs:143`：`process.once('SIGTERM', shutdown)`。
- Windows 上父进程用 `TerminateProcess` 终止子进程时**不会**投递 SIGTERM → 该 handler 不执行。目标提交新增的「stdin EOF / 断连即取消并清理」路径（`src/mcp-stdio.mjs`，`verification/FIXES-20261016.md` 第 2 节）在 Windows 上是否足以兜住清理，**必须在 Windows 实测**（Mac 上我们只验证了显式 stop 与自然退出两条路径）。
- 残留兜底已存在：`godot_session(action="cleanup")`（本次 `swept:[]`）。

**W6｜Godot 的获取/解包链在 Windows 上未经证实，且解包后不解析 exe**

- 资产名按平台选择是对的：`scripts/setup.mjs:69-75`（win32 分支在 `:72` → `Godot_v4.7.2-stable_win64.exe.zip`）。
- 解包：`scripts/setup.mjs:125-127` 依次尝试 `unzip -q -o` → `tar -xf` → `ditto -x -k`；`:186` 三者全不可用时提示手工解压。`unzip`/`ditto` 在 Windows 上不存在；现代 Windows 自带的 `tar.exe` 可能可解 zip，但**不能据此断言解包一定成功**（属 Windows 待测）。
- **解包之后不解析产物**：`:184` 拿到 `tryUnzip` 结果后，`:190` 只用 `godotStatus(undefined)` 重新走 W2 那套 macOS-only 解析器；`:138` 的 `locateGodotBinary`（专为「解包后找出可执行文件」而写、`:144` 能认 `.exe`）**零调用点**。→ 官方版本化文件名 `Godot_v4.7.2-stable_win64.exe` 落在 `tools/` 下仍可能解析不到。
- 结论：安装链需整体适配（解包回退 + 解包后解析并校验 exe），**不是「换个解压命令」就完事**。

### 5.3 静态看可沿用的机制（仍待 Windows 实机验收）

**W7｜桥的传输形态**：编辑器桥 WebSocket 与运行时桥均为**硬编码 `127.0.0.1` 的 TCP**，非 Unix domain socket。
`godot/addon/godot_mcp_bridge/mcp_bridge.gd:87`（`_tcp.listen(port,"127.0.0.1")`，端口 9089）、`godot/runtime/godot_mcp_runtime.gd:126`（端口 9091）、客户端侧 `src/bridge.mjs:175,275,438`。本次实测走的就是这条链路（`rt.info` → `listening:true, runtime_port:9091`）。

**W8｜零足迹注入**：`override.cfg` 追加 `[autoload]` + `.godot/mcp_bridge/godot_mcp_runtime.gd`，全部走 `res://`/项目相对路径（`src/inject.mjs:33-34,156-214`）→ 与盘符、路径分隔符无关。本次 macOS 实测通过。

**W9｜嵌套助手脚本目录**：`user://mcp_tmp` → 系统临时目录回退（`godot/ops.gd:25,27,505-580`），`user://` 在 Windows 解析为 `%APPDATA%\Godot\app_userdata\<项目>` → 可移植。（注意：**脚本内容本身**仍受 W1 阻塞。）

**W10｜状态目录**：`src/inject.mjs:43` 与 `src/diagnose.mjs:19` 用 `os.homedir()/.local/share/godot-mcp` → Windows 下会建 `C:\Users\<u>\.local\share\godot-mcp`。**能工作但不符合 Windows 惯例**；可用 `GODOT_MCP_STATE_DIR` 改写。不阻塞。

**W11｜profile 路径与命令：取值来源正确，但当前写不进去（受 W0 阻挡）**

- `scripts/setup.mjs:45`（`os.homedir()/.dsh/profiles/desktop`，可用 `--profile` / `DSH_PROFILE_DIR` 覆盖）、`:59`（`process.execPath`，Windows 即 `node.exe` 绝对路径）、`:217`（`cwd: os.homedir()`）——三个取值来源本身是平台中立的。
- 但生成的文本要过 `validatePatchText`（W0：盘符被拒）且路径未加引号（W0：真实 YAML 截断）。**因此不能声称「Windows 上重跑 setup 就能正确接线」**；W0 两处适配是接线的前置条件。
- 另：现有 macOS profile 不能直接复用（`command` 指向 POSIX node 绝对路径，见 `cordis.patch.yml:87-90`）。

**W12｜`caffeinate`**：`src/processes.mjs:23,30` 由 `process.platform !== 'darwin'` 守卫，Windows 自动跳过（`src/server.mjs:386` 也注明仅 macOS）→ 非问题。

### 5.4 Windows 迁移方案（建议顺序，**本轮未实施**）

1. **先决**：Windows 上装 Node ≥ 20，clone 仓库（`tools/`、`reference/`、`demo-game/` 不在仓库内，需另行准备 Godot）。
2. **配置层（必须先做，见 W0）**：改 `scripts/lib/profile-patch.mjs` 的 `validatePatchText`（`:118` 函数 / `:129` command 正则，需接受盘符与 UNC）与 `buildEntryBlock`（`:38` 起，所有路径标量统一加引号），并用真实 YAML 解析器核对结果。
3. **接线**：`node scripts/setup.mjs --profile <DSH profile 目录>`。注意**没有 `--godot` 参数**——`scripts/setup.mjs:324` 的用法行只列 `--check` / `--download-godot` / `--godot-zip <zip>` / `--profile <目录>` / `--keep-deps`；显式引擎路径只能走环境变量 `GODOT_MCP_GODOT`（见 `:210` 的提示与 `src/godot.mjs:75`），且**必须先完成第 2 步**才写得进去（否则被同一自检拒绝）。
4. **安装链（W6）**：补「解包回退 + 解包后解析并校验 exe」；`scripts/setup.mjs:138` 的 `locateGodotBinary` 目前是零调用点的死代码。
5. **探针（W3）**：`scripts/lib/probe-mcp.mjs:22` 按平台保留系统变量，再做真实子进程探针。
6. 只冒烟 L0/L3：`godot`（非嵌套 op）、`godot_session`、`godot_connect`、`godot_status` 走 TCP + 零足迹注入，预期可用（W7/W8）。
7. `run_project`/`export_project`/`import_assets`/deep `parse_check`/`gdscript` **预期在 Windows 上失败**，直到 `sh_capture()`（`godot/ops.gd:525-604`）换成原生无 shell 实现（`:589` 的 `OS.execute("/bin/sh", …)` 与 `:552-561` 的 POSIX 脚本都要去掉）。
8. **进程树与退出（W4/W5）**：实测并补 `taskkill /T /F` 或 Job Objects，不能只把 SIGTERM 改名。
9. **需要源码适配的清单（至少）**：W0 配置层、W1 `sh_capture`、W2+W6 安装与定位、W3 探针、W4/W5 进程树与退出。它们分属**安装、运行、回收**三个环节，**没有任何一项可以单独称为「唯一的大项」**，需分别改造与验收。
10. 验收口径必须重跑：**不能在 Windows 上直接引用本报告第 2 节的冒烟绿灯**。

---

## 6. 复现问题与观察（不影响本轮验收结论）

**6.1 `stop` 之后的会话记录仍显示 `bridge.injected: true`**
`godot_session(action="list")` 里已结束的会话记录仍带启动时快照 `bridge.injected:true` / `recovered.restored:false`，而**文件系统状态是正确的**（`override.cfg` 已还原、备份与桥目录已删）。属记录字段未随清理刷新（展示层/元数据问题），严重度低。建议主审确认是否为预期。

**6.2 `parse_check{deep}` 对合法脚本返回 `suspect: 1`**
`checked:1, errors:[], unique_errors:0, suspect:1`。Codex 主审已核对 `godot/ops.gd`：`deep=true` 会将所有目标放入逐文件检查队列，`suspect` 返回该队列长度。因此这里是 1 个文件接受深度检查，错误数为 0；属于字段解释不足，不是检测到 1 个错误。

**6.3 `godot_session(action="game")` 返回后桥尚未开始监听**
会话回报在 `uptimeMs:2` 时即返回，此刻 `godot_connect(rt.info)` 得到 `connect ECONNREFUSED 127.0.0.1:9091`；约 4s 后（`lsof` 确认 62679 在 9091 LISTEN）重试即成功。属**启动竞态**而非缺陷，但调用方需要自带重试/等待。建议（非本轮范围）：`game`/`editor` 返回前等待端口就绪，或在 `godot_connect` 失败信息里提示「桥可能还在启动，稍后重试」。

---

## 7. 未完成项 / 明确未验证

1. **未在 Windows 上做任何实测**（本轮无 Windows 环境）。第 5 节所有分级以「静态证据 + 推论」为限；标注 `Windows 待测` 的条目必须在真实 Windows + DSH 上复验后才能定级。
2. **未实施任何 Windows 源码适配**（按 Codex 中途指令与任务约束，适配由主审负责）。第 5 节的「需要适配」清单是分析结论，**不是已完成项**。
3. **L2 编辑器桥未测**：9089 全程 `listening:false`，且本轮未调用 `godot_session(action="setup")`（约束禁止更新桥插件）→ 编辑器桥的连接、场景读写、UndoRedo 一律未验证。
4. **`export_project` / `import_assets` 未测**；`run_project` 只跑了 headless 单场景一次。
5. **DSH 侧的用户取消入口未验证**：本会话没有可用的取消动作，因此 `notifications/cancelled` 路径**未经 DSH 工具验证**。该项的独立证据来自仓库协议/生命周期测试，本报告**不把它计为 DSH 验收**。
6. **DSH 未运行仓库测试套件**；仓库套件的独立验证由 Codex 主审完成，记录在其报告 [WINDOWS-MIGRATION-20261016.md](WINDOWS-MIGRATION-20261016.md)「本轮交付边界」：`npm test` 79/79、`node scripts/verify-wiring.mjs` 15/15、`node scripts/verify-mcp.mjs` 17/17，三条命令退出码均 0，并独立计算构建指纹为 `3e3aa064b2a1`。**这些结果归主审，不是本 DSH 会话跑出来的**（本报告第 1.6 节的指纹交叉校验是执行者另做的一次只读计算）。
   - 目标提交自述 191/191（`verification/FIXES-20261016.md`）属**作者声明**，本报告不背书，也不计入本轮验收。

---

## 8. 收尾

**已完成**

- 专属临时项目 `/private/tmp/godot-mcp-dsh-verify-20261016` 与导出树 `/private/tmp/godot-mcp-head-698790c`：**已删除**（`rm -rf` exit 0，`ls` 确认不存在）。
- 本任务创建的 Godot 进程（62679、62866 及其 `caffeinate` 包装 62680、62867）：**已全部退出**（`pgrep -fl 'godot-mcp-dsh-verify'` 无输出，rc=1）。
- 零足迹注入残留：`override.cfg` 已还原、`override.cfg.mcp-backup` 与 `.godot/mcp_bridge/` 已删、`~/.local/share/godot-mcp/transient.json` = `{"projects":{}}`、`godot_session(action="cleanup")` → `swept:[], count:0`。
- MCP server：仅剩 1 个进程（PID 62501），`stale:false`，两桥端口未监听，会话全部 `running:false`。
- 临时项目在 Godot 用户目录下的助手脚本目录 `…/app_userdata/DshVerify20261016/mcp_tmp/`：**空**（0 项）——反证 `ops.gd` 的助手脚本「用后即删」生效。
- 未触碰他人资源：`/private/tmp/godot-mcp-dsh-update-20261016.json` 属监督者桥文件，保留；`…/app_userdata/` 下其他项目目录与 `export_templates/` 未动。

**用户数据目录清理（主审已完成）**

- 路径：`~/Library/Application Support/Godot/app_userdata/DshVerify20261016/`，**20K**，全部是 Godot 引擎自生成内容（`logs/` 5 个日志 + `shader_cache/`；`mcp_tmp/` 为空）。
- 执行者删除时被拒：`rm -rf` 返回 `Operation not permitted` —— **DSH `workspace-write` 文件沙箱拒绝工作区外写入**（任务 writeScope 虽含该目录，实际生效的是 DSH 沙箱）。未申请提权，因为属装饰性清理、不影响验收。
- **Codex 主审已检查该路径仅含本任务生成的日志和缓存、无符号链接，随后删除并确认 `task_userdata_removed True`。该目录现已不存在。**
- 影响：**无**。不含配置、不含注入状态、不含助手脚本；项目本体已删除，`transient.json` 无引用，无进程持有。
- 证据留存：临时项目、`shot.png` 与导出树均已删除（见上「已完成」），故本轮留存的是**公开工具调用结果**，不含可再打开的产物文件；本报告不重建、不重跑这些调用。

**本任务唯一保留的文件**：本报告（`verification/DSH-UPDATE-20261016.md`）。本任务自身**无源码改动、无提交、未编辑任何已有文件**。返工收尾时 `git status` 另见主审正在进行的 ` M README.md`（+3 行，见第 4 节归属说明）——**不属本任务**，执行者未改动也不会回退。HEAD 仍为 `698790cc929ad036610ca813bdc21369781a07e5`。

主审修订：上述 Windows 路径条件、`suspect` 语义、表格排版及最终缓存清理状态由 Codex 独立核对并修订。运行时代码未修改。
