# L2 / L3 桥接层真机验证报告（task-2）

范围：`godot/addon/godot_mcp_bridge/`（L2 编辑器 WebSocket 层）与
`godot/runtime/godot_mcp_runtime.gd`（L3 运行中游戏 TCP 层）。
全部结论来自**真实 Godot 进程 + 真实网络连接**；文中命令与响应均为实跑原样摘录。

* 验证时间：2026-10-15 02:50–03:01 +08:00
* Godot：`4.7.2-stable.official.ed1daf0bf`（macOS，Apple M1）
* 二进制：`$REPO/tools/Godot.app/Contents/MacOS/Godot`
* Node 客户端：`v24.21.0`（`ws_client.mjs` 用内建 `WebSocket`，`tcp_client.mjs` 用 `net`）

## 0. 产物

| 文件 | 行数 | 说明 |
|---|---|---|
| `godot/addon/godot_mcp_bridge/plugin.cfg` | 7 | 插件清单 |
| `godot/addon/godot_mcp_bridge/mcp_bridge_plugin.gd` | 40 | `EditorPlugin` 入口，创建/销毁桥节点 |
| `godot/addon/godot_mcp_bridge/mcp_bridge.gd` | 1258 | L2 全部 `editor.*` op、WebSocket 服务端、撤销/重做 |
| `godot/runtime/godot_mcp_runtime.gd` | 1115 | L3 全部 `rt.*` op、TCP 服务端、输入注入、截图、逃生舱 |
| `godot/addon/INSTALL.md` | — | 安装/配置/协议/限制 |

三个 GDScript 文件均通过 Godot 自带解析器检查（无错误）：

```bash
"$GODOT" --headless --path /tmp/gmcp_disc --check-only --script <file.gd>
# → 无输出即通过；mcp_bridge.gd / mcp_bridge_plugin.gd / godot_mcp_runtime.gd 各跑一次，均无 SCRIPT ERROR
```

L2 与 `godot/ops.gd` 无任何符号引用（`grep -n "ops.gd"` 仅命中一条文档注释）。
写范围自检：只写了 `godot/addon/**`、`godot/runtime/**`、`verification/bridge.md`。

## 1. 复现方式

验证夹具放在仓库外的 `/tmp`（不属于任何人的写范围，避免污染交付物）：

```
/tmp/gmcp_verify/run_l2.sh          # 重建 L2 夹具工程 + 启动无头编辑器 + 跑 spec + 收尾
/tmp/gmcp_verify/wait_port.mjs      # 轮询端口（不用 sleep 死等）
/tmp/gmcp_verify/ws_client.mjs      # WebSocket 行分隔 JSON 客户端
/tmp/gmcp_verify/tcp_client.mjs     # TCP 行分隔 JSON 客户端
/tmp/gmcp_verify/l2_verify_spec.json     → l2_verify_out.txt      （38 条响应）
/tmp/gmcp_verify/l3_spec.json            → l3_out2.txt            （29 条）
/tmp/gmcp_verify/l3_quit_spec.json       → l3_quit_out2.txt       （6 条）
/tmp/gmcp_verify/l3_shot2_spec.json      → shot_out3.txt          （5 条，带窗口）
/tmp/gmcp_verify/l3_screenshot_final.png （真机截图，见 §4）
```

L2：

```bash
bash /tmp/gmcp_verify/run_l2.sh /tmp/gmcp_verify/l2_verify_spec.json /tmp/gmcp_verify/l2_verify_out.txt
# 内部等价于：
#   rm -rf /tmp/gmcp_l2proj && 复制 addon 到 addons/ && 写 project.godot([editor_plugins].enabled)
#   "$GODOT" --headless --editor --path /tmp/gmcp_l2proj --log-file /tmp/gmcp_verify/l2_editor.log &
#   node wait_port.mjs 127.0.0.1 9089 60000 && node ws_client.mjs <spec>
# 实测输出：
#   EDITOR_PID=18967  project=/tmp/gmcp_l2proj
#   PORT OPEN 127.0.0.1:9089 after 2756ms (14 attempts)
#   WS OPEN ws://127.0.0.1:9089 (66ms)      ← HTTP 101 握手成功，握手耗时 66ms
#   ... 38 条 RESP ...
#   CLIENT_EXIT=0
```

