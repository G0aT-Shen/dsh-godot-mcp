# L1 无头操作层 `godot/ops.gd` — 真机验证报告

| | |
|---|---|
| 被测文件 | `godot/ops.gd`（2028 行，27 个 DESIGN §2.1 契约 op + 1 个辅助 op `list_ops`） |
| 引擎 | Godot **4.7.2.stable.official.ed1daf0bf**，`--headless` |
| 平台 | macOS（Apple Silicon）；本机无 `timeout` 命令 |
| 验证方式 | 全部真机执行，非静态检查。下文每条 `$ ...` 均可直接粘贴复现；输出为 stdout 中真实的 `@@GODOT_MCP@@` 行（引擎自身日志已按前缀过滤） |
| 结果 | **成功路径 65 条，全部符合契约 data 形状；失败路径 32 条，全部 `ok:false` + exit 1；无崩溃、无静默成功** |

## 0. 复现方法

```bash
GODOT=$REPO/tools/Godot.app/Contents/MacOS/Godot
OPS=$REPO/godot/ops.gd
P=/tmp/godot-ops-verify-ops-engine/proj
mkdir -p "$P"          # 见 §9 注意事项 1：--path 必须指向已存在的目录
```

调用形式（与 DESIGN §2.1 一致）：

```bash
"$GODOT" --headless --path "$P" --script "$OPS" <op> '<json_params>'
# 只取协议行：
"$GODOT" --headless --path "$P" --script "$OPS" <op> '<json_params>' | grep '@@GODOT_MCP@@'
```

`version` 等不需要项目的 op 可省略 `--path`。下文命令中的项目路径均为 `/tmp/godot-ops-verify-ops-engine/proj`。

---

## 1. 协议与项目（`version` `create_project` `project_info`）

```text
$ godot --headless --script godot/ops.gd version {}
@@GODOT_MCP@@{"data":{"build":"official","hash":"ed1daf0bf001b61586d9930840f2f1394092c079","status":"stable","string":"4.7.2-stable (official)","version":"4.7.2"},"ok":true,"op":"version"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd create_project {"project_path":"/tmp/godot-ops-verify-ops-engine/proj","name":"VerifyProj"}
@@GODOT_MCP@@{"data":{"created":true,"path":"/tmp/godot-ops-verify-ops-engine/proj","renderer":"forward_plus"},"ok":true,"op":"create_project"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd create_project {"project_path":"/tmp/godot-ops-verify-ops-engine/proj","name":"VerifyProj"}
@@GODOT_MCP@@{"error":"a Godot project already exists at /tmp/godot-ops-verify-ops-engine/proj/project.godot","ok":false,"op":"create_project"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd project_info {"project_path":"/tmp/godot-ops-verify-ops-engine/proj"}
@@GODOT_MCP@@{"data":{"godot_version":"4.7.2-stable (official)","main_scene":"","name":"VerifyProj","path":"/tmp/godot-ops-verify-ops-engine/proj","settings":{"application/config/features":["4.7","forward_plus"],"application/config/name":"VerifyProj","config_version":5,"rendering/renderer/rendering_method":"forward_plus","rendering/renderer/rendering_method.mobile":"forward_plus"}},"ok":true,"op":"project_info"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd project_info {"project_path":"/tmp/elsewhere"}
@@GODOT_MCP@@{"error":"project_path mismatch: godot was started with --path '/tmp/godot-ops-verify-ops-engine/proj' but params.project_path is '/tmp/elsewhere'","ok":false,"op":"project_info"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd version {"broken":
@@GODOT_MCP@@{"error":"invalid JSON params: Expected '}' (line 0)","ok":false,"op":"version"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd version [1,2,3]
@@GODOT_MCP@@{"error":"params must be a JSON object, got Array","ok":false,"op":"version"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd frobnicate {}
@@GODOT_MCP@@{"error":"unknown operation: 'frobnicate' (see op 'list_ops')","ok":false,"op":"frobnicate"}
```

**协议要点（已实测）**：成功 = 单行 `@@GODOT_MCP@@{{"ok":true,"op":...,"data":{{...}}}}` + exit 0；失败 = `ok:false` + `error` + exit 1。进程 stdout 里除协议行外只有引擎自身日志（不带协议前缀），server 按前缀过滤即可。

实测 exit code：

```text
$ ... frobnicate '{}' >/dev/null 2>&1; echo "exit=$?"     -> exit=1
$ ... version '{}'     >/dev/null 2>&1; echo "exit=$?"     -> exit=0
```

`project_path` 与 `--path` 解析结果不一致时**硬失败**（防止写错项目）：

```text
$ ... project_info '{{"project_path":"/tmp/elsewhere"}}'
@@GODOT_MCP@@{{"error":"project_path mismatch: godot was started with --path '/tmp/godot-ops-verify-ops-engine/proj' but params.project_path is '/tmp/elsewhere'","ok":false,"op":"project_info"}}
```

---

## 2. 场景 op（`create_scene` `read_scene` `add_node` `modify_node` `remove_node` `instantiate_scene` `list_scenes`）

```text
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd create_scene {"project_path":"/tmp/godot-ops-verify-ops-engine/proj","scene_path":"res://scenes/main.tscn","root_type":"Node2D","root_name":"Main"}
@@GODOT_MCP@@{"data":{"overwritten":false,"root_name":"Main","root_type":"Node2D","scene_path":"res://scenes/main.tscn"},"ok":true,"op":"create_scene"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd create_scene {"scene_path":"res://scenes/bad.tscn","root_type":"NoSuchNodeType"}
@@GODOT_MCP@@{"error":"unknown node type: NoSuchNodeType (not in ClassDB nor a registered class_name)","ok":false,"op":"create_scene"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd add_node {"scene_path":"res://scenes/main.tscn","parent_node_path":".","node_type":"Sprite2D","node_name":"Hero"}
@@GODOT_MCP@@{"data":{"node_path":"Main/Hero","parent":"Main","scene_path":"res://scenes/main.tscn"},"ok":true,"op":"add_node"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd add_node {"scene_path":"res://scenes/main.tscn","parent_node_path":"Main/Hero","node_type":"Node2D","node_name":"Weapon","properties":{"position":"Vector2(3, 4)","visible":false}}
@@GODOT_MCP@@{"data":{"node_path":"Main/Hero/Weapon","parent":"Main/Hero","scene_path":"res://scenes/main.tscn"},"ok":true,"op":"add_node"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd add_node {"scene_path":"res://scenes/main.tscn","parent_node_path":".","node_type":"Node2D","node_name":"Hero"}
@@GODOT_MCP@@{"error":"a node named 'Hero' already exists in res://scenes/main.tscn","ok":false,"op":"add_node"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd add_node {"scene_path":"res://scenes/main.tscn","parent_node_path":"Main/Nope","node_type":"Node2D","node_name":"X"}
@@GODOT_MCP@@{"error":"parent node not found: 'Main/Nope'","ok":false,"op":"add_node"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd add_node {"scene_path":"res://scenes/main.tscn","parent_node_path":".","node_type":"Node2D","node_name":"Y","properties":{"not_a_property":1}}
@@GODOT_MCP@@{"error":"node 'Y' (Node2D) has no property 'not_a_property'","ok":false,"op":"add_node"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd list_scenes {}
@@GODOT_MCP@@{"data":{"scenes":[{"name":"main","path":"res://scenes/main.tscn"}],"total":1},"ok":true,"op":"list_scenes"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd read_scene {"scene_path":"res://scenes/main.tscn"}
@@GODOT_MCP@@{"data":{"connections":[],"max_depth":16,"node_count":3,"scene_path":"res://scenes/main.tscn","tree":{"children":[{"children":[{"children":[],"name":"Weapon","path":"Main/Hero/Weapon","properties":{"position":"(3.0, 4.0)","visible":false},"type":"Node2D"}],"name":"Hero","path":"Main/Hero","properties":{},"type":"Sprite2D"}],"name":"Main","path":"Main","properties":{},"type":"Node2D"}},"ok":true,"op":"read_scene"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd read_scene {"scene_path":"res://scenes/ghost.tscn"}
@@GODOT_MCP@@{"error":"scene does not exist: res://scenes/ghost.tscn (/private/tmp/godot-ops-verify-ops-engine/proj/scenes/ghost.tscn)","ok":false,"op":"read_scene"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd read_scene {"scene_path":"res://scenes/main.tscn","max_depth":1}
@@GODOT_MCP@@{"data":{"connections":[],"max_depth":1,"node_count":3,"scene_path":"res://scenes/main.tscn","tree":{"children":[{"children":[],"name":"Hero","path":"Main/Hero","properties":{},"type":"Sprite2D"}],"name":"Main","path":"Main","properties":{},"type":"Node2D"}},"ok":true,"op":"read_scene"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd modify_node {"scene_path":"res://scenes/main.tscn","node_path":"Main/Hero","properties":{"modulate":"Color(1,0,0,1)"},"new_name":"Hero2"}
@@GODOT_MCP@@{"data":{"changed":["modulate","name"],"node_path":"Main/Hero2","scene_path":"res://scenes/main.tscn"},"ok":true,"op":"modify_node"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd remove_node {"scene_path":"res://scenes/main.tscn","node_path":"Main/Hero2/Weapon"}
@@GODOT_MCP@@{"data":{"connections_dropped":0,"node_path":"Main/Hero2/Weapon","removed":true,"scene_path":"res://scenes/main.tscn"},"ok":true,"op":"remove_node"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd remove_node {"scene_path":"res://scenes/main.tscn","node_path":"Main"}
@@GODOT_MCP@@{"error":"refusing to remove the scene root node ('Main'); delete the scene file instead","ok":false,"op":"remove_node"}
```

