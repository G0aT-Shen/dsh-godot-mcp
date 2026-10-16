# Windows 迁移：实施状态与真实回归证据（执行者侧）

这是执行者第 2 轮的历史快照，包含中间构建和当时的网络限制，不代表最终验收。最终结果以 [主审验收报告](../verification/WINDOWS-IMPLEMENTATION-20261016.md) 为准。

日期：2026-10-16（第 2 轮）。基线 commit `fc58235e3f4a4d7aad4e2491ab7b4165b208afb3`（未提交、未推送）。
主审侧的设计与验收文档在 `verification/`（归主审维护）；本文件只记录**执行者在本机真实跑出来的证据**与未验收边界。

## 1. 第 2 轮当时的本机回归（中间版本，命令与退出码）

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm test` | 0 | **121/121 通过，0 失败 0 跳过**（9 个测试文件显式枚举，不依赖 shell glob） |
| `node scripts/verify-wiring.mjs` | 0 | 15/15（按 profile 真起一次 server，工具 5 个，构建指纹一致） |
| `node scripts/verify-mcp.mjs` | 0 | 17/17（干净环境初始化 / tools / 错误码） |
| `node scripts/verify-e2e.mjs` | 0 | 19/19（建项目→场景→节点→脚本→运行→逃生舱→装桥） |
| `node scripts/verify-l3.mjs --headless` | 0 | 63/63（运行时桥 / 零足迹注入 / 注入生命周期 / attach-detach） |
| `node scripts/verify-diagnostics.mjs` | 0 | 29/29（新增第 4 节：检查没跑完不得谎报「没有错误」） |
| `node scripts/setup.mjs --check` | 0 | 6 项通过、0 未就绪（探针环境按 DSH 语义重建） |
| `node scripts/verify-export.mjs` | 0 | 10/10（release 门控 + 进程未提前退出；**该文件现由主审维护**） |

## 2. 关键实测（不是推断）

### 2.1 Godot 的进程原语（决定嵌套执行与回收方案）

| 探针 | 实测结果 |
|---|---|
| `OS.execute("/bin/echo", ["$HOME", …])` | 输出 `/Users/hanyangshen a b 'q' x;y` → 字面量 `$HOME` **被 shell 展开**，证明 `OS.execute` 会拼命令行交给 shell |
| `OS.create_process(node, [script, "--headless", "--path", "/a b/中文 #1"])` | 返回 pid；参数逐字传递（含空格/中文/`#`）；`OS.is_process_running` 真、`OS.kill` 后为假 |
| Godot 子进程的进程组 | `ps -o pid=,ppid=,pgid= -p <child>` → `68585 68582 68585`，**子进程 pgid = 自己**：Godot 会给 `OS.create_process` 的子进程新建进程组 |

结论：嵌套执行改为「`OS.create_process` 启动 Node helper（无 shell）+ JSON 请求文件」；
**`detached:false` 并不保证与外层同组**，回收只能靠「杀之前按 pid 快照后代」+ Windows 的
`taskkill /PID <root> /T /F`（必须在 root 仍存活时调用）。

### 2.2 真实 Godot → helper → 嵌套 Godot 的取消

`test/nested-godot-cancel.test.mjs`：外层 Godot 执行 `run_project`（经 Node helper 拉起嵌套 Godot），
中途取消 → 断言三层全部回收、进程表里不再有指向该项目的进程。实测 kill 明细：

```
{"ok":true,"method":"process-group","force":true,"descendants":2,"group":true,"self":true,
 "pid":69013,"closed":true,"survivors":[]}
```

`descendants: 2` 正是「另一个进程组里的 helper + 嵌套 Godot」——靠进程组是收不到的。

### 2.3 官方包 → 解包 → 定位 → 真跑校验

本机 GitHub 直连被网络策略拒绝（`CONNECT tunnel failed, response 403`），拿不到官方 win64 zip；
用本机真实存在的官方 macOS zip 跑通同一链路：

```
asset name (darwin): Godot_v4.7.2-stable_macos.universal.zip
unpack via: unzip | failures: []
located: …/Godot.app/Contents/MacOS/Godot
verify --version: {"ok":true,"version":"4.7.2.stable.official.ed1daf0bf"}
RESULT: PASS (official zip -> unpack -> locate -> real --version -> pinnable absolute path)
```

Windows 布局另用**真实构造的 zip**（`Godot_v4.7.2-stable_win64.exe`）走
「zip 头校验 → 解包（tar/pwsh/powershell 回退链）→ 定位版本化 exe」，见
`test/windows-discovery.test.mjs`（10 项）。CI 会用真实官方 zip 复跑同一模块。

### 2.4 配置路径 / YAML

`test/windows-config.test.mjs`：盘符、UNC、空格、中文、` #`、单引号、双引号、反斜杠路径
在「发射 → 兜底解析 → 真实 YAML 解析器」三方一致（仓库 `devDependencies.yaml@2.9.1` +
真实 lockfile，`npm install` 后无需桌面 profile）。旧实现的两处缺陷都有针对性回归：
`command` 必须 `/` 开头导致 `C:\…` 被判缺字段；未引号标量导致 `C:\DSH #1\…` 被截成 `C:\DSH`。