L3（无头，跑全部 op）：

```bash
cp godot/runtime/godot_mcp_runtime.gd /tmp/gmcp_l3proj/addons/godot_mcp_bridge/runtime/
GODOT_MCP_RUNTIME_DEBUG=1 "$GODOT" --headless --path /tmp/gmcp_l3proj &
node /tmp/gmcp_verify/wait_port.mjs 127.0.0.1 9091 30000
node /tmp/gmcp_verify/tcp_client.mjs /tmp/gmcp_verify/l3_spec.json       # 29 条
node /tmp/gmcp_verify/tcp_client.mjs /tmp/gmcp_verify/l3_quit_spec.json  # 6 条（含 rt.quit）
# 实测：PORT OPEN 127.0.0.1:9091 after 204ms (2 attempts)；MAIN_EXIT=0 QUIT_EXIT=0；GAME_EXIT=0
# 35 条响应：30 条 ok:true，5 条为故意构造的失败（headless 截图 + 4 个错误路径）
```

L3 夹具工程 `/tmp/gmcp_l3proj`：`main.tscn`（Node2D `Main` + `Label` + `Marker`）、
`main.gd`（`counter/speed/last_key/last_mouse/action_frames` 可观测状态，`bump()`/`describe()` 方法，
`_input` 记录事件，`jump` 动作绑定空格），`project.godot` 内含
`[autoload] McpRuntime="*res://addons/godot_mcp_bridge/runtime/godot_mcp_runtime.gd"`。

---

## 2. L2 编辑器层（WebSocket 9089，无头编辑器 `--headless --editor`）

### 2.1 握手与协议

* 客户端 `new WebSocket("ws://127.0.0.1:9089")` → `WS OPEN ... (66ms)`，即
  `WebSocketPeer.accept_stream()` 服务端握手成功。
* 服务端用**文本帧**回包（JSON 是文本，避免浏览器/Node 侧拿到 Blob）；请求侧
  文本帧与二进制帧都能解析，按 `\n` 分帧，并容忍"一条完整 JSON 对象不带换行"。

```json
{"data":{"nonce":"l2","pong":true,"port":9089,"protocol":"godot-mcp-bridge/1"},"id":"01-ping","ok":true,"op":"editor.ping"}
```

### 2.2 必需 op 逐条证据（38 条响应，`CLIENT_EXIT=0`）

`editor.info`（02，节选）：

```json
{"data":{"godot_version":"4.7.2-stable (official)","project_path":"/private/tmp/gmcp_l2proj/",
"project_name":"gmcp_l2proj","edited_scene":"res://main.tscn","open_scenes":["res://main.tscn"],
"unsaved_scenes":[],"playing":false,"bridge_port":9089,"headless":true,"clients":1,
"requests_served":1,"last_error":""},"id":"02-info-clean-start","ok":true,"op":"editor.info"}
```

`editor.open_scene`（04）→ `editor.scene_tree`（06）：

```json
{"data":{"confirmed":true,"edited_scene":"res://main.tscn","open_scenes":["res://main.tscn"],"opened":true,"scene_path":"res://main.tscn"},"id":"04-open","ok":true,"op":"editor.open_scene"}
{"data":{"edited_scene":"res://main.tscn","node_count":2,"tree":{"child_count":1,"children":[{"child_count":0,"name":"Label","path":"Label","type":"Label"}],"name":"Root","path":".","script":"res://main.gd","type":"Node2D"},"with_properties":false},"id":"06-tree","ok":true,"op":"editor.scene_tree"}
```

`editor.add_node`（07 带 properties；08 `parent_path:""` 落根；12 建子节点）：

```json
{"data":{"node_name":"McpSprite","node_path":"McpSprite","parent_path":".","properties":["position","visible"],"type":"Sprite2D","undoable":true},"id":"07-add-sprite","ok":true,"op":"editor.add_node"}
{"data":{"node_name":"McpHolder","node_path":"McpHolder","parent_path":".","properties":[],"type":"Node2D","undoable":true},"id":"08-add-empty-parent","ok":true,"op":"editor.add_node"}
{"data":{"node_name":"Child","node_path":"McpSprite/Child","parent_path":"McpSprite","properties":["text"],"type":"Label","undoable":true},"id":"12-add-child","ok":true,"op":"editor.add_node"}
```