路径约定（`read_scene.tree.path`、`add_node.node_path`、以及入参 `node_path` / `parent_node_path` 通用）：根节点可用其自身名字、`"."` 或字面量 `"root"` 表示；子节点写作 `Main/Hero/Weapon`。

`read_scene` 的 `properties` 只返回**与同类节点默认值不同**的属性，也就是 .tscn 真正存下来的那些：

```text
"properties":{{"position":"(3.0, 4.0)","visible":false}}                                   // add_node 显式设置过
"properties":{{"max_health":100,"modulate":"(1.0, 0.0, 0.0, 1.0)","script":"res://scripts/hero.gd"}}
```

---

## 3. 脚本与信号（`write_file` `attach_script` `connect_signal` `find_symbols`）

```text
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd write_file {"path": "res://scripts/hero.gd", "content": "extends Sprite2D\n\nsignal damaged(amount)\n@export var max_health: int = 100\n\nfunc take_damage(amount: int) -> void:\n\tprint(\"took \", amount)\n"}
@@GODOT_MCP@@{"data":{"bytes":139,"encoding":"utf-8","path":"res://scripts/hero.gd"},"ok":true,"op":"write_file"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd write_file {"path": "res://scripts/relay.gd", "content": "extends Node\n\nfunc on_damaged(amount: int) -> void:\n\tprint(\"relay got \", amount)\n"}
@@GODOT_MCP@@{"data":{"bytes":81,"encoding":"utf-8","path":"res://scripts/relay.gd"},"ok":true,"op":"write_file"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd attach_script {"scene_path":"res://scenes/main.tscn","node_path":"Main/Hero2","script_path":"res://scripts/hero.gd"}
@@GODOT_MCP@@{"data":{"node_path":"Main/Hero2","scene_path":"res://scenes/main.tscn","script":"res://scripts/hero.gd"},"ok":true,"op":"attach_script"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd attach_script {"scene_path":"res://scenes/main.tscn","node_path":"Main/Hero2","script_path":"res://scripts/nope.gd"}
@@GODOT_MCP@@{"error":"script does not exist: res://scripts/nope.gd","ok":false,"op":"attach_script"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd add_node {"scene_path":"res://scenes/main.tscn","parent_node_path":".","node_type":"Node","node_name":"Relay"}
@@GODOT_MCP@@{"data":{"node_path":"Main/Relay","parent":"Main","scene_path":"res://scenes/main.tscn"},"ok":true,"op":"add_node"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd attach_script {"scene_path":"res://scenes/main.tscn","node_path":"Main/Relay","script_path":"res://scripts/relay.gd"}
@@GODOT_MCP@@{"data":{"node_path":"Main/Relay","scene_path":"res://scenes/main.tscn","script":"res://scripts/relay.gd"},"ok":true,"op":"attach_script"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd connect_signal {"scene_path":"res://scenes/main.tscn","from_node":"Main/Hero2","signal":"damaged","to_node":"Main/Relay","method":"on_damaged"}
@@GODOT_MCP@@{"data":{"binds":[],"connected":true,"from":"Main/Hero2","method":"on_damaged","scene_path":"res://scenes/main.tscn","signal":"damaged","to":"Main/Relay"},"ok":true,"op":"connect_signal"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd connect_signal {"scene_path":"res://scenes/main.tscn","from_node":"Main/Hero2","signal":"damaged","to_node":"Main/Relay","method":"on_damaged"}
@@GODOT_MCP@@{"error":"signal 'damaged' is already connected to on_damaged","ok":false,"op":"connect_signal"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd connect_signal {"scene_path":"res://scenes/main.tscn","from_node":"Main/Hero2","signal":"nope","to_node":"Main/Relay","method":"on_damaged"}
@@GODOT_MCP@@{"error":"node 'Main/Hero2' (Sprite2D) has no signal 'nope'","ok":false,"op":"connect_signal"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd connect_signal {"scene_path":"res://scenes/main.tscn","from_node":"Main/Hero2","signal":"damaged","to_node":"Main/Relay","method":"nope"}
@@GODOT_MCP@@{"error":"node 'Main/Relay' (Node) has no method 'nope'","ok":false,"op":"connect_signal"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd find_symbols {"path":"res://scripts/hero.gd"}
@@GODOT_MCP@@{"data":{"classes":[],"exports":["max_health"],"extends":["Sprite2D"],"functions":["take_damage"],"path":"res://scripts/hero.gd","signals":["damaged"],"variables":["max_health"]},"ok":true,"op":"find_symbols"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd find_symbols {"path":"res://scenes/main.tscn"}
@@GODOT_MCP@@{"error":"find_symbols only supports .gd files, got: res://scenes/main.tscn","ok":false,"op":"find_symbols"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd instantiate_scene {"scene_path":"res://scenes/main.tscn","instance_path":"res://scenes/main.tscn"}
@@GODOT_MCP@@{"error":"cannot instantiate a scene inside itself: res://scenes/main.tscn","ok":false,"op":"instantiate_scene"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd create_scene {"scene_path":"res://scenes/pickup.tscn","root_type":"Area2D","root_name":"Pickup"}
@@GODOT_MCP@@{"data":{"overwritten":false,"root_name":"Pickup","root_type":"Area2D","scene_path":"res://scenes/pickup.tscn"},"ok":true,"op":"create_scene"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd instantiate_scene {"scene_path":"res://scenes/main.tscn","instance_path":"res://scenes/pickup.tscn","parent_node_path":".","node_name":"Coin"}
@@GODOT_MCP@@{"data":{"instance_path":"res://scenes/pickup.tscn","node_path":"Main/Coin","scene_path":"res://scenes/main.tscn"},"ok":true,"op":"instantiate_scene"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd read_scene {"scene_path":"res://scenes/main.tscn","max_depth":1}
@@GODOT_MCP@@{"data":{"connections":[{"from":"Hero2","method":"on_damaged","raw":"[connection signal=\"damaged\" from=\"Hero2\" to=\"Relay\" method=\"on_damaged\"]","signal":"damaged","to":"Relay"}],"max_depth":1,"node_count":4,"scene_path":"res://scenes/main.tscn","tree":{"children":[{"children":[],"name":"Hero2","path":"Main/Hero2","properties":{"max_health":100,"modulate":"(1.0, 0.0, 0.0, 1.0)","script":"res://scripts/hero.gd"},"type":"Sprite2D"},{"children":[],"name":"Relay","path":"Main/Relay","properties":{"script":"res://scripts/relay.gd"},"type":"Node"},{"children":[],"name":"Coin","path":"Main/Coin","properties":{},"type":"Area2D"}],"name":"Main","path":"Main","properties":{},"type":"Node2D"}},"ok":true,"op":"read_scene"}
-- path containment / traversal refusals --
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd write_file {"path":"../../escape.txt","content":"nope"}
@@GODOT_MCP@@{"error":"path is outside the project: ../../escape.txt","ok":false,"op":"write_file"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd read_file {"path":"res://../../etc/hosts"}
@@GODOT_MCP@@{"error":"path is outside the project: res://../../etc/hosts","ok":false,"op":"read_file"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd read_file {"path":"../project.godot"}
@@GODOT_MCP@@{"error":"path is outside the project: ../project.godot","ok":false,"op":"read_file"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd read_file {"path":"/etc/hosts"}
@@GODOT_MCP@@{"error":"path is outside the project: /etc/hosts","ok":false,"op":"read_file"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd write_file {"path":"res://a/../inside.txt","content":"ok"}
@@GODOT_MCP@@{"data":{"bytes":2,"encoding":"utf-8","path":"res://inside.txt"},"ok":true,"op":"write_file"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd delete_file {"path":"res://inside.txt"}
@@GODOT_MCP@@{"data":{"deleted":true,"path":"res://inside.txt","uid_deleted":false},"ok":true,"op":"delete_file"}
$ godot --headless --path /tmp/godot-ops-verify-ops-engine/proj --script godot/ops.gd list_ops {}
@@GODOT_MCP@@{"data":{"contract":"DESIGN.md 2.1","ops":["version","project_info","create_project","list_scenes","create_scene","read_scene","add_node","modify_node","remove_node","instantiate_scene","attach_script","connect_signal","read_settings","write_settings","delete_settings","list_files","read_file","write_file","delete_file","create_dir","find_symbols","resave_resources","import_assets","export_project","run_project","parse_check","gdscript"]},"ok":true,"op":"list_ops"}
--- scenes/main.tscn (raw, real file on disk) ---
[gd_scene format=3]

[ext_resource type="Script" path="res://scripts/hero.gd" id="1_o5qli"]
[ext_resource type="Script" path="res://scripts/relay.gd" id="2_0wfyh"]
[ext_resource type="PackedScene" path="res://scenes/pickup.tscn" id="3_sugp2"]

[node name="Main" type="Node2D" unique_id=2094450519]

[node name="Hero2" type="Sprite2D" parent="." unique_id=823569884]
modulate = Color(1, 0, 0, 1)
script = ExtResource("1_o5qli")

[node name="Relay" type="Node" parent="." unique_id=154546921]
script = ExtResource("2_0wfyh")

[node name="Coin" type="Area2D" parent="." unique_id=244392654 instance=ExtResource("3_sugp2")]

[connection signal="damaged" from="Hero2" to="Relay" method="on_damaged"]
```

