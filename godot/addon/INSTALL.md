# Godot MCP Bridge — 安装说明（L2 编辑器层 + L3 运行中游戏层）

本目录是 Godot MCP 的**编辑器侧与运行时侧**产物，与无头层 `godot/ops.gd` 完全独立
（互不引用任何符号，可单独安装）。

| 层 | 源文件（本仓库） | 安装到目标项目后 | 监听 |
|---|---|---|---|
| L2 编辑器实时层 | `godot/addon/godot_mcp_bridge/`（`plugin.cfg` + `mcp_bridge_plugin.gd` + `mcp_bridge.gd`） | `res://addons/godot_mcp_bridge/` | WebSocket `127.0.0.1:9089` |
| L3 运行中游戏层 | `godot/runtime/godot_mcp_runtime.gd` | `res://addons/godot_mcp_bridge/runtime/godot_mcp_runtime.gd`（作为 autoload，位置可自选） | TCP `127.0.0.1:9091` |

已验证环境：Godot **4.7.2-stable.official.ed1daf0bf**（macOS，Apple M1）。
协议契约见 `DESIGN.md` §2.2 / §2.3（冻结）。

---

## 1. 安装 L2（编辑器插件）

```bash
# <PROJECT> 是你的 Godot 项目根目录（含 project.godot）
mkdir -p "<PROJECT>/addons"
cp -R godot/addon/godot_mcp_bridge "<PROJECT>/addons/"
```

启用插件（二选一）：

1. **编辑器 UI**：项目 → 项目设置 → 插件 → 勾选 `Godot MCP Bridge`。
2. **手写 project.godot**（便于自动化，`<PROJECT>/project.godot`）：

```ini
[editor_plugins]

enabled=PackedStringArray("res://addons/godot_mcp_bridge/plugin.cfg")
```

启动编辑器后，插件会在 `_enter_tree()` 里创建一个 `McpBridge` 子节点并监听 9089：

```bash
# 普通（带界面）编辑器
"<GODOT>" --editor --path "<PROJECT>"

# 无头编辑器：插件同样加载，除少数依赖 Inspector/视口的操作外均可用
"<GODOT>" --headless --editor --path "<PROJECT>"
```

自检（任意 WebSocket 客户端）：

```jsonc
// 发送（行分隔 JSON，文本帧）
{"id":"1","op":"editor.info","params":{}}
// 期望
{"id":"1","ok":true,"op":"editor.info","data":{"edited_scene":"res://...","bridge_port":9089, ...}}
```

## 2. 安装 L3（运行中游戏 autoload）

```bash
mkdir -p "<PROJECT>/addons/godot_mcp_bridge/runtime"
cp godot/runtime/godot_mcp_runtime.gd "<PROJECT>/addons/godot_mcp_bridge/runtime/"
```

注册 autoload（`<PROJECT>/project.godot`），名字任意，`*` 表示启用单例：

```ini
[autoload]

McpRuntime="*res://addons/godot_mcp_bridge/runtime/godot_mcp_runtime.gd"
```

`res://addons/godot_mcp_bridge/runtime/` 只是与设计文档一致的默认位置；
`godot_mcp_runtime.gd` 是**自包含**脚本，放在项目任意路径并用 autoload 引用即可。

> L1 的 `godot install_runtime` 操作就是自动完成第 2 节这两步
> （复制脚本 + 写 `[autoload]` 段），手工安装效果相同。

自检：

```jsonc
{"id":"1","op":"rt.info","params":{}}
// 期望 {"id":"1","ok":true,"op":"rt.info","data":{"scene":"/root/Main", ...}}
```

## 3. 配置

| 项 | 默认 | 覆盖方式 |
|---|---|---|
| L2 端口 | 9089 | 环境变量 `GODOT_MCP_BRIDGE_PORT` |
| L3 端口 | 9091 | 环境变量 `GODOT_MCP_RUNTIME_PORT` |
| 绑定地址 | 仅 `127.0.0.1`（硬编码，不对外暴露） | — |
| L3 release 门控 | release 导出**不监听** | `GODOT_MCP_RUNTIME_FORCE=1` 强制开启；`GODOT_MCP_RUNTIME_DISABLE=1` 强制关闭 |
| 流量日志 | 关闭 | `GODOT_MCP_BRIDGE_DEBUG=1` / `GODOT_MCP_RUNTIME_DEBUG=1`（打到编辑器/游戏日志） |

### 3.1 安全门控：L3 什么时候才会监听（重要）

L3 端口**没有任何鉴权**，而 `rt.eval` 等于任意代码执行。因此 `godot_mcp_runtime.gd`
把它当作**开发期设施**，只在下列情况监听：

