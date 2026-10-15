# Godot MCP for DSH — 架构与接口契约 v1

目标：让我（以及任何 MCP 客户端）**全盘控制 Godot**，覆盖游戏开发全流程。

## 0. 调研结论（GitHub 开源现状）

| 方案 | 星 | 语言 | 做法 | 可复用性 |
|---|---|---|---|---|
| Coding-Solo/godot-mcp | 6.0k | TS | `--headless --script godot_operations.gd <op> <json>`，7 个 op | **引擎内核可直接复用**（MIT） |
| tugcantopaloglu/godot-mcp | 486 | TS+GDScript | 同左 157 工具 + `mcp_interaction_server.gd`（游戏内 TCP:9090）| 运行时控制思路可复用 |
| hi-godot/godot-ai | 3.0k | Python+GDScript | 编辑器 addons 插件，46 工具，依赖 `uv` | 需 Python 运行时，不采用 |
| yurineko73/Godot-MCP-Native | 851 | GDScript | 原生 MCP server（编辑器内） | 参考 |
| 其余 30+ | <300 | 混合 | 多为上述 fork/变体 | 参考 |

**共同缺口（本项目的增量价值）：**
1. 没有任何一个能作为 DSH 插件加载（都只对外提供 MCP server 或依赖外部 MCP 客户端）。
2. 编辑器**实时**场景树操作（无需重启编辑器）普遍缺失或走单条 TCP 连接、无并发控制。
3. 缺 `execute_gdscript` 这类逃生舱，无法做「一切事后备」。
4. 没有把 无头 CLI / 编辑器 / 运行中游戏 三层统一成一套工具面。

## 1. 三层控制架构

```
DSH 插件 (dsh-godot-mcp)
   │  注册原生工具 godot / godot_batch / godot_bridge
   ▼
Node MCP Server (src/server.mjs)  ←── 同时可独立 stdio MCP（任何客户端可用）
   │
   ├─ L1 无头操作层  godot --headless --script ops.gd <op> <json>
   │     项目/场景/资源/设置/文件/脚本/导入/导出/运行/测试  ← 冷路径，万能
   │
   ├─ L2 编辑器实时层 编辑器 addon (addons/godot_mcp_bridge/) WebSocket + 文件队列
   │     运行中的编辑器内场景树读写、当前选中、编辑器脚本执行  ← 热路径
   │
   └─ L3 运行中游戏层 runtime autoload (godot_mcp_runtime.gd) TCP:9091
         截图/输入注入/节点查询/属性读写/调用方法  ← 验收路径
```

## 2. 接口契约（冻结，改前必须通知所有写方）

### 2.1 L1 无头操作层 — `godot/ops.gd`

调用：
```
<godot> --headless --path <project> --script res://../ops.gd <operation> <json_params>
```
实际由 server 用绝对路径：`<godot> --headless --path <project> --script /abs/ops.gd <operation> '<json>'`

约定：
- `extends SceneTree`，`_init()` 里读 `OS.get_cmdline_args()`，取 `--script` 后两位。
- 每个 op **必须**以 `finish(result_dict)` 结束，输出**单行 JSON** 到 stdout：
  `@@GODOT_MCP@@{"ok":true,"op":"...","data":{...}}`
  失败：`@@GODOT_MCP@@{"ok":false,"op":"...","error":"msg"}` 且 `quit(1)`。
- 非协议输出（Godot 自身的日志）由 server 按前缀过滤，只取 `@@GODOT_MCP@@` 行。
- 文件头必须 `# @tool`（编辑器层不需要，此层不需要）。
- **不要**用 `print()` 输出业务数据，一律走 `finish()`。

必需 op 列表（v1）：