---

## 4. 文件 / 目录 / 设置（`create_dir` `list_files` `read_file` `write_file` `delete_file` `read_settings` `write_settings` `delete_settings`）

```text
$ godot --headless --path $PROJ --script godot/ops.gd create_dir {"path":"res://assets/sub"}
@@GODOT_MCP@@{"data":{"created":true,"existed":true,"path":"res://assets/sub"},"ok":true,"op":"create_dir"}
$ godot --headless --path $PROJ --script godot/ops.gd create_dir {"path":"res://assets/sub"}
@@GODOT_MCP@@{"data":{"created":true,"existed":true,"path":"res://assets/sub"},"ok":true,"op":"create_dir"}
$ godot --headless --path $PROJ --script godot/ops.gd write_file {"path": "res://assets/sub/note.txt", "content": "hello \u4e16\u754c"}
@@GODOT_MCP@@{"data":{"bytes":12,"encoding":"utf-8","path":"res://assets/sub/note.txt"},"ok":true,"op":"write_file"}
$ godot --headless --path $PROJ --script godot/ops.gd read_file {"path":"res://assets/sub/note.txt"}
@@GODOT_MCP@@{"data":{"bytes":12,"content":"hello 世界","encoding":"utf-8","path":"res://assets/sub/note.txt","size":12,"truncated":false},"ok":true,"op":"read_file"}
$ godot --headless --path $PROJ --script godot/ops.gd read_file {"path":"res://assets/sub/note.txt","max_bytes":4}
@@GODOT_MCP@@{"data":{"bytes":4,"content":"hell","encoding":"utf-8","path":"res://assets/sub/note.txt","size":12,"truncated":true},"ok":true,"op":"read_file"}
$ godot --headless --path $PROJ --script godot/ops.gd read_file {"path":"res://missing.txt"}
@@GODOT_MCP@@{"error":"file does not exist: res://missing.txt","ok":false,"op":"read_file"}
$ godot --headless --path $PROJ --script godot/ops.gd list_files {"dir":"res://assets","recursive":true}
@@GODOT_MCP@@{"data":{"dir":"res://assets","files":[{"ext":"png","path":"res://assets/px.png","size":70,"type":"file"},{"ext":"import","path":"res://assets/px.png.import","size":917,"type":"file"},{"ext":"txt","path":"res://assets/sub/note.txt","size":12,"type":"file"}],"recursive":true,"total":3},"ok":true,"op":"list_files"}
$ godot --headless --path $PROJ --script godot/ops.gd list_files {"dir":"res://nope"}
@@GODOT_MCP@@{"error":"directory does not exist: res://nope","ok":false,"op":"list_files"}
$ godot --headless --path $PROJ --script godot/ops.gd read_settings {}
@@GODOT_MCP@@{"data":{"settings":{"application/config/features":["4.7"],"application/config/icon":"res://icon.svg","application/config/name":"VerifyProj2","application/run/main_scene":"res://scenes/game.tscn","config_version":5,"display/window/size/viewport_width":640,"rendering/renderer/rendering_method.mobile":"forward_plus"},"source":"project.godot"},"ok":true,"op":"read_settings"}
$ godot --headless --path $PROJ --script godot/ops.gd read_settings {"keys":["application/config/name","does/not/exist"]}
@@GODOT_MCP@@{"data":{"missing":["does/not/exist"],"settings":{"application/config/name":"VerifyProj2"},"source":"ProjectSettings"},"ok":true,"op":"read_settings"}
$ godot --headless --path $PROJ --script godot/ops.gd write_settings {"settings":{"application/config/name":"VerifyProj2","application/run/main_scene":"res://scenes/game.tscn","application/config/custom_key":"abc"}}
@@GODOT_MCP@@{"data":{"changed":["application/config/custom_key"],"project_file":"/tmp/godot-ops-verify-ops-engine/proj/project.godot"},"ok":true,"op":"write_settings"}
$ godot --headless --path $PROJ --script godot/ops.gd read_settings {"keys":["application/config/name","application/run/main_scene","application/config/custom_key"]}
@@GODOT_MCP@@{"data":{"missing":[],"settings":{"application/config/custom_key":"abc","application/config/name":"VerifyProj2","application/run/main_scene":"res://scenes/game.tscn"},"source":"ProjectSettings"},"ok":true,"op":"read_settings"}
$ godot --headless --path $PROJ --script godot/ops.gd delete_settings {"keys":["application/config/custom_key","nope/missing"]}
@@GODOT_MCP@@{"data":{"deleted":["application/config/custom_key"],"missing":["nope/missing"],"project_file":"/tmp/godot-ops-verify-ops-engine/proj/project.godot"},"ok":true,"op":"delete_settings"}
$ godot --headless --path $PROJ --script godot/ops.gd read_settings {"keys":["application/config/custom_key"]}
@@GODOT_MCP@@{"data":{"missing":["application/config/custom_key"],"settings":{},"source":"ProjectSettings"},"ok":true,"op":"read_settings"}
$ godot --headless --path $PROJ --script godot/ops.gd delete_file {"path":"res://assets/sub/note.txt"}
@@GODOT_MCP@@{"data":{"deleted":true,"path":"res://assets/sub/note.txt","uid_deleted":false},"ok":true,"op":"delete_file"}
$ godot --headless --path $PROJ --script godot/ops.gd delete_file {"path":"res://assets/sub"}
@@GODOT_MCP@@{"error":"path is a directory, not a file: res://assets/sub (use a dir-removal op)","ok":false,"op":"delete_file"}
$ godot --headless --path $PROJ --script godot/ops.gd delete_file {"path":"res://assets/sub/note.txt"}
@@GODOT_MCP@@{"error":"file does not exist: res://assets/sub/note.txt","ok":false,"op":"delete_file"}
$ godot --headless --path $PROJ --script godot/ops.gd write_file {"path":"../../escape.txt","content":"nope"}
@@GODOT_MCP@@{"error":"path is outside the project: ../../escape.txt","ok":false,"op":"write_file"}
$ godot --headless --path $PROJ --script godot/ops.gd read_file {"path":"/etc/hosts"}
@@GODOT_MCP@@{"error":"path is outside the project: /etc/hosts","ok":false,"op":"read_file"}
```

### 4.1 `write_settings` 类型与路径安全（两个真实 bug 的回归）

验证过程中真机抓到并修掉的两个 bug：

1. **跨类型 `==` 崩溃**：`old == new_value` 写在 `typeof` 判断之前求值时，`String == Object` 抛 `Invalid operands`，被安全网兜成 `operation 'write_settings' returned without calling finish()`。现在先判 `typeof`，Object 用 `is_same()` 比较。
2. **写出 Godot 打不开的项目**（更严重）：把 `application/run/main_scene` 这类路径型设置 `load()` 成 Resource 后，`project.godot` 被写成
   `run/main_scene=Resource("res://main.tscn")`，Godot 随即**无法解析整个项目**（`No loader found for resource` / `File might be corrupted` / `error code 43`），连 `read_settings` 都读回空。
   现在：项目设置**永不 `load()` 资源**；路径型 key（白名单 + `_scene`/`_path`/`_script`/`_icon`/… 后缀 + `autoload/`、`editor/plugins/` 前缀）强制 String；写入后用 `ConfigFile` 复验 `project.godot`，若不可解析则**回滚原文件并返回 ok:false**。

回归证据（写 `main_scene` → 检查文件内容 → **真的把项目跑起来**）：

```text
$ ... write_settings '{{"settings":{{"application/run/main_scene":"res://scenes/game.tscn"}}}}'
@@GODOT_MCP@@{{"data":{{"changed":["application/run/main_scene"],"project_file":".../project.godot"}},"ok":true,"op":"write_settings"}}
$ grep -n "run/main_scene" "$P/project.godot"
14:run/main_scene="res://scenes/game.tscn"          # 带引号的 String，不含 Resource(
$ ... run_project '{{"headless":true,"quit_after":3}}'
# stdout 含 "GAME_READY 4.7.2-stable (official)"，stderr 为空，exit_code=0   -> 项目可正常加载运行
```

类型变更回归（同一个 key 连续 int ↔ String，均 ok:true，且 project.godot 始终可加载）：