> 09 步 `editor.scene_tree` 之后根节点下为 `Label, McpSprite, McpHolder`（`node_count:4`），
> `McpSprite` 的 `position` 已按 JSON `{"x":12,"y":34}` 写入 → 类型化属性转换生效。

`editor.set_property`（11，Vector2 由 JSON 对象转 Godot 值）：

```json
{"data":{"node_path":"McpSprite","previous":{"x":12,"y":34},"property":"position","undoable":true,"value":{"x":5,"y":6}},"id":"11-set-prop","ok":true,"op":"editor.set_property"}
```

`editor.select`（13）：`{"selected":"McpSprite","selection_count":1}`；
`editor.execute`（22）里再读 `EditorInterface.get_selection()` → `selection:1`，选择状态确实进了编辑器。

`editor.execute`（22，逃生舱直接调 EditorInterface）：

```json
{"data":{"finished":true,"mcp_result":{"children":2,"scene":"Root","selection":1},
"result":{"children":2,"scene":"Root","selection":1},"returned":true,"timed_out":false,"wrapped":true},
"id":"22-exec-api","ok":true,"op":"editor.execute"}
```

`editor.save_scene`（16）：`{"saved":true,"scene_path":"res://main.tscn"}`；
`editor.remove_node`（17）：`{"removed":"Label","node_name":"Label","undoable":true}`，
18 步场景树确认 `Label` 已消失（根下只剩 `McpSprite(Child)`、`McpHolder`）。

`editor.reload_scripts`（19）：

```json
{"data":{"reloaded_scenes":[],"scan_finished":true,"scanned":true,"still_scanning":false},"id":"19-reload-scripts","ok":true,"op":"editor.reload_scripts"}
```

`editor.run`（28）→ `editor.stop`（31）：在无头编辑器里真的把主场景跑起来了：

```json
{"data":{"playing":true,"playing_scene":"res://main.tscn","started":true},"id":"28-run","ok":true,"op":"editor.run"}
{"data":{"playing":false,"stopped":true,"was_playing":true},"id":"31-stop","ok":true,"op":"editor.stop"}
```

`editor.console_log`（30，读到被 play 的游戏真实输出）：

```json
{"data":{"lines":["Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org",
"OpenGL API 4.1 Metal - 90.5 - Compatibility - Using Device: Apple - Apple M1"],
"source":"project_log_file","log_path":"~/Library/Application Support/Godot/app_userdata/gmcp_l2proj/logs/godot.log",
"note":"this is the project's user://logs/godot.log — when a scene has been played from the editor it holds the *game's* output, not the editor console; pass log_file explicitly to read the editor's own --log-file"},"id":"30-console-game-output","ok":true,"op":"editor.console_log"}
```

`editor.console_log`（37，显式 `log_file` 读编辑器自己的 `--log-file`）：

```json
{"data":{"lines":["[GodotMCPBridge] <- editor.execute ok=true","[GodotMCPBridge] <- editor.scene_tree ok=false","[GodotMCPBridge] <- editor.info ok=true","[GodotMCPBridge] <- editor.save_scene ok=false","[GodotMCPBridge] <- editor.add_node ok=false"],
"source":"explicit_file","log_path":"/tmp/gmcp_verify/l2_editor.log","note":""},"id":"37-console-explicit-editor-log","ok":true,"op":"editor.console_log"}
```

另外一轮（3 秒等待）里，游戏日志中还出现了夹具自己的打印，证明这是**运行中游戏的实时输出**：

```json
{"lines":["Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org",
"OpenGL API 4.1 Metal - 90.5 - Compatibility - Using Device: Apple - Apple M1",
"[l2fixture] main scene ready, frame=0"],"source":"project_log_file", ...}
```

### 2.3 撤销/重做是真的（关键差异，硬性要求）

07/08/11/12 之后，用逃生舱调 `EditorInterface.get_editor_undo_redo()` 检查历史并真的执行
undo/redo（14）：

```json
{"data":{"finished":true,"mcp_result":{
  "object_history_id":1,"steps_object_history":4,"steps_after":4,
  "undo_action_name":"MCP: add Child",
  "child_before":true,"child_after_undo":false,"child_after_redo":true},
  ...},"id":"14-undo-proof","ok":true,"op":"editor.execute"}
```