| op | params | data |
|---|---|---|
| `version` | {} | `{version, hash, string}` |
| `project_info` | `{project_path}` | `{name, path, main_scene, settings, godot_version}` |
| `create_project` | `{project_path, name, renderer?}` | `{created, path}` |
| `list_scenes` | `{project_path, pattern?}` | `{scenes:[{path,name}], total}` |
| `create_scene` | `{project_path, scene_path, root_type?, root_name?}` | `{scene_path}` |
| `read_scene` | `{project_path, scene_path, max_depth?}` | `{tree:{name,type,path,properties,children[]}}` |
| `add_node` | `{project_path, scene_path, parent_node_path?, node_type, node_name, properties?}` | `{node_path}` |
| `modify_node` | `{project_path, scene_path, node_path, properties?, new_name?}` | `{node_path, changed[]}` |
| `remove_node` | `{project_path, scene_path, node_path}` | `{removed}` |
| `instantiate_scene` | `{project_path, scene_path, parent_node_path?, instance_path, node_name?}` | `{node_path}` |
| `attach_script` | `{project_path, scene_path, node_path, script_path}` | `{node_path, script}` |
| `connect_signal` | `{project_path, scene_path, from_node, signal, to_node, method, binds?}` | `{connected}` |
| `read_settings` | `{project_path, keys?}` | `{settings}` |
| `write_settings` | `{project_path, settings}` | `{changed[]}` |
| `delete_settings` | `{project_path, keys:[...]}` | `{deleted[]}` |
| `list_files` | `{project_path, dir?, pattern?, recursive?}` | `{files:[{path,type,size}], total}` |
| `read_file` | `{project_path, path, max_bytes?}` | `{path, content, bytes}` |
| `write_file` | `{project_path, path, content}` | `{path, bytes}` |
| `delete_file` | `{project_path, path}` | `{deleted}` |
| `create_dir` | `{project_path, path}` | `{created}` |
| `find_symbols` | `{project_path, path}` | `{classes, functions, signals, exports}` |
| `resave_resources` | `{project_path, paths?}` | `{resaved[]}` |
| `import_assets` | `{project_path, paths?}` | `{imported}` |
| `export_project` | `{project_path, preset, output_path, debug?}` | `{output_path, bytes}` |
| `run_project` | `{project_path, headless?(默认 true), scene?, quit_after?(秒)}` | `{stdout, stderr, exit_code, duration_ms, headless, display("dummy"\|"window"), note?}` |
| `parse_check` | `{project_path, paths?, deep?}` | `{errors:[{path,origin,line,message,cascade,affects[]}], checked, suspect, unique_errors, cascade_errors, deep}` |
| `gdscript` | `{project_path, source, uid?}` | `{result}` — **逃生舱**：把 source 写成临时 `@tool` SceneTree 脚本执行，捕获其 `printerr`/返回值 |

`gdscript` 逃生舱语义：source 是完整 GDScript，须 `extends SceneTree` 或由 wrapper 注入；
约定 source 内调用 `MCP_RESULT(<Variant>)` 全局函数回传结果（wrapper 提供）。

**嵌套进程的约定（`run_project` / `gdscript` / `import_assets` / `export_project` / deep `parse_check`）**：

- 助手脚本目录按优先级：`GODOT_MCP_HELPER_DIR`（显式设置时**严格**只用它）→ `user://mcp_tmp`
  → 系统临时目录。逐个尝试写脚本，写不进去就换下一个。
- **全部候选都失败时必须 `finish_error`**，错误文本包含「试过哪些目录 + 底层 error + 怎么修」，
  并在返回体里带 `spawn_error: true`。调用方**不得**把「跑不起来」当成「没输出 / 没错误」。
- 真机依据：`user://` 不可写（沙箱化 agent / 只读 HOME / CI 容器）时，旧实现只回一句
  `cannot create helper script <路径>`，于是 deep `parse_check` 把「一个文件都没检查过」
  报成 `unique_errors: 0`。见 SUMMARY 第 11 节。

### 2.2 L2 编辑器实时层 — 插件 `addons/godot_mcp_bridge/`

- `plugin.cfg`: `name="Godot MCP Bridge"`, `script="mcp_bridge_plugin.gd"`；`mcp_bridge_plugin.gd extends EditorPlugin`，`_enter_tree()` 里 `add_autoload_singleton("McpBridge", "res://addons/godot_mcp_bridge/mcp_bridge.gd")`（可选）或直接 `EditorInterface`。
- 通信：`mcp_bridge.gd extends Node`（`@tool`），用 `WebSocketPeer` 监听 **127.0.0.1:9089**（server 当客户端）。
- 协议：每帧一条 JSON，行分隔（`\n`）：
  请求 `{"id":"...","op":"editor.info","params":{...}}`
  响应 `{"id":"...","ok":true,"data":{...}}` / `{"id":"...","ok":false,"error":"..."}`