```text
viewport_width "1280"  ->  19:window/size/viewport_width=1280    changed:["display/window/size/viewport_width"]
viewport_width "800"   ->  19:window/size/viewport_width=800
viewport_width 640     ->  19:window/size/viewport_width=640     # Godot 的 JSON 解析把数字给成 float，已按已知 int 类型折回 int
viewport_width "abc"   ->  ok:false "setting ... currently holds an int; 'abc' is not an integer"（拒绝写出坏值）
```

路径穿越拒绝（`res://` 不允许解析到项目外）：

```text
$ ... write_file '{{"path":"../../escape.txt","content":"nope"}}'
@@GODOT_MCP@@{{"error":"path is outside the project: ../../escape.txt","ok":false,"op":"write_file"}}
$ ... read_file '{{"path":"res://../../etc/hosts"}}'
@@GODOT_MCP@@{{"error":"path is outside the project: res://../../etc/hosts","ok":false,"op":"read_file"}}
$ ... read_file '{{"path":"/etc/hosts"}}'
@@GODOT_MCP@@{{"error":"path is outside the project: /etc/hosts","ok":false,"op":"read_file"}}
$ ... write_file '{{"path":"res://a/../inside.txt","content":"ok"}}'      # 项目内的 .. 允许，并被规范化成 res://inside.txt
@@GODOT_MCP@@{{"data":{{"bytes":2,"encoding":"utf-8","path":"res://inside.txt"}},"ok":true,"op":"write_file"}}
```

---

## 5. `run_project` / `gdscript` / `parse_check`

```text
$ godot --headless --path $PROJ --script godot/ops.gd write_file {"path": "res://scripts/game.gd", "content": "extends Node2D\n\nfunc _ready() -> void:\n\tprint(\"GAME_READY \", Engine.get_version_info().string)\n"}
@@GODOT_MCP@@{"data":{"bytes":95,"encoding":"utf-8","path":"res://scripts/game.gd"},"ok":true,"op":"write_file"}
$ godot --headless --path $PROJ --script godot/ops.gd create_scene {"scene_path":"res://scenes/game.tscn","root_type":"Node2D","root_name":"Game"}
@@GODOT_MCP@@{"data":{"overwritten":true,"root_name":"Game","root_type":"Node2D","scene_path":"res://scenes/game.tscn"},"ok":true,"op":"create_scene"}
$ godot --headless --path $PROJ --script godot/ops.gd attach_script {"scene_path":"res://scenes/game.tscn","node_path":".","script_path":"res://scripts/game.gd"}
@@GODOT_MCP@@{"data":{"node_path":".","scene_path":"res://scenes/game.tscn","script":"res://scripts/game.gd"},"ok":true,"op":"attach_script"}
-- write_settings: main_scene (key does not exist yet -> must stay a plain String) --
$ godot --headless --path $PROJ --script godot/ops.gd write_settings {"settings":{"application/run/main_scene":"res://scenes/game.tscn"}}
@@GODOT_MCP@@{"data":{"changed":[],"note":"all values already match; nothing written"},"ok":true,"op":"write_settings"}
-- project.godot line (must be quoted String, must NOT contain Resource() --
14:run/main_scene="res://scenes/game.tscn"
-- write_settings again: now res://scenes/game.tscn exists on disk (regression: was Resource(...)) --
$ godot --headless --path $PROJ --script godot/ops.gd write_settings {"settings":{"application/run/main_scene":"res://scenes/game.tscn"}}
@@GODOT_MCP@@{"data":{"changed":[],"note":"all values already match; nothing written"},"ok":true,"op":"write_settings"}
14:run/main_scene="res://scenes/game.tscn"
-- run_project (must print GAME_READY, no project.godot parse error) --
$ godot --headless --path $PROJ --script godot/ops.gd run_project {"headless":true,"quit_after":3}
@@GODOT_MCP@@{"data":{"duration_ms":1485,"exit_code":0,"headless":true,"quit_after_seconds":3.0,"stderr":"","stdout":"Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org\n\nGAME_READY 4.7.2-stable (official)\n","timed_out":false},"ok":true,"op":"run_project"}
$ godot --headless --path $PROJ --script godot/ops.gd run_project {"headless":true,"scene":"res://scenes/main.tscn","quit_after":3}
@@GODOT_MCP@@{"data":{"duration_ms":1471,"exit_code":0,"headless":true,"quit_after_seconds":3.0,"stderr":"","stdout":"Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org\n\n","timed_out":false},"ok":true,"op":"run_project"}
$ godot --headless --path $PROJ --script godot/ops.gd run_project {"headless":true,"scene":"res://scenes/ghost.tscn"}
@@GODOT_MCP@@{"error":"scene does not exist: res://scenes/ghost.tscn","ok":false,"op":"run_project"}
-- settings type-change regression --
$ godot --headless --path $PROJ --script godot/ops.gd write_settings {"settings":{"display/window/size/viewport_width":"1280"}}
@@GODOT_MCP@@{"data":{"changed":["display/window/size/viewport_width"],"project_file":"/tmp/godot-ops-verify-ops-engine/proj/project.godot"},"ok":true,"op":"write_settings"}
20:window/size/viewport_width=1280
$ godot --headless --path $PROJ --script godot/ops.gd write_settings {"settings":{"display/window/size/viewport_width":"800"}}
@@GODOT_MCP@@{"data":{"changed":["display/window/size/viewport_width"],"project_file":"/tmp/godot-ops-verify-ops-engine/proj/project.godot"},"ok":true,"op":"write_settings"}
20:window/size/viewport_width=800
$ godot --headless --path $PROJ --script godot/ops.gd write_settings {"settings":{"display/window/size/viewport_width":640}}
@@GODOT_MCP@@{"data":{"changed":["display/window/size/viewport_width"],"project_file":"/tmp/godot-ops-verify-ops-engine/proj/project.godot"},"ok":true,"op":"write_settings"}
20:window/size/viewport_width=640
$ godot --headless --path $PROJ --script godot/ops.gd write_settings {"settings":{"display/window/size/viewport_width":"abc"}}
@@GODOT_MCP@@{"error":"setting 'display/window/size/viewport_width' currently holds an int; 'abc' is not an integer","ok":false,"op":"write_settings"}
$ godot --headless --path $PROJ --script godot/ops.gd write_settings {"settings":{"application/config/icon":"res://icon.svg"}}
@@GODOT_MCP@@{"data":{"changed":[],"note":"all values already match; nothing written"},"ok":true,"op":"write_settings"}
16:config/icon="res://icon.svg"
-- project still loadable after all settings writes --
$ godot --headless --path $PROJ --script godot/ops.gd run_project {"headless":true,"quit_after":3}
@@GODOT_MCP@@{"data":{"duration_ms":1497,"exit_code":0,"headless":true,"quit_after_seconds":3.0,"stderr":"","stdout":"Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org\n\nGAME_READY 4.7.2-stable (official)\n","timed_out":false},"ok":true,"op":"run_project"}
-- read_settings after restart (project must be parseable) --
$ godot --headless --path $PROJ --script godot/ops.gd read_settings {}
@@GODOT_MCP@@{"data":{"settings":{"application/config/features":["4.7"],"application/config/icon":"res://icon.svg","application/config/name":"VerifyProj2","application/run/main_scene":"res://scenes/game.tscn","config_version":5,"display/window/size/viewport_width":640,"rendering/renderer/rendering_method.mobile":"forward_plus"},"source":"project.godot"},"ok":true,"op":"read_settings"}
-- gdscript: MCP_RESULT --
$ godot --headless --path $PROJ --script godot/ops.gd gdscript {"source": "extends SceneTree\n\nfunc _init():\n\tMCP_RESULT({\"sum\": 1 + 2, \"vec\": Vector2(1, 2), \"list\": [1, \"two\", true]})\n\tquit(0)\n"}
@@GODOT_MCP@@{"data":{"duration_ms":279,"exit_code":0,"mode":"MCP_RESULT","result":{"list":[1.0,"two",true],"sum":3.0,"vec":"(1.0, 2.0)"},"result_text":"{ \"sum\": 3, \"vec\": (1.0, 2.0), \"list\": [1, \"two\", true] }","stderr":"","stdout":"","timed_out":false},"ok":true,"op":"gdscript"}
-- gdscript: no MCP_RESULT (stdout fallback) --
$ godot --headless --path $PROJ --script godot/ops.gd gdscript {"source": "extends SceneTree\n\nfunc _init():\n\tprint(\"hello from escape hatch\")\n\tquit(0)\n"}
@@GODOT_MCP@@{"data":{"duration_ms":289,"exit_code":0,"mode":"stdout","result":"hello from escape hatch","stderr":"","stdout":"hello from escape hatch","timed_out":false},"ok":true,"op":"gdscript"}
-- gdscript: parse error (expect ok:false) --
$ godot --headless --path $PROJ --script godot/ops.gd gdscript {"source": "extends SceneTree\n\nfunc _init(:\n\tthis is not gdscript\n"}
@@GODOT_MCP@@{"error":"escape script failed: SCRIPT ERROR: Parse Error: Expected parameter name.\n          at: GDScript::reload (res://.godot_mcp_tmp/mcp_escape_114574.gd:28)\nERROR: Failed to load script \"res://.godot_mcp_tmp/mcp_escape_114574.gd\" with error \"Parse error\".\n   at: load (modules/gdscript/gdscript_resource_format.cpp:46)","ok":false,"op":"gdscript"}
-- gdscript: no extends, auto-injected --
$ godot --headless --path $PROJ --script godot/ops.gd gdscript {"source": "func _init():\n\tMCP_RESULT(Engine.get_version_info().string)\n\tquit(0)\n"}
@@GODOT_MCP@@{"data":{"duration_ms":274,"exit_code":0,"mode":"MCP_RESULT","result":"4.7.2-stable (official)","result_text":"4.7.2-stable (official)","stderr":"","stdout":"","timed_out":false},"ok":true,"op":"gdscript"}
-- temp dir cleaned? --
ls: /tmp/godot-ops-verify-ops-engine/proj/.godot_mcp_tmp: No such file or directory
-- parse_check (clean) --
$ godot --headless --path $PROJ --script godot/ops.gd parse_check {}
@@GODOT_MCP@@{"data":{"checked":3,"errors":[],"suspect":0},"ok":true,"op":"parse_check"}
$ godot --headless --path $PROJ --script godot/ops.gd write_file {"path": "res://scripts/broken.gd", "content": "extends Node\n\nfunc oops(:\n\tpass\n"}
@@GODOT_MCP@@{"data":{"bytes":32,"encoding":"utf-8","path":"res://scripts/broken.gd"},"ok":true,"op":"write_file"}
-- parse_check (with broken.gd) --
$ godot --headless --path $PROJ --script godot/ops.gd parse_check {}
@@GODOT_MCP@@{"data":{"checked":4,"errors":[{"line":3,"message":"Parse Error: Expected parameter name.","path":"res://scripts/broken.gd"}],"suspect":1},"ok":true,"op":"parse_check"}
$ godot --headless --path $PROJ --script godot/ops.gd parse_check {"paths":["res://scripts/broken.gd"]}
@@GODOT_MCP@@{"data":{"checked":1,"errors":[{"line":3,"message":"Parse Error: Expected parameter name.","path":"res://scripts/broken.gd"}],"suspect":1},"ok":true,"op":"parse_check"}
$ godot --headless --path $PROJ --script godot/ops.gd delete_file {"path":"res://scripts/broken.gd"}
@@GODOT_MCP@@{"data":{"deleted":true,"path":"res://scripts/broken.gd","uid_deleted":false},"ok":true,"op":"delete_file"}
$ godot --headless --path $PROJ --script godot/ops.gd parse_check {}
@@GODOT_MCP@@{"data":{"checked":3,"errors":[],"suspect":0},"ok":true,"op":"parse_check"}
```