解读：撤销栈里 4 条动作（add McpSprite / add McpHolder / set position / add Child），
栈顶名字是 `MCP: add Child`；`undo()` 之后 `McpSprite/Child` **真的从场景树消失**，
`redo()` 之后**又回来**。即 L2 的增删改都是用户可在编辑器里 Ctrl+Z 撤销的真实动作
（`EditorUndoRedoManager`，不是直接改树）。注意撤销历史是**按场景**分配的
（`get_object_history_id(场景根) == 1`，不是全局历史 0）。

### 2.4 错误路径（全部返回 `ok:false` + 明确原因，不崩、不静默）

```json
{"error":"unknown op: 'editor.nope'","id":"26-bad-op","ok":false}
{"error":"cannot instantiate node type 'NoSuchClassXYZ' (not a ClassDB class, nor a loadable script path)","id":"23-bad-type","ok":false}
{"error":"node 'McpSprite' (Sprite2D) has no property 'not_a_prop'","id":"24-bad-prop","ok":false}
{"error":"node not found: 'Missing/Node'","id":"25-bad-node","ok":false}
{"error":"refusing to remove the edited scene root; use editor.open_scene to switch scenes","id":"27-remove-scene-root","ok":false}
{"error":"no scene is currently open in the editor; use editor.open_scene first","id":"33-tree-after-close","ok":false}
{"error":"no scene is currently open in the editor","id":"35-save-after-close","ok":false}
```

"没有打开场景"的状态是这样构造出来的（32）：`EditorInterface.close_scene()` 关闭唯一场景后
`get_edited_scene_root()` 变 `null`：

```json
{"mcp_result":{"closed":"Root","edited_scene_is_null":true,"open_scenes":[""]}}
```

复入 3 条请求后（33/34/35/36）`editor.scene_tree` / `editor.save_scene` / `editor.add_node`
都稳定回"没有场景"错误，`editor.info` 的 `edited_scene` 为空串。

### 2.5 关于"启动即有一个场景打开"

即使在**全新创建的工程目录**（无 `.godot` 缓存、且已删除
`.../app_userdata/gmcp_l2proj/.recovery_mode_lock`）上启动 `--headless --editor`，
第一个请求（02）看到的 `edited_scene` 就已经是 `res://main.tscn`（工程主场景）。
没有找到由本项目代码造成的来源，属于本环境下 Godot 编辑器的启动行为，如实记录；
因此"无场景"分支改用 §2.4 的关闭场景方式验证，而不是假设启动时干净。

---

## 3. L3 运行中游戏层（TCP 9091）

### 3.1 全部必需 op（无头运行，35 条响应：30 ok + 5 条故意失败）

| op | 请求要点 | 实测响应（节选） |
|---|---|---|
| `rt.ping` | `{nonce:"abc"}` | `{"nonce":"abc","pong":true,"port":9091,"protocol":"godot-mcp-runtime/1"}` |
| `rt.info` | `{}` | `{"scene":"/root/Main","scene_file":"res://main.tscn","node_count":5,"paused":false,"headless":true,"runtime_port":9091,...}` |
| `rt.scene_tree` | `{max_depth:3}` | `{"node_count":5,"tree":{"name":"root","type":"Window","children":[McpRuntime, Main(Label,Marker)]}}` |
| `rt.get_node` | `/root/Main` | name/type/path/script/children/groups/signals/properties 全量 |
| `rt.get_property` | `counter` | `{"type":"int","value":0}` |
| `rt.set_property` | `speed=42.5` | `{"previous":10.0,"value":42.5,"changed":true}` → 07 复核 `{"value":42.5,"type":"float"}` |
| `rt.call_method` | `bump([5])` | `{"method":"bump","result":5,"arg_count":1}`；`describe(["after"])` → `"after:5"` |
| `rt.screenshot` | 无头 | **失败**：`rt.screenshot needs a real display driver; the headless dummy renderer has no framebuffer (run the game without --headless)`（见 §4 带窗口成功） |
| `rt.input` | key/action/mouse | 见 §3.2 |
| `rt.eval` | 三种回传写法 | `mcp_result={"scene":"Main","sum":3}`；`return 7*6` → `42`；`MCP_RESULT(Vector2(3,4).length())` → `5.0` |
| `rt.quit` | `{exit_code:0}` | `{"quitting":true,"exit_code":0}` → 游戏进程退出码 0（`GAME_EXIT=0`） |