| 运行形态 | 是否监听 | 判定依据 |
|---|---|---|
| 编辑器内 play / 编辑器二进制跑游戏 | ✅ 监听 | `OS.has_feature("editor")` |
| debug 构建（含 `--export-debug` 导出的包） | ✅ 监听 | `OS.is_debug_build()` |
| 任意构建 + `GODOT_MCP_RUNTIME_FORCE=1` | ✅ 监听（刻意 opt-in） | 环境变量 |
| **release 导出**（`--export-release`）成品 | ❌ **不监听** | 以上都不成立 |
| 任意构建 + `GODOT_MCP_RUNTIME_DISABLE=1` | ❌ 不监听（最高优先级） | 环境变量 |

* release 成品里：**不绑定端口、不开 `_process`、不 push_error/push_warning**（只在
  `--verbose` 时打一行 `bridge disabled (...)`），游戏行为与没装桥时一致。
* 确实要远程调试一个 release 包（例如内部测试机）时，用
  `GODOT_MCP_RUNTIME_FORCE=1 ./YourGame` 显式开启；不要把它写进发布流程。
* 判断结果可以在 `rt.info` 的 `gate` 字段看到，例如
  `"open: editor"` / `"open: debug build"` / `"open: forced by GODOT_MCP_RUNTIME_FORCE"`。
* L2（编辑器插件）天然只存在于编辑器进程里，导出的游戏不含它。

## 4. 协议

```
请求   {"id":"<任何 JSON 值>","op":"editor.info","params":{...}}
响应   {"id":<原样回填>,"op":"editor.info","ok":true,"data":{...}}
       {"id":<原样回填>,"op":"...","ok":false,"error":"...","data":{...}?}
```

* 传输：L2 为 WebSocket **文本帧**（响应帧尾带 `\n`；请求按 `\n` 分帧，
  也容忍"一条完整 JSON 对象不带换行"）；L3 为 TCP 上的行分隔 JSON。
* 分帧：同一连接内可一次发送多条请求；服务端按 **FIFO 队列**逐条处理
  （同一时刻只有一个任务在执行），队列上限 64，超出即回 `queue full` 错误。
* 防重入：`_busy` 看门狗 30s。若某个 op 长时间不返回，看门狗会解除占用并回一条
  `bridge/runtime watchdog` 错误，避免整条队列死锁。
* 客户端可发 `id` 为任意 JSON 值（字符串/数字/null），响应原样回填。

### L2 op（`addons/godot_mcp_bridge/mcp_bridge.gd`）

| op | params | data（要点） |
|---|---|---|
| `editor.info` | `{}` | `godot_version, godot_version_info, project_path, project_name, edited_scene, open_scenes[], unsaved_scenes[], playing, playing_scene, bridge_port, headless, clients, requests_served, last_error` |
| `editor.scene_tree` | `{max_depth?, with_properties?}` | `{tree:{name,type,path,script?,children[]}, edited_scene, node_count}`；`path` 相对编辑中的场景根（根为 `"."`） |
| `editor.select` | `{node_path, clear?}` | `{selected, selection_count}`（非 headless 时还会 `edit_node` 聚焦 Inspector） |
| `editor.add_node` | `{parent_path?, type, name?, properties?}` | `{node_path, node_name, type, parent_path, properties[], undoable:true}`；走 `EditorUndoRedoManager`，可 Ctrl+Z |
| `editor.set_property` | `{node_path, property, value}` | `{node_path, property, value, previous, undoable}`；按属性声明类型把 JSON 转成 Godot 值 |
| `editor.remove_node` | `{node_path}` | `{removed, node_name, undoable}`；拒绝删除场景根 |
| `editor.save_scene` | `{}` | `{saved, scene_path}` |
| `editor.open_scene` | `{scene_path}` | `{opened, confirmed, scene_path, edited_scene, open_scenes[]}` |
| `editor.reload_scripts` | `{reload_open_scenes?}` | `{scanned, scan_finished, still_scanning, reloaded_scenes[]}`；默认不重载场景（避免丢弃未保存修改） |
| `editor.run` | `{scene?}` | `{started, playing, playing_scene}`（缺省跑主场景） |
| `editor.stop` | `{}` | `{was_playing, stopped, playing}` |
| `editor.execute` | `{source, timeout_ms?, echo_source?}` | **逃生舱**，见下 |
| `editor.console_log` | `{limit?, log_file?}` | `{lines[], count, source, log_path, engine_log_lines[], bridge_lines[], note}` |
| `editor.ping` / `editor.node_info` / `editor.save_all_scenes` / `editor.list_open_scenes` / `editor.reload_scene` / `editor.bridge_status` | — | 附加便利 op |

所有 op 同时接受去掉 `editor.` 前缀的短名（如 `scene_tree`）。

### L3 op（`godot_mcp_runtime.gd`）