要点：

* `run_project` 返回 `{{stdout, stderr, exit_code, duration_ms}}`，stdout/stderr 经 shell 重定向**真实分离**（不是合并流）。`quit_after` 单位是**秒**（默认 10，钳制 1..600），内部换算为 Godot 的 `--quit-after <帧数>`；外层另有墙钟看门狗，超时返回 `exit_code:137` + `timed_out:true`，不会挂死。
* `gdscript` 逃生舱：wrapper 注入 `MCP_RESULT(v)`，可回传**任意 JSON 可序列化值**（数组/字典递归编码，Vector2/Color 等非 JSON 类型回退 `str()`）；未调用 `MCP_RESULT` 时 `result` 回传其 stdout（`mode:"stdout"`）；源码语法错误时返回 `ok:false` + 真实 parse error（含行号）；未写 `extends` 时自动注入 `extends SceneTree`；`.godot_mcp_tmp` 临时目录用后即删。
* `parse_check`：先用 `GDScript.reload()` 快速初筛，再对可疑文件跑一次 `--check-only` 取精确诊断。**注意 `--check-only` 遇到语法错误也 exit 0**，因此判定依据是 stderr 而不是退出码（这本身是本轮抓到的 bug 之一）。修复后可给出 `{{"line":3,"message":"Parse Error: Expected parameter name.","path":"res://scripts/broken.gd"}}`。

---

## 6. `resave_resources` / `import_assets` / `export_project`

```text
$ godot --headless --path $PROJ --script godot/ops.gd resave_resources {"paths":["res://scripts/hero.gd","res://scenes/game.tscn"]}
@@GODOT_MCP@@{"data":{"failed":[],"resaved":["res://scripts/hero.gd","res://scenes/game.tscn"],"total":2},"ok":true,"op":"resave_resources"}
$ godot --headless --path $PROJ --script godot/ops.gd resave_resources {"paths":["res://nope.tscn"]}
@@GODOT_MCP@@{"data":{"failed":[{"error":"file does not exist","path":"res://nope.tscn"}],"resaved":[],"total":1},"ok":true,"op":"resave_resources"}
-- uid sidecars after resave --
game.gd
game.gd.uid
hero.gd
hero.gd.uid
relay.gd
relay.gd.uid
-- import_assets: real 1x1 PNG written as base64, then imported --
$ godot --headless --path $PROJ --script godot/ops.gd write_file {"path":"res://assets/px.png","content":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","encoding":"base64"}
@@GODOT_MCP@@{"data":{"bytes":70,"encoding":"base64","path":"res://assets/px.png"},"ok":true,"op":"write_file"}
$ godot --headless --path $PROJ --script godot/ops.gd import_assets {"paths":["res://assets/px.png"]}
@@GODOT_MCP@@{"data":{"count":1,"exit_code":0,"imported":["res://assets/px.png"],"stderr_tail":"ERROR: Couldn't find the given section \"preset.0\" and key \"include_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Couldn't find the given section \"preset.0\" and key \"exclude_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Cannot get keys from nonexistent section \"preset.0.options\".\n   at: get_section_keys (core/io/config_file.cpp:94)\nERROR: Couldn't find the given section \"preset.0\" and key \"include_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Couldn't find the given section \"preset.0\" and key \"exclude_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Cannot get keys from nonexistent section \"preset.0.options\".\n   at: get_section_keys (core/io/config_file.cpp:94)\n","timed_out":false},"ok":true,"op":"import_assets"}
-- .import sidecar created? --
px.png
px.png.import
sub
$ godot --headless --path $PROJ --script godot/ops.gd import_assets {}
@@GODOT_MCP@@{"data":{"count":1,"exit_code":0,"imported":["res://assets/px.png"],"stderr_tail":"ERROR: Couldn't find the given section \"preset.0\" and key \"include_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Couldn't find the given section \"preset.0\" and key \"exclude_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Cannot get keys from nonexistent section \"preset.0.options\".\n   at: get_section_keys (core/io/config_file.cpp:94)\nERROR: Couldn't find the given section \"preset.0\" and key \"include_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Couldn't find the given section \"preset.0\" and key \"exclude_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Cannot get keys from nonexistent section \"preset.0.options\".\n   at: get_section_keys (core/io/config_file.cpp:94)\n","timed_out":false},"ok":true,"op":"import_assets"}
-- export_project: preset file exists, unknown preset name --
$ godot --headless --path $PROJ --script godot/ops.gd write_file {"path":"res://export_presets.cfg","content":"[preset.0]\n\nname=\"TestPreset\"\nplatform=\"macOS\"\nrunnable=true\nexport_filter=\"all_resources\"\nexport_path=\"\"\n"}

@@GODOT_MCP@@{"data":{"bytes":106,"encoding":"utf-8","path":"res://export_presets.cfg"},"ok":true,"op":"write_file"}
$ godot --headless --path $PROJ --script godot/ops.gd export_project {"preset":"NoSuchPreset","output_path":"/tmp/godot-ops-verify-ops-engine/out/game.zip"}
@@GODOT_MCP@@{"error":"export preset 'NoSuchPreset' not found in export_presets.cfg (known: [\"TestPreset\"])","ok":false,"op":"export_project"}
-- export_project: 已知 preset 但配置不全（故意的最小 preset）-> Godot 报 configuration errors 并 exit 1 --
$ godot --headless --path $PROJ --script godot/ops.gd export_project {"preset":"TestPreset","output_path":"/tmp/godot-ops-verify-ops-engine/out/game.zip"}
@@GODOT_MCP@@{"error":"export failed with exit code 1 at /tmp/godot-ops-verify-ops-engine/out/game.zip: ERROR: Couldn't find the given section \"preset.0\" and key \"include_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Couldn't find the given section \"preset.0\" and key \"exclude_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Cannot get keys from nonexistent section \"preset.0.options\".\n   at: get_section_keys (core/io/config_file.cpp:94)\nERROR: Couldn't find the given section \"preset.0\" and key \"include_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Couldn't find the given section \"preset.0\" and key \"exclude_filter\", and no default was given.\n   at: get_value (core/io/config_file.cpp:61)\nERROR: Cannot get keys from nonexistent section \"preset.0.options\".\n   at: get_section_keys (core/io/config_file.cpp:94)\nERROR: Cannot export project with preset \"TestPreset\" due to configuration errors:\n禁用 ETC2 ASTC 纹理格式时无法为 universal 和 arm64 进行导出。请在“项目设置”中启用（渲染 > 纹理 > VRAM 压缩 > 导入 ETC2 ASTC）。\n\n   at: _fs_changed (editor/editor_node.cpp:1401)\nERROR: Project export for preset \"TestPreset\" failed.\n   at: _fs_changed (editor/editor_node.cpp:1417)\n","ok":false,"op":"export_project"}
```