### 3.2 输入注入确实进了游戏逻辑（不是"发了个事件"）

夹具在 `_input()` 里记录事件、在 `_process()` 里统计 `jump` 动作按住帧数：

```json
{"data":{"injected":"key_tap","key":"SPACE","keycode":32},"id":"13-key","ok":true}
{"data":{"node_path":"/root/Main","property":"last_key","type":"String","value":"Space"},"id":"15-lastkey","ok":true}

{"data":{"action":"jump","injected":"action_press","strength":1.0},"id":"16-action-on","ok":true}
{"data":{"node_path":"/root/Main","property":"action_frames","type":"int","value":5},"id":"18-action-frames","ok":true}

{"data":{"button":1,"injected":"mouse_click","position":{"x":100.0,"y":50.0}},"id":"20-click","ok":true}
{"data":{"node_path":"/root/Main","property":"last_mouse","type":"String","value":"button1@100,50"},"id":"22-lastmouse","ok":true}

{"data":{"injected":"mouse_motion","position":{"x":10.0,"y":20.0},"relative":{"x":3.0,"y":4.0}},"id":"23-motion","ok":true}
```

空格键 → `last_key="Space"`；`action_press("jump")` → 3 帧后 `action_frames=5`（动作状态真的更新了）；
鼠标点击 → `last_mouse="button1@100,50"`。

### 3.3 暂停时仍然响应（`process_mode = PROCESS_MODE_ALWAYS`）

```json
{"id":"90-pause","op":"rt.eval"} → {"mcp_result":{"paused":true}}
{"id":"92-info-while-paused","op":"rt.info"} → {"paused":true, ...}   ← 暂停中照常回包
{"id":"93-prop-while-paused","op":"rt.get_property"} → {"property":"counter","value":5}
{"id":"94-unpause","op":"rt.eval"} → {"mcp_result":false}
```

### 3.4 错误路径

```json
{"error":"node 'Main' (Node2D) has no property 'nope_not_a_property'","id":"26-badprop","ok":false}
{"error":"node 'Main' (Node2D) has no method 'nope_not_a_method'","id":"27-badmethod","ok":false}
{"error":"node not found: '/root/Nope'","id":"28-badnode","ok":false}
{"error":"unknown op: 'rt.not_an_op'","id":"29-badop","ok":false}
```

无头整轮运行日志里引擎级 `ERROR` 计数为 0（`grep -c ERROR l3_headless.log` → `0`），
即 headless 截图是在触碰纹理**之前**就返回明确错误，不会引发渲染服务器报错。

---

## 4. `rt.screenshot` 真机证据（带窗口运行）

```bash
"$GODOT" --path /tmp/gmcp_l3proj --resolution 640x360 --position 40,40 &
node wait_port.mjs 127.0.0.1 9091 30000
node tcp_client.mjs /tmp/gmcp_verify/l3_shot2_spec.json
#  50-settle   rt.wait {frames:90}
#  51-setprop  rt.set_property Label.text = "L3 SCREENSHOT PROOF (post-edit)"  → previous "READY"
#  52-call     rt.call_method Main.bump([7])                                   → result 7
#  53-wait     rt.wait {frames:20}
#  54-screenshot
```

```json
{"data":{"format":"png","width":640,"height":360,"bytes":3377,"headless":false,"captured_frame":114,
"data_uri":"data:image/png;base64,iVBORw0KGgo..."},"id":"54-screenshot","ok":true,"op":"rt.screenshot"}
```

* base64 解码 = 640×360、3377 字节，PNG 签名 `89504e470d0a1a0a`。
* PNG SHA-256：`e03c32297f71169dcafb38f24f6e241d60acf8984de5eaa832c702c70c7e35df`
* 落盘路径：`/tmp/gmcp_verify/l3_screenshot_final.png`。（同目录 `l3_screenshot.png` 是窗口刚起来
  1.6s 时抓的 986 字节空白帧，正好作为 §5.2 的对照证据。）
* 画面内容为屏幕上真实的 `Label` 文本 **`counter=7`** —— 正是上一步 `rt.call_method bump(7)`
  的副作用，说明"属性/方法写入 → 游戏状态 → 渲染 → 帧缓冲 → base64 PNG"整条链路真实贯通
  （见回复中附带的图片）。

