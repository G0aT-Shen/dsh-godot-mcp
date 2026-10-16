# dsh-godot-mcp

让我在 DSH 里**全盘控制 Godot 引擎**，覆盖从建项目到验收游戏的全部开发步骤。
交付形态是**标准 stdio MCP server**，所以同一个 server 也能给 Codex / Claude Code / Cursor 用。

## 快速开始（换一台电脑 / 全新环境）

前置：**Node ≥ 20**、**Godot 4.7+**（本仓库**不含**引擎二进制，见下）、以及一个装好的 DSH。

```bash
git clone https://github.com/G0aT-Shen/dsh-godot-mcp.git
cd dsh-godot-mcp
node scripts/setup.mjs          # 自检 + 写 DSH 接线（幂等，改动前自动备份）
```

`setup.mjs` 会依次做四件事，任何一步不满足都会明确告诉你缺什么、怎么补：

1. 检查 Node 版本，并取出 node 的**绝对路径**（mcp-client 用 `scrubbedParentEnv()` 起子进程，`PATH` 里的 node 不可靠）；
2. 找可用的 Godot：`GODOT_MCP_GODOT` → 随包 `tools/` → `/Applications/Godot.app` → `PATH`；
   没装就用 `node scripts/setup.mjs --download-godot` 自动下到 `tools/`，
   或者离线解包已有的官方 zip：`--godot-zip ~/Downloads/Godot_v4.7.2-stable_macos.universal.zip`；
3. 在 DSH profile（默认 `~/.dsh/profiles/desktop`）的 `cordis.patch.yml` 里写入/更新 `godot-mcp-client` 条目；
   值没变就一个字节都不改，改了就先备份成 `cordis.patch.yml.before-setup-<时间戳>`；
4. 用配置里那条命令**真的起一次 server**（`initialize` + `tools/list`），确认 5 个工具都在。

然后重启 DSH（或等 mcp-client 热重连），让 agent 调一次 `mcp__godot__godot_status`，
应当看到 `godot` / `opsEngine` / `server.build` 三段 —— 其中 `server.build.stale: false`
表示 DSH 里跑的就是磁盘上这份代码（改完 `src/*.mjs` 后如果变 `true`，按提示 kill 掉那个 pid 即可）。

> 想先看它要动什么、不写任何文件：`node scripts/setup.mjs --check`。
> 只想给 Codex / Claude Code 用、不接 DSH：`codex mcp add godot -- node "$PWD/bin/godot-mcp.mjs"`。

### 仓库里有什么、没有什么

| | 说明 |
|---|---|
| 有 | 全部源码（Node 侧 + GDScript 三层）、零运行时依赖、9 个验收套件、真机验证证据（`verification/`） |
| 没有 | **Godot 引擎二进制**（`tools/`，500MB+）、调研用的上游 clone（`reference/`）、示例项目（`demo-game/`）—— 见 `.gitignore` |

平台：**macOS 实测**（Godot 4.7.2 / Apple M1，Node 24）。Linux / Windows 的代码路径存在但**未验证**：
`run_project` 的输出分离依赖 `/bin/sh`，桥的常驻会话用 `caffeinate` 防 App Nap（非 macOS 自动跳过）。

## 它解决什么问题

GitHub 上已有 30+ 个 Godot MCP 项目，但都不适合直接用在 DSH 里：