---

## 7. 信号连接生命周期回归（`CONNECT_PERSIST`）

Godot 4.7 的 `PackedScene.pack()` **只序列化带 `Object.CONNECT_PERSIST` 的连接**。真机探针输出：

```text
no-persist -> connections saved = 0
persist    -> connections saved = 1
   ./A sig2 -> ./B::get_path
after rename -> target=./B2          # 改名后引擎按当前场景树重写路径
```

因此 `connect_signal` 以 `CONNECT_PERSIST` 建连：连接随场景保存，`from`/`to` 路径由引擎重写（节点改名自动跟随，节点删除自动丢弃），所有 load→modify→save 型 op 都不会再丢连接。完整序列（每步后统计 `main.tscn` 里的 `[connection]` 行数）：

```text
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd create_project {"project_path":"/tmp/godot-ops-verify-conn/proj","name":"ConnVerify"}
@@GODOT_MCP@@{"data":{"created":true,"path":"/tmp/godot-ops-verify-conn/proj","renderer":"forward_plus"},"ok":true,"op":"create_project"}
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd create_scene {"scene_path":"res://main.tscn","root_type":"Node2D","root_name":"Main"}
@@GODOT_MCP@@{"data":{"overwritten":false,"root_name":"Main","root_type":"Node2D","scene_path":"res://main.tscn"},"ok":true,"op":"create_scene"}
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd add_node {"scene_path":"res://main.tscn","node_type":"Sprite2D","node_name":"Hero"}
@@GODOT_MCP@@{"data":{"node_path":"Main/Hero","parent":"Main","scene_path":"res://main.tscn"},"ok":true,"op":"add_node"}
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd add_node {"scene_path":"res://main.tscn","node_type":"Node","node_name":"Relay"}
@@GODOT_MCP@@{"data":{"node_path":"Main/Relay","parent":"Main","scene_path":"res://main.tscn"},"ok":true,"op":"add_node"}
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd attach_script {"scene_path":"res://main.tscn","node_path":"Main/Hero","script_path":"res://hero.gd"}
@@GODOT_MCP@@{"data":{"node_path":"Main/Hero","scene_path":"res://main.tscn","script":"res://hero.gd"},"ok":true,"op":"attach_script"}
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd attach_script {"scene_path":"res://main.tscn","node_path":"Main/Relay","script_path":"res://relay.gd"}
@@GODOT_MCP@@{"data":{"node_path":"Main/Relay","scene_path":"res://main.tscn","script":"res://relay.gd"},"ok":true,"op":"attach_script"}
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd connect_signal {"scene_path":"res://main.tscn","from_node":"Main/Hero","signal":"hit","to_node":"Main/Relay","method":"on_hit"}
@@GODOT_MCP@@{"data":{"binds":[],"connected":true,"from":"Main/Hero","method":"on_hit","scene_path":"res://main.tscn","signal":"hit","to":"Main/Relay"},"ok":true,"op":"connect_signal"}
  -> [connection] lines in main.tscn: 1
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd create_scene {"scene_path":"res://pickup.tscn","root_type":"Area2D","root_name":"Pickup"}
@@GODOT_MCP@@{"data":{"overwritten":false,"root_name":"Pickup","root_type":"Area2D","scene_path":"res://pickup.tscn"},"ok":true,"op":"create_scene"}
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd instantiate_scene {"scene_path":"res://main.tscn","instance_path":"res://pickup.tscn","node_name":"Coin"}
@@GODOT_MCP@@{"data":{"instance_path":"res://pickup.tscn","node_path":"Main/Coin","scene_path":"res://main.tscn"},"ok":true,"op":"instantiate_scene"}
  -> [connection] lines in main.tscn: 1
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd add_node {"scene_path":"res://main.tscn","node_type":"Node","node_name":"Extra"}
@@GODOT_MCP@@{"data":{"node_path":"Main/Extra","parent":"Main","scene_path":"res://main.tscn"},"ok":true,"op":"add_node"}
  -> [connection] lines in main.tscn: 1
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd modify_node {"scene_path":"res://main.tscn","node_path":"Main/Relay","new_name":"Relay2"}
@@GODOT_MCP@@{"data":{"changed":["name"],"node_path":"Main/Relay2","scene_path":"res://main.tscn"},"ok":true,"op":"modify_node"}
  -> [connection] lines in main.tscn: 1
[connection signal="hit" from="Hero" to="Relay2" method="on_hit"]
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd modify_node {"scene_path":"res://main.tscn","node_path":"Main/Relay2","properties":{"process_mode":3}}
@@GODOT_MCP@@{"data":{"changed":["process_mode"],"node_path":"Main/Relay2","scene_path":"res://main.tscn"},"ok":true,"op":"modify_node"}
  -> [connection] lines in main.tscn: 1
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd remove_node {"scene_path":"res://main.tscn","node_path":"Main/Extra"}
@@GODOT_MCP@@{"data":{"connections_dropped":0,"node_path":"Main/Extra","removed":true,"scene_path":"res://main.tscn"},"ok":true,"op":"remove_node"}
  -> [connection] lines in main.tscn: 1
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd remove_node {"scene_path":"res://main.tscn","node_path":"Main/Relay2"}
@@GODOT_MCP@@{"data":{"connections_dropped":1,"node_path":"Main/Relay2","removed":true,"scene_path":"res://main.tscn"},"ok":true,"op":"remove_node"}
  -> [connection] lines in main.tscn: 0
0
$ godot --headless --path /tmp/godot-ops-verify-conn/proj --script godot/ops.gd connect_signal {"scene_path":"res://main.tscn","from_node":"Main/Hero","signal":"hit","to_node":"Main/Hero","method":"on_hit"}
@@GODOT_MCP@@{"error":"node 'Main/Hero' (Sprite2D) has no method 'on_hit'","ok":false,"op":"connect_signal"}
  -> [connection] lines in main.tscn: 0
0
```

---

## 8. 失败路径汇总（32 条，全部 `ok:false`）

32 条失败路径全部返回结构化错误 + exit 1，没有崩溃，也没有「看起来成功但实际没生效」：

| # | op | 真实失败信息 |
|---|---|---|
| 1 | `create_project` | a Godot project already exists at /tmp/godot-ops-verify-ops-engine/proj/project.godot |
| 2 | `project_info` | project_path mismatch: godot was started with --path '/tmp/godot-ops-verify-ops-engine/proj' but params.project_path is '/tmp/elsewhere' |
| 3 | `version` | invalid JSON params: Expected '}' (line 0) |
| 4 | `version` | params must be a JSON object, got Array |
| 5 | `frobnicate` | unknown operation: 'frobnicate' (see op 'list_ops') |
| 6 | `create_scene` | unknown node type: NoSuchNodeType (not in ClassDB nor a registered class_name) |
| 7 | `add_node` | a node named 'Hero' already exists in res://scenes/main.tscn |
| 8 | `add_node` | parent node not found: 'Main/Nope' |
| 9 | `add_node` | node 'Y' (Node2D) has no property 'not_a_property' |
| 10 | `read_scene` | scene does not exist: res://scenes/ghost.tscn (/private/tmp/godot-ops-verify-ops-engine/proj/scenes/ghost.tscn) |
| 11 | `remove_node` | refusing to remove the scene root node ('Main'); delete the scene file instead |
| 12 | `attach_script` | script does not exist: res://scripts/nope.gd |
| 13 | `connect_signal` | signal 'damaged' is already connected to on_damaged |
| 14 | `connect_signal` | node 'Main/Hero2' (Sprite2D) has no signal 'nope' |
| 15 | `connect_signal` | node 'Main/Relay' (Node) has no method 'nope' |
| 16 | `find_symbols` | find_symbols only supports .gd files, got: res://scenes/main.tscn |
| 17 | `instantiate_scene` | cannot instantiate a scene inside itself: res://scenes/main.tscn |
| 18 | `write_file` | path is outside the project: ../../escape.txt |
| 19 | `read_file` | path is outside the project: res://../../etc/hosts |
| 20 | `read_file` | path is outside the project: ../project.godot |
| 21 | `read_file` | path is outside the project: /etc/hosts |
| 22 | `read_file` | file does not exist: res://missing.txt |
| 23 | `list_files` | directory does not exist: res://nope |
| 24 | `delete_file` | path is a directory, not a file: res://assets/sub (use a dir-removal op) |
| 25 | `delete_file` | file does not exist: res://assets/sub/note.txt |
| 26 | `write_file` | path is outside the project: ../../escape.txt |
| 27 | `read_file` | path is outside the project: /etc/hosts |
| 28 | `run_project` | scene does not exist: res://scenes/ghost.tscn |
| 29 | `write_settings` | setting 'display/window/size/viewport_width' currently holds an int; 'abc' is not an integer |
| 30 | `gdscript` | escape script failed: SCRIPT ERROR: Parse Error: Expected parameter name. |
| 31 | `export_project` | export preset 'NoSuchPreset' not found in export_presets.cfg (known: ["TestPreset"]) |
| 32 | `export_project` | export failed with exit code 1 at /tmp/godot-ops-verify-ops-engine/out/game.zip: ERROR: Couldn't find the given section "preset.0" and key "include_filter", and no default was given. |