## 5. 限制与如实说明

1. **L2 只在 `--headless --editor` 下验证**。带界面编辑器未跑（同一份代码，`EditorInterface`
   调用一致；唯一的分支是 `editor.select` 在非 headless 时会额外调 `EditorInterface.edit_node()`
   聚焦 Inspector —— 该分支**未验证**）。"用户手按 Ctrl+Z"也未验证，验证的是**同一个
   `EditorUndoRedoManager` 历史**上的 undo/redo（§2.3）。
2. **`rt.screenshot` 在 headless 下不可用**（无帧缓冲），如实返回错误；带窗口运行已验证可用。
   另外截图是"当前帧缓冲"，游戏刚启动时可能抓到尚未绘制的空白帧：先 `rt.wait {frames:N}`
   再截图（本次 90 帧后才得到有内容的画面；1.6s 那次只有 986 字节的空白帧）。
3. **`editor.console_log` 读日志文件而非编辑器 Output 面板内存**：Godot 4.7 未向脚本暴露
   `EditorLog`，GDScript 无法直接读编辑器控制台。已实现的取值顺序为
   `log_file` 形参 → `user://logs/godot.log` → 编辑器数据目录；都拿不到时回退到桥自身环形缓冲
   并在 `note` 里说明。注意 Godot 编辑器会吞掉自己的命令行参数——
   `OS.get_cmdline_args()` 在编辑器里只有 `["--editor"]`，所以桥无法自动发现 `--log-file`，
   需要调用方把路径作为 `log_file` 显式传入。
4. **游戏 stdout 的写入时机**：`user://logs/godot.log` 里夹具的 `print` 有时要等 3 秒左右才出现
   （Godot 的 stdout 缓冲/刷新时机），短等待下可能只看到启动横幅。这是 Godot 行为，不是桥的问题。
5. **并发模型**：同一连接多条请求按 FIFO 排队逐条执行（不是"忙就拒绝"），队列上限 64；
   30 秒看门狗会解除卡住的占用并回一条明确错误。此设计在验证中未触发看门狗。
6. 未验证项：多客户端同时连接（代码支持，本轮只用单客户端）、Windows/Linux 平台。
   （`GODOT_MCP_RUNTIME_PORT` 端口覆盖已在 §6.4 补测通过。）
7. 曾经的 `mcp_debugger_capture.gd`（用 `EditorDebuggerPlugin._capture` 抓游戏输出）在无头环境下
   **完全没有捕获到任何消息**，因此该文件与相关管线已删除，避免交付无法验证的死代码；
   游戏输出改由 §2.2 的日志文件路径提供（已验证）。

---

# 6. release 导出门控（task-3 安全修复）

## 6.1 缺陷（修复前，本人独立复现）

`godot_mcp_runtime.gd` 的 `_ready()` 原先**无条件**监听 127.0.0.1:9091，没有任何
`OS.is_debug_build()` / `OS.has_feature("editor")` 判定。后果：**发布导出的成品自带一个
无鉴权控制端口**，而 `rt.eval` 就是任意代码执行 —— 等于后门。

用**修复前**的 runtime（`demo-game/addons/godot_mcp_bridge/runtime/` 里那份，
`grep is_debug_build` 命中 0）真实导出并运行，独立复现：

```bash
cp -R demo-game/. /tmp/gmcp_prefix_proj/            # 含未修复的 runtime
"$GODOT" --headless --path /tmp/gmcp_prefix_proj --export-release "macOS" /tmp/gmcp_export_out/PreFix.app
"/tmp/gmcp_export_out/PreFix.app/Contents/MacOS/DSH Demo Game" --headless &   # 长驻，不传 --quit-after
node probe_port.mjs 127.0.0.1 9091 6000 500
```

```
  ok: no listener on 9091 before the test
  app pid=26003 (no --quit-after)
PROBE_START 127.0.0.1:9091 for 6000ms (real TCP connect every 500ms)
  [    3ms] CLOSED (connect refused/timeout)
  [  508ms] OPEN  (TCP connect accepted)
PROBE_SUMMARY ... attempts=12 state_changes=2 opened=true first_open_ms=508
  lsof: DSH\x20De 26003 user 4u IPv4 ... TCP 127.0.0.1:9091 (LISTEN)   ← 端口所有者就是成品进程
RESP {"data":{"mcp_result":42,...,"finished":true},"id":"x1-ace","ok":true,"op":"rt.eval"}   ← 外部进程让它执行了 6*7
RESP {"data":{"mcp_result":{"has_editor_feature":false,"is_debug_build":false},...},"id":"x2-build-kind","ok":true,"op":"rt.eval"}
```