| op | params | data（要点） |
|---|---|---|
| `rt.info` | `{}` | `project_name, godot_version, scene, scene_file, node_count, fps, frame, paused, time_scale, window_size, headless, runtime_port, gate, listening, uptime_ms, os` |
| `rt.scene_tree` | `{max_depth?, with_properties?}` | `{tree, node_count}`；`path` 为绝对 `/root/...` |
| `rt.get_node` | `{node_path, with_properties?}` | 名称/类型/路径/脚本/子节点/分组/信号/属性 |
| `rt.get_property` | `{node_path, property}` | `{value, type}` |
| `rt.set_property` | `{node_path, property, value, type_hint?}` | `{value, previous, changed}` |
| `rt.call_method` | `{node_path, method, args?}` | `{result, arg_count}` |
| `rt.screenshot` | `{}` | `{format:"png", png_base64, width, height, bytes, headless, captured_frame}`（只回一个 base64 字段；data URI 自行拼前缀） |
| `rt.input` | `{type?, ...}` | `type`: `action`/`key`/`mouse_button`/`mouse_motion`/`text`；`{action,pressed?,strength?}`、`{key\|keycode,pressed?,shift?,ctrl?,alt?,meta?}`、`{x,y,button,pressed?}`、`{x,y,relative_x,relative_y}` |
| `rt.eval` | `{source, timeout_ms?, echo_source?}` | **逃生舱**，同 `editor.execute` |
| `rt.quit` | `{exit_code?}` | `{quitting, exit_code}`（响应发出后才退出） |
| `rt.ping` / `rt.wait` / `rt.performance` | — | 附加：`rt.wait {frames}` 对"注入输入后等几帧"很有用 |

所有 op 同时接受短名（如 `info`、`screenshot`）。

### 逃生舱语义（L2 `editor.execute` / L3 `rt.eval`）

* `source` 若以 `extends` 开头 → 原样编译；否则包一层

  ```gdscript
  extends Node
  var mcp_result = null
  func MCP_RESULT(v): mcp_result = v
  func _run():
      <你的 source，整体缩进一级>
  ```

* 结果回传三种写法都支持：`mcp_result = <值>`、`MCP_RESULT(<值>)`、`return <值>`。
* 包装脚本会作为桥节点/autoload 的子节点入树，因此可用 `get_tree()`、`get_node()`、
  `EditorInterface`（L2）等。
* `timeout_ms` 默认 15000；超时返回 `ok:false` 并提示协程仍在后台运行。
* 编译失败时响应为 `ok:false` + `data.source`（实际编译的完整源码，便于定位行号）。

## 5. 已知限制（真机验证结论，详见 `verification/bridge.md`）

1. **`rt.screenshot` 在 `--headless` 下不可用**：dummy 渲染器没有帧缓冲，op 会在
   触碰纹理前直接返回明确错误。需要真实渲染时用正常（带窗口）方式运行游戏。
2. **`editor.console_log` 读的是日志文件，不是编辑器 Output 面板的内存缓冲**：
   GDScript 无法读取编辑器控制台（Godot 4.7 未向脚本暴露 `EditorLog`）。取值优先级为
   显式 `log_file` 参数 → `user://logs/godot.log`（被编辑器 play 的游戏会写这里）→
   编辑器数据目录。`source` 字段说明本次来自哪里；拿不到真日志时回退到桥自身环形缓冲，
   并在 `note` 里说明。
   * 让 L2 读到"编辑器自己的日志"的可靠做法：编辑器用 `--log-file <绝对路径>` 启动，
   调用时把同一路径作为 `log_file` 传入（Godot 编辑器会吃掉自己的命令行参数，
   桥无法从 `OS.get_cmdline_args()` 里看到 `--log-file`，那里只有 `["--editor"]`）。
3. **撤销历史是"按场景"的**：`EditorUndoRedoManager` 的动作落在
   `get_object_history_id(场景根)` 对应的历史（实测为 1），不是全局历史 0。
4. `editor.remove_node` 拒绝删除被编辑场景的根节点（请用 `editor.open_scene` 切换场景）。
5. 端口被占用时不会崩溃：L2 记 `push_error` 并保持编辑器可用（`editor.bridge_status`
   可查 `last_error`）；L3 记 `push_error` 并保持游戏运行。
6. **release 导出**：桥默认不监听（§3.1，已用真实导出成品验证）；此时 `rt.*` 全部不可用，
   这是设计目标而非缺陷。导出后的成品里 `rt.info.project_path` 为空字符串
   （`ProjectSettings.globalize_path("res://")` 在导出包中没有意义），其余字段正常。
   `rt.screenshot` 在导出包里正常（只要不是 `--headless` 运行）。

## 6. 卸载

1. 关闭插件（插件设置里取消勾选，或删掉 `project.godot` 的 `[editor_plugins] enabled` 项）。
2. 删除 `project.godot` 里 `[autoload]` 的 `McpRuntime` 行（如装了 L3）。
3. 删除 `res://addons/godot_mcp_bridge/`。

## 7. 许可

`mcp_bridge.gd` / `godot_mcp_runtime.gd` 中的 JSON↔Variant 转换辅助函数改写自
[tugcantopaloglu/godot-mcp](https://github.com/tugcantopaloglu/godot-mcp)（MIT，
Copyright (c) 2025 Tugcan Topaloglu；上游为
[Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp)，
Copyright (c) 2025 Solomon Elias）。仓库根 `NOTICE` 保留原始版权声明。