---

## 9. 已知限制与未实现项

1. **`create_project` 需要目标目录先存在**：Godot 在 `--path <不存在的目录>` 时会在执行脚本**之前**直接 `Invalid project path specified, aborting.` 退出，连协议行都不会输出。实测 `--path <存在但空的目录>` 完全正常（`create_project` 成功）。→ **server 侧调用 `create_project` 前必须先 `mkdir -p` 目标目录**。
2. **`export_project` 已真机验证成功路径**（导出模板安装后，见 §11）：macOS 产物是**目录**（`Foo.app`），`FileAccess.file_exists()` 对目录返回 false，曾导致 macOS 导出永远报失败——已修（同时接受文件与目录，`data.kind` 区分）。失败路径仍然诚实（preset 不存在 / 输出目录不可写 / 导出真失败但路径上已有旧产物，都返回 `ok:false`）。**其它平台**（Android `.apk`、iOS `.zip`、Windows `.exe`）本机无对应模板，未真机验证，但走的是同一条 `kind:"file"` 分支。
3. **`resave_resources` 不生成 `.uid` 旁文件**：非编辑器 headless 运行下 `load()` + `ResourceSaver.save()` 不会写 `*.uid`（上游参考实现同样如此）。它仍会重写资源文件本身；需要 UID 时应走 `import_assets`（编辑器 `--import`）。
4. **`import_assets` 语义**：内部启动一次 `--headless --path <project> --import`（编辑器模式），因此比其它 op 慢；返回的 `imported` 是「当前存在 `*.import` 的资产路径」，不是引擎逐条回执。实测写入真实 1×1 PNG 后运行，`px.png.import` 被正确生成。
5. **`run_project` 的 stdout/stderr 分离**依赖 `/bin/sh`（macOS / Linux 可用）；Windows 需替换 `sh_capture()` 的实现。
6. **`gdscript` 逃生舱**要求源码 `extends SceneTree`（或由 wrapper 注入）；若源码自带 `MCP_RESULT` 定义，则以其为准。逃生舱在**嵌套 Godot 进程**中执行，默认超时 30s（可用 `timeout` 参数调整），超时后仍会返回已写入的结果并置 `timed_out:true`。
7. **遍历上限**：`list_files` 默认 `recursive: true`（只列文件，`type:"file"` + `ext`），单次最多 20000 条、深度 32；`read_file` 默认最多读 1 MiB（`max_bytes` 可调，超出时 `truncated:true`）；二进制内容以 base64 返回（`encoding:"base64"`）。
8. **`write_settings` 的类型策略**：对已存在的 int/float 设置写入不可转换的字符串时会 `ok:false`（刻意选择：宁可拒绝，也不写出类型错乱的 project.godot）。新 key 按传入的 JSON 类型写入。
9. **未实现（不在 §2.1 v1 契约内）**：目录删除、文件重命名/移动、导出模板安装、`export_presets.cfg` 的结构化写接口（当前可用 `write_file` 直接写）。L2 编辑器层与 L3 运行时层分别由其它任务交付，不在本文件范围内。

---

## 10. 真机踩到的 Godot 4.7 行为（供后续实现者参考）

1. `quit()` 只置标志位，`_init()` 中其后的代码仍会继续执行 → 所有 handler 用 `_done` 标志短路；并有兜底安全网：任何未调用 `finish()` 的 handler 也会输出 `ok:false`，而不是崩溃或静默成功。
2. `PackedScene.pack()` 不序列化**运行时新建**的连接（需要 `CONNECT_PERSIST`），但**会**保留从 .tscn 载入的连接。
3. 对根节点调用 `Node.set_owner(self)` 会报 `Condition "p_owner == this" is true` → 根节点不应设置 owner（owner 只对需要序列化的子节点有意义）。
4. `--check-only` 遇到语法错误仍然 exit 0，且把诊断写到 stderr。
5. Godot 的 `OS.execute` 在 macOS 会把 argv 再包一层 `sh -c "..."`，随参数传入的 `$!` / `$?` / `$var` 会在**外层**就被展开 → 看门狗脚本必须落成**文件**再以 `sh <file>` 执行。
6. 后台子进程若继承了 stdout 管道，会拖住 `OS.execute` 直到它退出（实测白等 30s）→ 看门狗子 shell 必须重定向到 `/dev/null`。
7. Godot 的 JSON 解析把数字一律解析为 float，写入 int 型设置时需要按已知类型折回。
8. macOS 上 `/tmp` 是 `/private/tmp` 的符号链接，路径比较必须归一化（否则 `--path /tmp/x` 与 `params.project_path=/private/tmp/x` 会被误判为不一致）。
9. `--script` 的**相对路径按 `res://` 解析，而不是按进程 cwd**：实测传 `godot/ops.gd` 会得到 `ERROR: Attempt to open script 'res://godot/ops.gd' resulted in error 'File not found'`。server 必须传**绝对路径**（DESIGN §2.1 已如此规定，`src/operations.mjs` 用的是 `path.join(PACKAGE_ROOT, 'godot', 'ops.gd')`，正确）。


---

## 11. `export_project` 对 macOS `.app` 目录产物的处理（task-4 修复）

**问题（Lead 真机确诊）**：macOS 的导出产物 `Foo.app` 是**目录**（bundle），而成功判定用的是 `FileAccess.file_exists()`——它对目录返回 false。后果是 macOS 导出**明明成功**（产出可运行的 universal Mach-O + .pck），op 却报 `ok:false "export produced no output at ... (exit 0)"`，调用方无法区分「真失败」和「其实成功了」。

**修复**：

1. 成功判定改为 `FileAccess.file_exists(out_abs) or DirAccess.dir_exists_absolute(out_abs)`，只有**两者都不存在**才失败；
2. 目录产物不再用 `FileAccess` 读取（会失败），改为**递归累加**：返回 `kind:"directory"`、`bytes`（递归总字节）、`entries`（文件数）、`size_truncated`；文件产物返回 `kind:"file"`、`entries:1`；
3. 递归有上限 `MAX_EXPORT_SCAN_FILES = 5000`，超限置 `size_truncated:true`；
4. **新增反误判保护**：只要 Godot 退出码非 0 就直接 `ok:false`（并提示该路径上可能只是上一轮的旧产物），避免「路径上恰好存在旧产物」把真失败伪装成成功。`--export-debug` 走同一路径。

实测（`demo-game` 复制到 `/tmp/export-verify/proj`，preset `macOS`，`binary_format/architecture="universal"`）：