`is_debug_build:false` 证明这**确实是 release 成品**，而它开了端口并接受了任意代码执行。
（Lead 侧在修复前也独立复现过同一现象，两边结论一致；本节数据全部由本人独立产出。）

## 6.2 修复

`godot_mcp_runtime.gd` 在 `_ready()` 里、**起监听之前**做门控判断：

| 运行形态 | 是否监听 | 依据 |
|---|---|---|
| 编辑器内 / 编辑器二进制跑游戏 | ✅ | `OS.has_feature("editor")` |
| debug 构建（含 `--export-debug`） | ✅ | `OS.is_debug_build()` |
| 任意构建 + `GODOT_MCP_RUNTIME_FORCE=1` | ✅ | 显式 opt-in |
| **release 导出成品** | ❌ | 以上皆不成立 |
| 任意构建 + `GODOT_MCP_RUNTIME_DISABLE=1` | ❌ | 最高优先级 |

关闭时：不绑定端口、`set_process(false)`、**不 push_error / 不 push_warning**
（仅 `--verbose` 打一行 `bridge disabled (...)`）。`rt.info` 新增 `gate` / `listening` 字段
（如 `"open: editor"`、`"open: forced by GODOT_MCP_RUNTIME_FORCE"`）便于自查。

判定逻辑抽成纯函数 `bridge_gate_reason(is_debug_build, in_editor, forced, disabled)`，
用 `--script` 跑了全部 **16 种组合**，与预期真值表 **0 处不符**（`cases=16 open=7 closed=9 mismatches=[]`）。

## 6.3 验收：同一成品，有/无 opt-in（核心验收点）

方法学护栏（三条都是踩过坑后加的）：
1. 成品**长驻运行、不传 `--quit-after`**：无头模式帧率不受限，`--quit-after 600` 不到 1 秒就跑完，
   之后再探测只能得到假阴性。
2. 探测用**真实 TCP connect**，且**记录整段窗口的状态变化**而不是"一连上就提前退出"，
   否则无法区分"我们的进程在监听"和"别人的进程在监听"。
3. 每个用例前后都用 `lsof -n -P -iTCP:9091 -sTCP:LISTEN` 确认**端口所有者 PID**；
   用例开始前先断言端口空闲。

```bash
bash /tmp/gmcp_verify/verify_release_gate.sh        # 完整脚本，含探针自检
```

```
################ 0. 探针自检（负向对照）：9099 无人监听
PROBE_SUMMARY ... port=9099 attempts=6 opened=false first_open_ms=never
  -> exit=1 (探针确实能报 CLOSED，否则"未监听"永远是 true)
################ 1. 前置断言：9091 当前无人监听
  ok: no listener on 9091 before the test

################ CASE A — 修复版 release 成品，无 opt-in，长驻 22s
  app pid=25848 (no --quit-after)
PROBE_START 127.0.0.1:9091 for 22000ms (real TCP connect every 500ms)
  [    2ms] CLOSED (connect refused/timeout)
PROBE_SUMMARY ... window=22000ms attempts=44 state_changes=1 opened=false first_open_ms=never
  app state: 25848   00:22 S      0:00.38        ← 全程存活 22s
  lsof after probe:                              ← 无任何进程监听
  app stdout: []                                 ← 静默：没有 push_error / warning
  CASE_A_PROBE_EXIT=1  (PASS)

################ CASE B — 同一二进制 + GODOT_MCP_RUNTIME_FORCE=1（正向对照）
PROBE_START 127.0.0.1:9091 for 6000ms (real TCP connect every 500ms)
  [    6ms] CLOSED (connect refused/timeout)
  [  509ms] OPEN  (TCP connect accepted)
PROBE_SUMMARY ... attempts=12 state_changes=2 opened=true first_open_ms=509
  lsof: DSH\x20De 25952 user 4u IPv4 ... TCP 127.0.0.1:9091 (LISTEN)   ← 所有者 = 同一个成品 PID
RESP {"mcp_result":42,...}                                      id=b1-ace       rt.eval  return 6*7
RESP {"forced":"1","has_editor_feature":false,"is_debug_build":false}            id=b2-build-kind
RESP {"gate":"open: forced by GODOT_MCP_RUNTIME_FORCE","listening":true,
      "project_name":"DSH Demo Game","scene":"/root/Main",...}   id=b3-info
RESP {"property":"score","value":0,"type":"int"}                 id=b4-getprop
RESP {"method":"add_score","result":5,"arg_count":1}             id=b5-call
RESP {"exit_code":0,"quitting":true}                             id=b6-quit
################ 3. 收尾
  ok: port 9091 released, no residual listener
```