| 已有方案 | 星 | 为什么不能直接用 |
|---|---|---|
| [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) | 6.0k | 只有 7 个工具，且是给 Claude Desktop 用的独立 MCP server；DSH 里要额外配 MCP 客户端 |
| [tugcantopaloglu/godot-mcp](https://github.com/tugcantopaloglu/godot-mcp) | 486 | 工具多（157），但同样只是 MCP server；运行时桥是单连接、无并发控制 |
| [hi-godot/godot-ai](https://github.com/hi-godot/godot-ai) | 3.0k | 依赖 Python `uvx` 运行时；本机 DSH 内置 Python 无法 dlopen 第三方 C 扩展 |
| [yurineko73/Godot-MCP-Native](https://github.com/yurineko73/Godot-MCP-Native) 等 | <900 | 编辑器内原生 MCP server，但需要外部客户端连接，不是 DSH 插件 |

**本项目的增量**：一个标准 stdio MCP server（DSH 用自带的 `dsh-mcp-client` 接，不自写插件），
内部统一了**三层控制**，并补上了别人都缺的 `gdscript` 逃生舱（保证「任何事先没想到的操作」也能做）。

## 三层控制架构

```
                        ┌─────────────────────────────────────────┐
                        │  dsh-godot-mcp（标准 stdio MCP server） │
                        │  工具：godot / godot_batch /            │
                        │        godot_session / godot_connect /  │
                        │        godot_status                     │
                        └────────────────┬────────────────────────┘
                                         │
                   ┌─────────────────────┼─────────────────────┐
                   ▼                     ▼                     ▼
            L1 无头操作层          L2 编辑器实时层        L3 运行中游戏层
      godot --headless --script   WebSocket 127.0.0.1:9089  TCP 127.0.0.1:9091
      项目/场景/节点/资源/       改当前编辑场景（可撤销）   场景树/属性/调用方法
      设置/文件/脚本/导入/       选中节点/重载脚本/        /输入注入/截图
      导出/运行/校验(41 个 op)   执行任意编辑器脚本
```

- **L1 是冷路径但最全**：每次调用起一个 headless Godot 进程，跑完即退。适合批量生成内容。
- **L2 是热路径**：编辑器开着的时候直接改，改动走 `EditorUndoRedoManager`，用户可 Ctrl+Z 撤销。
- **L3 是验收路径**：游戏跑起来之后，读它的真实场景树、注入输入、截图看效果。
  还可以**冻结时钟按帧推进**（`rt.freeze`/`rt.step`）并用 `rt.digest` 拿结构化状态 ——
  观察永远不会和游戏推进抢跑，也不用为了看一个数字去花 vision token。
- **逃生舱**：每层都有执行任意 GDScript 的能力（`gdscript` / `editor.execute` / `rt.eval`），
  所以即使某个专用 op 没实现，也不会卡住。

### 会话清理与取消

运行时临时注入会保留用户原有 `override.cfg` 的备份，直到最后一次清理；重复注入不会丢掉原始备份。
同一个 server 内，同一项目的游戏与 attach 会话共享注入，最后一个会话结束后才恢复配置。
游戏自行退出、按 id 或 kind 停止都会触发清理；显式 stop 会等待清理完成。
自然退出后的清理失败会在会话的 `cleanupError` 中报告，可用 `godot_session(action="cleanup")` 重试。
强杀 server 后的残留仍需 cleanup 回收。此保护范围是单个 server，多个独立 server 请使用不同项目副本。

stdio MCP 会及时处理 ping、工具发现、自检和 `notifications/cancelled`，其他工具调用保持串行。
取消排队中的请求会阻止它执行；取消 L1 操作会终止它的进程组；连接断开或 stdin EOF 也会取消待执行和正在执行的请求。
取消 L2/L3 桥调用会立即关闭连接、停止等待，**已经在 Godot 内开始的操作不会回滚，也不保证停止**；
脚本协程仍受引擎侧超时和看门狗约束。取消会话启动时，如果进程或 attach 已创建，会先停止并清理它。

## 安装细节

### 1. Godot 引擎

需要 Godot **4.7+**（本项目在 4.7.2-stable 上验证）。三种给法，任选其一：

```bash
node scripts/setup.mjs --download-godot                # 下载到 tools/（macOS / Linux / Windows 自动选资产）
node scripts/setup.mjs --godot-zip <官方 zip 路径>      # 离线：解包本地已有的官方 zip
GODOT_MCP_GODOT=/path/to/Godot node scripts/setup.mjs  # 用已有的引擎（会被钉进 profile 的 env）
```

解析顺序：工具参数 `godot` → `GODOT_MCP_GODOT` → `GODOT_PATH`/`GODOT4`/`GODOT`
→ 随包 `tools/` → `/Applications/Godot.app` → `PATH`。

> 显式指定的路径是**严格**的：给错了会直接报错，不会悄悄换一个 Godot 版本跑。
> 靠环境变量找到引擎时，`setup.mjs` 会把路径写进 profile 的 `env`（因为 DSH 起子进程会洗环境变量）。

### 2. 接入 DSH（当前采用：标准 MCP server）

本项目**以标准 stdio MCP server 的形式**接入 DSH —— 复用 DSH **自带**的
`@deepseek-ai/dsh-mcp-client`，不自写 cordis 插件。`scripts/setup.mjs` 会帮你写好下面这段
（放在 profile 的 `cordis.patch.yml` 顶层数组的 `- insert:` 下；手动粘贴也可以）：

```yaml
    - id: godot-mcp-client
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: godot
        transport: stdio
        command: /absolute/path/to/node      # 必须绝对路径（用 `command -v node` 查）
        args:
          - /absolute/path/to/dsh-godot-mcp/bin/godot-mcp.mjs
        cwd: /Users/you                        # 不传 project 参数时，从它向上找 project.godot
        toolCallTimeoutMs: 900000              # 默认 60s 太短，run_project/export_project 会超时
```

三个必须注意的点：

- `command` **必须用绝对路径**：mcp-client 用 `scrubbedParentEnv()` 起子进程，`PATH` 里的 `node` 不可依赖。
- `toolCallTimeoutMs` 默认 60000，对 `run_project` / `export_project` 这类长任务不够。
- 若 Godot 是靠环境变量才找到的，还要在 `config` 下加 `env: { GODOT_MCP_GODOT: <绝对路径> }`
  —— 环境变量同样不会传给子进程（`setup.mjs` 会自动补上）。

工具会以 `mcp__godot__<name>` 暴露：`mcp__godot__godot`、`mcp__godot__godot_batch`、
`mcp__godot__godot_session`、`mcp__godot__godot_connect`、`mcp__godot__godot_status`。

> **为什么不做 DSH 原生插件**（曾经做过，已停用）：自写 cordis 插件要额外面对
> 服务注入（必须 `inject=['tools']` + `ctx.tools`，用 `ctx.get()` 拿不到）、
> 注册时机、以及"模块被进程缓存、每次改代码都要重启"这几道坎；我在真实环境里
> 连续两轮没能让它稳定激活。而 MCP 路径复用 DSH 已在跑的模块、改 server 源码只需
> **重启那个 server 进程**（`kill -TERM <pid>`，mcp-client 的监管器数秒内自动拉起）
> 即可生效，且同一个 server 还能给 Codex / Claude Code / Cursor 用。
> `godot_status` 会回报 `server.build.loaded / onDisk / stale` —— 「跑的是不是旧构建」
> 不再需要靠猜（这条是真机踩过一次才补上的，见 SUMMARY 第 11 节）。
> 插件源码保留在 `boot.js` + `cordis.patch.yml`，但**未启用**，详见
> [verification/SUMMARY.md](./verification/SUMMARY.md) 第 7 节。

### 3. 装成独立 MCP server（给 Codex / Claude Code 等用）

```bash
node "$PWD/bin/godot-mcp.mjs"                       # 直接当 stdio MCP server 跑
codex mcp add godot -- node "$PWD/bin/godot-mcp.mjs"
claude mcp add godot -- node "$PWD/bin/godot-mcp.mjs"
```

协议层已独立验证（`node scripts/verify-mcp.mjs`，17 项：initialize / tools/list /
tools/call / 错误码，含在**洗过的干净环境**下仍能找到 Godot）。
CLI 也可以不开客户端直接用：`node bin/godot-mcp.mjs status` / `op <op> '<json>'` / `tools`。

## 用法

### 典型全流程

```
1. godot_status                                          # 先自检
2. godot(op="create_project", params={project_path:"/path/game", name:"My Game"})
3. godot(op="create_scene",   params={scene_path:"res://main.tscn", root_type:"Node2D"})
4. godot_batch(steps=[
     {op:"add_node", scene_path:"res://main.tscn", node_type:"CharacterBody2D", node_name:"Player"},
     {op:"add_node", scene_path:"res://main.tscn", parent_node_path:"Player", node_type:"Sprite2D", node_name:"Body"},
     {op:"attach_script", scene_path:"res://main.tscn", node_path:"Player", script_path:"res://player.gd"},
   ])
5. godot_session(action="setup")                         # 装桥，准备热路径
6. godot_session(action="editor")                        # 开编辑器
7. godot_connect(target="editor", op="editor.add_node", params={parent_path:".", type:"Camera2D", name:"Cam"})
8. godot_session(action="game")                          # 跑游戏
9. godot_connect(target="runtime", op="rt.digest")      # 结构化状态（比截图便宜）
10. godot_connect(target="runtime", op="rt.step")       # 冻结后按帧精确推进
11. godot_connect(target="runtime", op="rt.errors")     # 脚本改坏了？带 backtrace 的错误列表
12. godot_connect(target="runtime", op="rt.act")        # 一串输入 + 逐步回报命中了什么
10. godot_session(action="stop", kind="game")
```

### op 速查

`godot` 工具支持 41 个 op，分七类：

- **环境**：`version`
- **项目**：`project_info`、`create_project`
- **场景**：`list_scenes`、`create_scene`、`read_scene`、`add_node`、`modify_node`、
  `remove_node`、`instantiate_scene`、`attach_script`、`connect_signal`
- **设置**：`read_settings`、`write_settings`、`delete_settings`
- **文件**：`list_files`、`read_file`、`write_file`、`delete_file`、`create_dir`
- **脚本/资源**：`find_symbols`、`parse_check`、`resave_resources`、`import_assets`、`export_project`
- **运行/逃生舱**：`run_project`、`gdscript`

完整参数见 `godot` 工具自身的 description，或 [DESIGN.md](./DESIGN.md) §2.1。

## 导出成品

导出模板已装在 `~/Library/Application Support/Godot/export_templates/4.7.2.stable`（macOS 上需要先在
Godot 编辑器里装一次导出模板；Linux/Windows 同理）。两个实测要点：

1. **必须先启用 ETC2 ASTC**，否则 macOS universal/arm64 导出会被 Godot 以 `configuration errors` 直接拒绝：

   ```
   godot(op="write_settings", params={settings:{"rendering/textures/vram_compression/import_etc2_astc": true}})
   ```

2. 导出物是 **`.app` 目录**（bundle），不是单个文件：

   ```
   godot(op="export_project", params={preset:"macOS", output_path:"<项目>/dist/Game.app"})
   ```

> **安全提示**：用 `godot_session(action="setup")` 装过桥的项目，如果直接导出发布，成品里会带上
> 编辑器/运行时桥。运行时桥**已做门控**：release 构建默认不监听，只有显式
> `GODOT_MCP_RUNTIME_FORCE=1` 时才开启（用于刻意要在成品里远程调试的场景）。
> 这条门控是被真实利用后才加上去的 —— 详见 [verification/SUMMARY.md](./verification/SUMMARY.md) 第 6 节。

## 验证

```bash
node --test test/*.test.mjs                          # 单元/插件/安装器（69 项，含构建指纹与 profile 补丁守卫）
node scripts/verify-wiring.mjs    # DSH 接线自检：按配置真起一次 server（没装 DSH 时明确跳过）
node scripts/verify-mcp.mjs       # 协议层：initialize / tools/list / tools/call / 错误码（洗过的干净环境）
node scripts/verify-e2e.mjs       # 端到端：建项目→建场景→加节点→挂脚本→运行→逃生舱→装桥
node scripts/verify-diagnostics.mjs # 诊断质量：级联归属 / 类缓存自愈 / 显示模式回报 / 助手脚本目录
node scripts/verify-l2.mjs        # 编辑器实时桥（真实 WebSocket）
node scripts/verify-l3.mjs --headless   # 运行中游戏控制（零足迹注入 / freeze·step·digest / errors / act·ui / attach），全程无窗口
node scripts/verify-l3.mjs              # 同上，另含截图相关断言（需要真实帧缓冲）
node scripts/verify-export.mjs    # release 导出 + 门控（成品 9091 不监听 / opt-in 后可用）
```

合计 **226 项真机断言**（69 + 15 + 17 + 19 + 25 + 13 + 59 + 9；L3 换成带窗口版是 233 项）。
不含 `verify-mcp` 的口径是 **209 项**（= 69 + 15 + 19 + 25 + 13 + 59 + 9）。
最近一次全量重跑（2026-10-15）的逐套件数字、原始日志与当轮修掉的三个缺陷见
[verification/rerun-20261015-0450/REPORT.md](./verification/rerun-20261015-0450/REPORT.md)
与 [verification/SUMMARY.md](./verification/SUMMARY.md) 第 11 节。

真机验证证据见：
- [verification/ops-gd.md](./verification/ops-gd.md) —— L1 每个 op 的真实命令与输出
- [verification/bridge.md](./verification/bridge.md) —— L2/L3 的真实握手与响应

## 已知限制

- `godot_session(action="editor")` 在纯 headless 下能加载插件，但依赖真实窗口的编辑器功能
  （如 3D 视口截图）不可用 —— 见 verification/bridge.md 的如实记录。
- L2/L3 桥默认只监听 `127.0.0.1`，且**不做鉴权**：任何本机进程都能连。这是本地开发工具的
  定位；不要把端口暴露到公网。
- 桥是单客户端模型（短连接），并发工具调用可能互相排队。
- **headless 下根视口只有 64×64**（dummy DisplayServer），落在视口外的鼠标事件不会被 GUI 派发。
  所以 `rt.ui` / `rt.act` 的 GUI 点击在无头模式下只在这个范围内有效，测真实 UI 交互要带窗口。
  `rt.errors` / `rt.step` / `rt.digest` 不受影响。
- `parse_check` 默认先用进程内编译初筛（快，但同一个进程里全局类解析失败会被缓存，
  后续同结构的依赖脚本可能被漏判为「没问题」）。要一份不漏的报告就传 `deep: true`，
  代价是每个文件一个 Godot 进程。
- `run_project` **默认 headless**。无头用的是 dummy 渲染器，没有帧缓冲，所以
  `rt.screenshot` 与 `await RenderingServer.frame_post_draw` 在那里会失败或永久挂起。
  返回里现在会带 `display` 字段如实说明；要窗口化跑用 `godot_session(action="game")`。

## 由实战踩坑换来的几处设计

这几条都不是推演出来的，是先被坑过一次才补上的：

| 现象 | 根因 | 现在的行为 |
|---|---|---|
| 5 个文件报出同一条错误，看起来像 5 个 bug | 依赖方加载失败时复述被依赖方的诊断；旧解析器还会把「编译依赖失败」的包装帧和引擎自己的 `.cpp` 路径当成根因 | 按 `(origin,line,message)` 归并成 1 条，`affects` 列出受影响的全部文件，主错误排第一 |
| 新建项目里挂脚本必报 `Could not find type X` | 项目从未被扫描，`.godot/global_script_class_cache.cfg` 不存在；而类列表只在引擎启动时载入，同进程内重试无效 | `attach_script` 失败时自动补一次 `--import` 再换新进程重试，结果里带 `retriedAfterImport` |
| 连拍两张截图字节完全相同 / 画面是新的但 HUD 是旧的 | 只 `await process_frame` 会拿到陈旧缓冲 | 改为 `await RenderingServer.frame_post_draw`；L3 验收里有「两次截图必须是不同帧」的回归守卫 |
| 一张截图的 base64 灌进上下文上千 token | `rt.screenshot` 只回 base64，且**默默忽略了传入的 `path`** | 传 `path` 就直接落盘并默认不回 base64；要 base64 显式 `inline: true` |
| `rt.eval` 莫名「等待响应超时」 | 客户端硬编码 15s，而 eval 自己在游戏里还有 15s 预算；报错只说超时，不提补救 | 按 op 自适应默认预算（eval/execute 30s、screenshot 20s）；超时报错直接给出该调哪个参数、并点名 `frame_post_draw` 这个经典挂起源 |
| 没聚焦的 Godot 窗口跑到一半什么都不做了 | 这台机器上窗口失焦会进 App Nap / 空闲休眠，进程活着、端口在听、定时器停摆 | 长驻会话在 macOS 下自动用 `caffeinate` 包住（可用 `keepAwake: false` 关掉）；断言在 stop 时确认释放 |
| 用一次运行时工具就得往用户仓库里提交一个桥 | 原设计把 addon 复制进项目并写 `project.godot` 的 `[autoload]` | 改为**零足迹注入**：只新增 `override.cfg` 与 `.godot/mcp_bridge/`（实测 Godot 会读 `override.cfg` 里的 `[autoload]`），会话结束自动清除，`project.godot` 一个字节都不动 |
| 截图是唯一能看游戏状态的手段，贵且看不出数值差异 | 没有结构化观测 | 新增 `rt.freeze` / `rt.step` / `rt.digest`：冻结时钟后按帧精确推进，状态直接出 JSON |
| 改完脚本「有没有炸」只能靠人去翻游戏 stdout | 没有运行时错误通道 | 新增 `rt.errors`：走 `OS.add_logger(Logger)`，捕获脚本运行时错误 / `push_error` / `push_warning`，**带真实 backtrace**；`rt.step` 还会顺带回报本次推进窗口内新增的错误数 |
| 一次只能注入一个输入，且不知道打中了谁 | 只有单发 `rt.input` | 新增 `rt.act`：一串操作一次跑完，**逐步回报**命中的 Control 与被观察节点的状态变化；配套 `rt.ui` 列出可见控件 |
| DSH 里的工具行为跟仓库对不上，看不出哪边是旧的 | 长驻 server 进程把 ESM 模块缓存在内存里，改完源码不重启就不生效，**且没有任何字段暴露这一点** | `godot_status` 返回 `server.pid` + `build.loaded/onDisk/stale`，`stale` 时直接给出 `kill -TERM <pid>`（mcp-client 会自动拉起）；`initialize` 里也带 `serverInfo.build` |
| 沙箱/只读 HOME 下 `parse_check` 报「没有错误」，其实是**一个文件都没检查** | 嵌套进程的助手脚本只写 `user://mcp_tmp`，写不进去就静默跳过每个文件 | 助手脚本目录 `user://` → 系统临时目录自动回退；可用 `GODOT_MCP_HELPER_DIR` 显式指定；五个嵌套调用点（run_project / gdscript / import_assets / export_project / deep parse_check）在跑不起来时**一律报错**并给出原因与修法 |

## 目录结构

```
bin/godot-mcp.mjs        # CLI + MCP stdio 入口（serve / status / op / tools / install-addon）
src/                     # Node 侧：controller、三层调用、桥客户端、零足迹注入
  build.mjs              #   构建指纹：判断「DSH 里跑的是不是磁盘上这份代码」
  mcp-stdio.mjs          #   MCP 协议层（initialize / tools/list / tools/call / 错误码）
godot/ops.gd             # L1 无头操作引擎（27 op，单行 JSON 协议）
godot/addon/             # L2 编辑器插件（WebSocket 9089，改动走 UndoRedo）
godot/runtime/           # L3 运行时桥（TCP 9091；release 构建默认不监听）
scripts/setup.mjs        # 一键安装 / 接线（幂等，改动前自动备份）
scripts/lib/             # 安装器与自检共用的小模块（含 profile 补丁与 MCP 探针）
scripts/verify-*.mjs     # 9 个真机验收套件
test/                    # 单元测试（协议解析、桥客户端、注入、构建指纹、profile 补丁）
verification/            # 真机验证证据；SUMMARY.md 是验收口径（含已知限制）
```

[DESIGN.md](./DESIGN.md) 是接口契约与工具面设计（三层 op 列表、协议、错误语义）。
`boot.js` + `cordis.patch.yml` 是**已停用**的 DSH 原生插件形态，保留用于记录踩坑（见 SUMMARY 第 7 节）。

## 许可与署名

本项目为 MIT，全文见 [LICENSE](./LICENSE)。L1 无头操作引擎的思路与部分实现参考了
[Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp)（MIT, © Solomon Elias），
L3 运行时桥的协议思路参考了 [tugcantopaloglu/godot-mcp](https://github.com/tugcantopaloglu/godot-mcp)；
完整署名见 [NOTICE](./NOTICE)。调研时 clone 的上游仓库不在本仓库内（`.gitignore` 排除 `reference/`）。