- v1 必需 op：
  - `editor.info` → `{godot_version, project_path, edited_scene, open_scenes[]}`
  - `editor.scene_tree` `{max_depth?}` → 当前编辑场景树
  - `editor.select` `{node_path}` → 选中节点
  - `editor.add_node` `{parent_path, type, name, properties?}` → 走 `EditorUndoRedoManager`（可撤销）
  - `editor.set_property` `{node_path, property, value}`
  - `editor.remove_node` `{node_path}`
  - `editor.save_scene` `{}`
  - `editor.open_scene` `{scene_path}`
  - `editor.reload_scripts` `{}` → `EditorInterface.get_resource_filesystem().scan()` + 重载
  - `editor.run` `{scene?}` / `editor.stop`
  - `editor.execute` `{source}` → **逃生舱**：`GDScript.new()` + `reload()` 后 `new()._run()`，返回其 `mcp_result`
  - `editor.console_log` `{limit?}` → 最近编辑器输出

### 2.3 L3 运行中游戏层 — autoload `godot_mcp_runtime.gd`

- 由 server 用 `--path <project>` + **注入的 autoload**（写 `project.godot` 的 `[autoload]` 或 server 复制一份 overlay 到临时目录）启用；v1 采用**显式安装**：`godot install_runtime` 把文件写入 `res://addons/godot_mcp_bridge/runtime/` 并写 autoload 段。
- 监听 **127.0.0.1:9091**（TCP，行分隔 JSON），语义对齐 2.2。
- v1 必需 op：`rt.info`, `rt.scene_tree`, `rt.get_node`, `rt.get_property`, `rt.set_property`, `rt.call_method`, `rt.screenshot`(→`{path?, inline?}`：给 path 就落盘且不回 base64；不给则回 `png_base64`), `rt.input`(key/mouse/action 注入), `rt.eval`(逃生舱), `rt.quit`。
- v2.1 增补 op（可观测性与扮演玩家）：
  - `rt.errors{limit?,since?,type?,clear?}` → `{errors:[{seq,at_ms,frame,type,error_type,code,rationale,function,file,line,backtrace[]}],total,dropped,next_since,recorder}`。实现走 `OS.add_logger(Logger)`；**`file`/`line` 对 `push_error` 指向引擎内部（实测 `core/variant/variant_utility.cpp`），用户脚本位置只在 backtrace 里 —— 所以定位取 backtrace 中第一个 `res://` 帧**。
  - `rt.act{steps[],frames_per_step?,continue_on_error?,watch?,watch_props?}`：一次调用执行整串输入（`wait/press/release/tap/move/click/text/call`），**逐步回报**「这一步之后被观察节点的状态」，鼠标点击回报命中的 Control（path/class/text/rect/disabled）。序列期间临时解冻（paused 下输入不会被处理），跑完冻回去。
  - `rt.ui{limit?,include_hidden?}`：可见 Control 清单（矩形、text、disabled、mouse_filter）。
  - `rt.step` 的结果里增加 `errors_new`/`errors_total`：改完代码推进几帧就能知道有没有炸。
- v2 增补 op（确定性验收）：`rt.freeze{mode?}`（默认硬冻结：`paused=true` + `time_scale=0`）、`rt.resume`、`rt.step{frames?|ms?|until?,max_frames?,max_ms?}`（帧为确定性单位；`until` 是 Expression，可用 tree/node/self/Engine/Input/Performance/OS/Time/ProjectSettings）、`rt.digest{groups?,paths?,classes?,props?,limit?}`（结构化实体状态 JSON）。
  冻结期间**不要**依赖 `SceneTreeTimer`（走缩放时间，不会触发）；桥自身是 `PROCESS_MODE_ALWAYS`，冻结时仍可响应。冻结超过 120 秒且无客户端连接会自动解冻，避免留下一个卡死的游戏。