结论：**同一个 release 二进制**，不加开关时 22 秒内 44 次真实 TCP 连接全部被拒绝、进程全程存活
且无任何报错输出；加 `GODOT_MCP_RUNTIME_FORCE=1` 后同一探针 509ms 就看到端口打开、`lsof`
确认端口属于该成品进程、`rt.eval` / `rt.call_method` 等功能完好。即门控生效，没有把功能砍坏。

## 6.4 其它分支与不回归

| 用例 | 命令/条件 | 结果 |
|---|---|---|
| debug 导出默认监听 | `--export-debug` 成品，无 env | `PORT OPEN ... after 3434ms`；`rt.info.gate="open: debug build"`；`is_debug_build:true`；rt.quit → exit 0 |
| 强制关闭开关 | debug 成品 + `GODOT_MCP_RUNTIME_DISABLE=1` | 31 次探测全拒绝（exit 1）；进程存活；stdout 仅引擎横幅（**无 push_error**） |
| 编辑器/`--headless` 不回归 | 原 L3 套件（`l3_spec.json` + `l3_quit_spec.json`） | 35 条响应，30 ok；5 条为既定失败（headless 截图 + 4 条故意错误路径）；10 个 rt.* op 全在；`gate="open: editor"`；引擎 ERROR 计数 0 |
| 端口覆盖 | `GODOT_MCP_RUNTIME_PORT=9191` | 9191 打开，`rt.info` / `rt.quit` 正常，退出码 0 |

## 6.5 方法学事故（如实记录，供团队避坑）

本轮中途我曾得到一次**被污染的**"CASE A 端口开着"结果：当时的探测用了"连上就提前退出"的
写法，而 9091 上恰好有另一个残留进程（opt-in 用例遗留的成品进程）在监听，于是得出
"我们的成品在监听"的**假结论**。修正做法即 §6.3 的三条护栏（长驻 + 整窗状态变化探测 +
`lsof` 认领端口所有者 + 用例前断言端口空闲），此后数据可复现且无歧义。
收尾时已确认 9091 无残留监听进程。

## 6.6 本次改动

* `godot/runtime/godot_mcp_runtime.gd`：新增 `ENV_FORCE` / `ENV_DISABLE` 常量、
  `bridge_gate_reason()`（纯函数）、`_describe_gate()`、`listening` 状态；
  `_ready()` 加门控；`rt.info` 增加 `gate` / `listening`；文件头写明"何时监听/何时不监听"。
* `godot/addon/INSTALL.md`：新增 §3.1 安全门控章节 + 限制第 6 条（release 默认不监听）。
* 复现脚本（仓库外 `/tmp/gmcp_verify/`）：`probe_port.mjs`、`verify_release_gate.sh`、
  `gate_test.gd`（16 组真值表）、`prefix_defect_spec.json` / `release_force_final_spec.json`。

## 6.7 遗留与说明

* 门控只保护 **L3 运行时端口**；L2（编辑器插件）天然只存在于编辑器进程内，导出的游戏不含它。
* 端口仍**无鉴权**（设计如此，与 DESIGN.md §2.3 一致）：能访问本机 127.0.0.1 的进程在
  opt-in/debug 场景下依然可以执行代码。若要更进一步，需要 token 鉴权，属于契约变更，
  需先与 Node 侧约定（本轮未做）。
* `rt.info.project_path` 在导出成品里为空字符串（导出包中 `globalize_path("res://")` 无意义），
  其余字段正常；已记入 `INSTALL.md` §5。