### 2.5 DSH 五工具真实 smoke（桌面 DSH 内，本机）

精确重启**只有 Godot MCP 这个 server 进程**（`kill -TERM 64584`，监管器自动拉起）：

| 步骤 | 结果 |
|---|---|
| `godot_status`（重启前） | pid 64584，`loaded=3e3aa064b2a1` `onDisk=79cfc2af2344` `stale=true` |
| `godot_status`（重启后） | **pid 70470，`loaded=onDisk=c9fc597b2f55`，`stale=false`，`files=14`** |
| `godot`（op=version） | ok，4.7.2-stable official |
| `godot_batch`（version / project_info / list_scenes） | 3/3 ok（不传 project 的步骤按契约报 `PROJECT_NOT_FOUND`） |
| `godot_session(action="game", runtimePort=19091, readyTimeoutMs=20000)` | 启动成功；`ready.ok=true`、`verified=true`、`project=/private/tmp/gmcp-smoke`、`pid=70521`——**证明 port.cfg 被运行时脚本读取**（监听 19091 而不是默认 9091） |
| `godot_connect(target="runtime", op="rt.info", port=19091, project=…)` | ok；`runtime_port=19091`，`ownership.verified=true` |
| `godot_connect(… project=另一个目录)` | **拒绝**：`PROJECT_MISMATCH`（修掉了 `rt.ping` 可作为绕过后门的问题） |
| `godot_session(action="stop", kind="game")` | `stopped=true`；`bridgeCleanup: {removedOverride:true, removedScript:true}`；磁盘复查：`override.cfg` 已删、`.godot/mcp_bridge` 已删、无 `capture_*/result_*/status_*` 残留、`transient.json` 为空 |

## 3. 本轮按主审 review 修掉的实质问题

1. **`runProcess` 静默丢输出**：改造时把 `stdout/stderr` 的 `data` 监听漏掉了，表现为
   「op 没有协议结果（exit=0）」而退出码正确 —— 由 `verify-export` 暴露，已修并加回归
   （含逐字节写入强制切开多字节 UTF-8 的用例）。
2. **POSIX 杀树漏后代**：`kill(-pid)` 失败后只杀目标 pid，孙进程存活。改为**先快照后代再杀**
   （`ps -A -o pid=,ppid=`），并覆盖其他 pgid。
3. **Windows 杀树顺序**：`taskkill /T` 依赖父子关系，必须先杀树再等 close；helper 侧
   「terminating 期间只记状态、杀树完成才落结果、绝不提前 exit」。
4. **`proc-tree` 定时器 TDZ**：`spawn` 抛错时 `finish()` 会先跑，`clearTimeout(timer)` 命中 TDZ
   把真实错误盖掉 —— 已把 timer 初始化提前。
5. **取消/超时有界回收**：`runProcess` 不再 fire-and-forget，reject 前等整棵树结束，
   并把 `kill.ok/survivors/closed` 带进错误；POSIX 复核幸存者并补刀。
6. **就绪探测**：abort 立刻以 `ABORTED` 穿透（sleep 可取消）；期望项目但对面报不出身份 →
   `PROJECT_UNVERIFIED`；realpath 归一（macOS `/var` ↔ `/private/var`）；UNC 直接拒绝。
7. **`parse_check` 不得谎报干净**：超时/137/异常退出/孤儿/残留一律记 `check_failed`，
   顶层新增 `checks_failed` / `incomplete`；exit 0 的 stderr 语法检查保持不变。
8. **注入回收 owner-aware**：记录注入者 pid；注入者还活着或项目仍有活跃会话 → 跳过并汇报原因。
   **不存在「server 启动自动扫一遍」的隐式行为**，只有显式 `godot_session(action="cleanup")`。
9. **probe 环境**：从父环境出发，按 `*KEY|PASSWORD|SECRET|TOKEN*` 与 `DSH_*` 过滤，
   保留 PATH/SystemRoot/TEMP/代理与真实 POSIX PATH（旧实现会把 PATH 覆盖成 `/usr/bin:/bin`）。

## 4. 未完成 / 未验收（不冒称）

- **Windows 实机（桌面 DSH + 五工具 + 交互式场景）未验收**：本轮无 Windows 宿主。
- **Windows CI 结果未知**：`.github/workflows/windows.yml` 由主审维护并推送；
  本机网络拒绝 GitHub 直连，无法在本地复现 Actions 环境。
- **官方 win64 zip 未在本机验证**（代理 403）；Windows 分支用构造 zip + 真实模块代码验证，
  CI 会拉真实官方 zip。
- UNC / junction：UNC **明确拒绝**（防误写），junction 依赖 realpath 归一；
  真机行为待验收。
- 强杀边界：无法保证 Godot 落盘，也不回滚已执行的 GDScript；临时产物在硬杀后可能残留
  （有界清理只在能观察到退出的路径上执行）。
- 未验证：Windows 10 / ARM64、锁屏唤醒、真实窗口截图与输入。