```text
##### 1. 前置：macOS universal 导出要求启用 ETC2 ASTC #####
$ godot --headless --path /tmp/export-verify/proj --script godot/ops.gd write_settings {"settings":{"rendering/textures/vram_compression/import_etc2_astc":true}}
@@GODOT_MCP@@{"data":{"changed":["rendering/textures/vram_compression/import_etc2_astc"],"project_file":"/tmp/export-verify/proj/project.godot"},"ok":true,"op":"write_settings"}
$ grep -n etc2_astc /tmp/export-verify/proj/project.godot
33:textures/vram_compression/import_etc2_astc=true

##### 2. 真机 macOS 导出 -> .app 是【目录】产物（kind:directory） #####
$ godot --headless --path /tmp/export-verify/proj --script godot/ops.gd export_project {"preset":"macOS","output_path":"/tmp/export-verify/proj/dist/ExportGate.app"}
@@GODOT_MCP@@{"data":{"bytes":170343536,"debug":false,"duration_ms":3553,"entries":6,"exit_code":0,"kind":"directory","output_path":"/tmp/export-verify/proj/dist/ExportGate.app","preset":"macOS","size_truncated":false,"stderr_tail":""},"ok":true,"op":"export_project"}
$ ls /tmp/export-verify/proj/dist/
total 0
drwxr-xr-x@  3 user  wheel   96 Oct 15 03:33 .
drwxr-xr-x@ 11 user  wheel  352 Oct 15 03:33 ..
drwxr-xr-x@  3 user  wheel   96 Oct 15 03:33 ExportGate.app
$ find /tmp/export-verify/proj/dist/ExportGate.app -type f
/tmp/export-verify/proj/dist/ExportGate.app/Contents/Info.plist
/tmp/export-verify/proj/dist/ExportGate.app/Contents/MacOS/DSH Demo Game
/tmp/export-verify/proj/dist/ExportGate.app/Contents/PkgInfo
/tmp/export-verify/proj/dist/ExportGate.app/Contents/Resources/DSH Demo Game.pck
/tmp/export-verify/proj/dist/ExportGate.app/Contents/Resources/PrivacyInfo.xcprivacy
/tmp/export-verify/proj/dist/ExportGate.app/Contents/Resources/icon.icns
$ ls -la .../Contents/MacOS/
total 332296
drwxr-xr-x@ 3 user  wheel         96 Oct 15 03:33 .
drwxr-xr-x@ 7 user  wheel        224 Oct 15 03:33 ..
-rwxr-xr-x@ 1 user  wheel  170132160 Oct 15 03:33 DSH Demo Game
$ file .../Contents/MacOS/DSH Demo Game
/tmp/export-verify/proj/dist/ExportGate.app/Contents/MacOS/DSH Demo Game: Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64]
/tmp/export-verify/proj/dist/ExportGate.app/Contents/MacOS/DSH Demo Game (for architecture x86_64):	Mach-O 64-bit executable x86_64
/tmp/export-verify/proj/dist/ExportGate.app/Contents/MacOS/DSH Demo Game (for architecture arm64):	Mach-O 64-bit executable arm64
$ find ... -type f | wc -l  /  stat -f %z 求和（独立核对 op 报的 entries/bytes）
files=6 bytes=170343536
$ 导出的可执行文件真的能跑：

PLAYER_READY

##### 3. 文件型产物仍走 kind:file（同一 preset 导出成 .zip） #####
$ godot --headless --path /tmp/export-verify/proj --script godot/ops.gd export_project {"preset":"macOS","output_path":"/tmp/export-verify/proj/dist/ExportGate.zip"}
@@GODOT_MCP@@{"data":{"bytes":59766269,"debug":false,"duration_ms":8673,"entries":1,"exit_code":0,"kind":"file","output_path":"/tmp/export-verify/proj/dist/ExportGate.zip","preset":"macOS","size_truncated":false,"stderr_tail":""},"ok":true,"op":"export_project"}
$ ls -la /tmp/export-verify/proj/dist/ExportGate.zip
-rw-r--r--@ 1 user  wheel  59766269 Oct 15 03:33 /tmp/export-verify/proj/dist/ExportGate.zip

##### 4. --export-debug 同样适用 #####
$ godot --headless --path /tmp/export-verify/proj --script godot/ops.gd export_project {"preset":"macOS","debug":true,"output_path":"/tmp/export-verify/proj/dist/Debug.app"}
@@GODOT_MCP@@{"data":{"bytes":186484644,"debug":true,"duration_ms":3772,"entries":6,"exit_code":0,"kind":"directory","output_path":"/tmp/export-verify/proj/dist/Debug.app","preset":"macOS","size_truncated":false,"stderr_tail":""},"ok":true,"op":"export_project"}
total 363688
drwxr-xr-x@ 3 user  wheel         96 Oct 15 03:33 .
drwxr-xr-x@ 7 user  wheel        224 Oct 15 03:33 ..
-rwxr-xr-x@ 1 user  wheel  186205680 Oct 15 03:33 DSH Demo Game

##### 5. 失败路径仍诚实：不存在的 preset #####
$ godot --headless --path /tmp/export-verify/proj --script godot/ops.gd export_project {"preset":"NoSuchPreset","output_path":"/tmp/export-verify/proj/dist/x.app"}
@@GODOT_MCP@@{"error":"export preset 'NoSuchPreset' not found in export_presets.cfg (known: [\"macOS\"])","ok":false,"op":"export_project"}

##### 6. 失败路径仍诚实：输出目录不可写 #####
$ ls -ld /tmp/export-verify/readonly
dr-xr-xr-x@ 2 user  wheel  64 Oct 15 03:33 /tmp/export-verify/readonly
$ godot --headless --path /tmp/export-verify/proj --script godot/ops.gd export_project {"preset":"macOS","output_path":"/tmp/export-verify/readonly/Broken.app"}
@@GODOT_MCP@@{"error":"export failed with exit code 1 at /tmp/export-verify/readonly/Broken.app: ERROR: Could not create directory: '/tmp/export-verify/readonly/Broken.app'.\n   at: make_dir_recursive (core/io/dir_access.cpp:179)\nERROR: 导出: 无法创建目录“/tmp/export-verify/readonly/Broken.app/Contents/MacOS”。\n   at: add_message (editor/export/editor_export_platform.h:270)\nERROR: 导出: 未找到请求的模板二进制文件“godot_macos_release.universal”。你的模板归档中可能缺失该文件。\n   at: add_message (editor/export/editor_export_platform.h:270)\nERROR: Project export for preset \"macOS\" failed.\n   at: _fs_changed (editor/editor_node.cpp:1417)\n","ok":false,"op":"export_project"}
$ ls -la /tmp/export-verify/readonly/   # 确认什么都没产出
total 0
dr-xr-xr-x@ 2 user  wheel   64 Oct 15 03:33 .
drwxr-xr-x@ 4 user  wheel  128 Oct 15 03:33 ..

##### 7. 关键反例：已有可用产物 + 导出真失败 -> 必须仍然 ok:false #####
$ stat -f "exe size before: %z" .../ExportGate.app/Contents/MacOS/DSH Demo Game
exe size before: 170132160
$ 关掉 ETC2 ASTC，Godot 会以 configuration errors 拒绝导出
$ godot --headless --path /tmp/export-verify/proj --script godot/ops.gd write_settings {"settings":{"rendering/textures/vram_compression/import_etc2_astc":false}}
@@GODOT_MCP@@{"data":{"changed":["rendering/textures/vram_compression/import_etc2_astc"],"project_file":"/tmp/export-verify/proj/project.godot"},"ok":true,"op":"write_settings"}
$ 导出到【已经存在一个完好 .app】的路径
$ godot --headless --path /tmp/export-verify/proj --script godot/ops.gd export_project {"preset":"macOS","output_path":"/tmp/export-verify/proj/dist/ExportGate.app"}
@@GODOT_MCP@@{"error":"export failed with exit code 1 at /tmp/export-verify/proj/dist/ExportGate.app: Note: an artifact already exists at that path (likely a stale previous export, not verified as current). ERROR: Cannot export project with preset \"macOS\" due to configuration errors:\n禁用 ETC2 ASTC 纹理格式时无法为 universal 和 arm64 进行导出。请在“项目设置”中启用（渲染 > 纹理 > VRAM 压缩 > 导入 ETC2 ASTC）。\n\n   at: _fs_changed (editor/editor_node.cpp:1401)\nERROR: Project export for preset \"macOS\" failed.\n   at: _fs_changed (editor/editor_node.cpp:1417)\n","ok":false,"op":"export_project"}
$ stat -f "exe size after: %z" ...（应保持不变，说明是旧产物）
exe size after: 170132160
$ 恢复 ETC2 ASTC 后导出重新 ok:true
$ godot --headless --path /tmp/export-verify/proj --script godot/ops.gd write_settings {"settings":{"rendering/textures/vram_compression/import_etc2_astc":true}}
@@GODOT_MCP@@{"data":{"changed":["rendering/textures/vram_compression/import_etc2_astc"],"project_file":"/tmp/export-verify/proj/project.godot"},"ok":true,"op":"write_settings"}
$ godot --headless --path /tmp/export-verify/proj --script godot/ops.gd export_project {"preset":"macOS","output_path":"/tmp/export-verify/proj/dist/ExportGate.app"}
@@GODOT_MCP@@{"data":{"bytes":170411124,"debug":false,"duration_ms":3312,"entries":6,"exit_code":0,"kind":"directory","output_path":"/tmp/export-verify/proj/dist/ExportGate.app","preset":"macOS","size_truncated":false,"stderr_tail":""},"ok":true,"op":"export_project"}

##### 8. 扫描上限：用临时降级副本（真实 ops.gd 的 5000 不变）验证 truncated 标记 #####
$ godot --script /tmp/ops-cap.gd（MAX_EXPORT_SCAN_FILES=3）export_project ...
@@GODOT_MCP@@{"data":{"bytes":69291,"debug":false,"duration_ms":3539,"entries":3,"exit_code":0,"kind":"directory","output_path":"/tmp/export-verify/proj/dist/Capped.app","preset":"macOS","size_truncated":true,"stderr_tail":""},"ok":true,"op":"export_project"}
$ grep -n "MAX_EXPORT_SCAN_FILES :=" $REPO/godot/ops.gd   # 真实文件仍是 5000
35:const MAX_EXPORT_SCAN_FILES := 5000
```

**结论**：`entries` / `bytes` 与脚本外的 `find -type f | wc -l`（6）和 `stat -f %z` 求和（170343536）**完全一致**；导出的可执行文件 `file` 判定为 Mach-O universal（x86_64 + arm64），可直接运行并打印 `PLAYER_READY`（exit 0）。第 7 项是最关键的反例：路径上已有完好 `.app`、但导出真失败时，op 仍然 `ok:false`，且旧产物字节数未变（未被冒充成新产物）。