- **headless 的 GUI 交互限制（实测）**：无头模式用的是 dummy DisplayServer，**根视口只有 64×64**。落在视口外的鼠标事件不会被 GUI 派发（实测同一按钮：headless `pressed=0 / hovered=null`，带窗口 `pressed=1 / hovered=<Button>`）。所以 `rt.ui`/`rt.act` 的 GUI 命中与点击在 headless 下只在这个范围内有效；要测真实 UI 交互必须带窗口。`rt.errors`、`rt.step`、`rt.digest` 不受影响。
- **桥的形态**：默认**零足迹注入** —— 只写项目根的 `override.cfg`（Godot 会读取其中的 `[autoload]`）与 `.godot/mcp_bridge/`，会话结束自动清除，`project.godot` 全程不被修改。`godot_session(action="setup")` 的提交式安装保留，用于编辑器实时层（L2 插件必须在 `res://addons/` 下）以及需要长期常驻桥的场景。
- `rt.screenshot` 必须在 `await RenderingServer.frame_post_draw` 之后取图；只 `await process_frame` 会拿到陈旧缓冲（实测连拍两张字节完全相同）。

### 2.4 Node server / DSH 工具面

工具（DSH 原生注册，名字短、语义清晰）：
- `godot` — 单次操作。参数：`op`(string) + 扁平参数 + `project`(可选；缺省用当前工作区里的 Godot 项目)。
- `godot_batch` — `{steps:[{op,...}], project?}` 串行执行，返回每步结果。
- `godot_bridge` — L2/L3 控制：`{target:"editor"|"runtime", op, params, port?}`。

`project` 解析优先级：显式 `project` → `GODOT_MCP_PROJECT` → cwd 向上找 `project.godot` → config 默认。

`godot_status` 额外返回 `server`（长驻进程的自述）：

```
server: {
  pid: 36100,
  build: { loaded: "97b940b3be53", onDisk: "97b940b3be53", stale: false, files: 12, checkedAt: "…", note?: "…" }
}
```

- `build.loaded` 是**进程启动时加载的那份源码**的短 hash（`src/build.mjs` 的 `BUILD_INPUTS` 列表），
  `onDisk` 是此刻磁盘上的；两者不一致即 `stale: true`，`note` 给出 `kill -TERM <pid>` 的修法。
- 理由：mcp-client 把 server 当长驻子进程托管，ESM 模块被进程缓存 —— 改完 `src/*.mjs` 不重启就不生效。
  没有这个字段时，「活体工具跑的是旧构建」只能靠对比进程启动时间与文件 mtime 猜（真机踩过一次）。
- `initialize` 的 `serverInfo` 也带 `build`，客户端一连上就能看到自己面对的是哪份构建。

## 3. 安装器与接线（`scripts/setup.mjs`）

换一台干净机器只需要 `node scripts/setup.mjs`（幂等，任何改动前先备份）。契约：

| 步骤 | 行为 | 失败时 |
|---|---|---|
| Node | 校验 ≥ 20 且路径绝对 | 直接退出 1 并说明 |
| Godot | 解析顺序同 §2.1；`--download-godot` / `--godot-zip` 可自动补齐到 `tools/`；靠环境变量找到时把路径**钉进 profile 的 `env`**（子进程环境被 scrub） | 打印三种获取方式后退出 1 |
| profile 接线 | 在 `~/.dsh/profiles/desktop/cordis.patch.yml`（可用 `--profile` / `DSH_PROFILE_DIR` 覆盖）的 `- insert:` 子数组里写入 `godot-mcp-client` 条目；内容相同则**一个字节都不改**；写入前做结构自检，不合格就拒绝写 | profile 不存在 → 打印手动 YAML 片段，不算失败 |
| 依赖清理 | 删除 profile `package.json` 里指向本仓库的历史 `link:` 依赖（MCP 形态不走包解析，留着会让 pnpm 因包名不匹配而失败） | 备份后修改 |
| 自检 | 按配置里的命令**真起一次 server**，断言 `initialize` + `tools/list` 出 5 个工具、`serverInfo.build` 存在、无 stderr 噪音 | 失败则退出 1 |

接线条目的字段（也是 `verify-wiring.mjs` 断言的对象）：`serverName: godot`、`transport: stdio`、
`command` 绝对路径、`args[0]` 指向本仓库的 `bin/godot-mcp.mjs`、`toolCallTimeoutMs: 900000`。

本机参考环境（真机验证所用）：Godot 4.7.2-stable、Node 24.21.0、macOS / Apple M1；
引擎路径可用 `GODOT_MCP_GODOT` 覆盖。

## 4. 署名与许可

复用 Coding-Solo/godot-mcp 的 MIT 代码需保留其版权声明，见 `NOTICE`；本项目整体为 MIT，见 `LICENSE`。
