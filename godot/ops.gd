#!/usr/bin/env -S godot --headless --script
#
# godot/ops.gd — L1 headless operation layer for the Godot MCP DSH plugin.
#
# Contract: DESIGN.md §2.1 (frozen). Invocation:
#   <godot> --headless --path <project> --script /abs/godot/ops.gd <operation> '<json_params>'
#
# Stdout protocol (single line, everything else on stdout is engine logging and is
# filtered by the Node server on the "@@GODOT_MCP@@" prefix):
#   success: @@GODOT_MCP@@{"ok":true,"op":"<op>","data":{...}}          exit 0
#   failure: @@GODOT_MCP@@{"ok":false,"op":"<op>","error":"<message>"}  exit 1
#
# Path convention used by scene ops (documented, stable):
#   * `scene_path`  : "res://dir/scene.tscn" or project-relative "dir/scene.tscn"
#   * `node_path`   : "root/Child/Grandchild"; the scene root may be addressed by its
#                     own name or by the literal "root"; "" / "." also means the root.
#
# MIT attribution: the packed-scene create/save flow, ClassDB-based node instantiation
# and the UID/resave strategy are adapted from Coding-Solo/godot-mcp
# (src/scripts/godot_operations.gd, MIT). See NOTICE.
extends SceneTree

const PROTOCOL := "@@GODOT_MCP@@"
const TMP_RES := "res://.godot_mcp_tmp"
const SH_TMP_RES := "user://mcp_tmp"
## 嵌套进程助手脚本的落盘目录：user:// 不可写时退回系统临时目录。
const SH_TMP_FALLBACK_DIR := "godot_mcp_tmp"
## 显式指定助手脚本目录（严格：设了就只用它，便于部署与验收构造失败路径）。
const HELPER_DIR_ENV := "GODOT_MCP_HELPER_DIR"
const DEFAULT_MAX_READ_BYTES := 1048576          # 1 MiB
const DEFAULT_MAX_DEPTH := 16
const MAX_WALK_FILES := 20000
const MAX_WALK_DEPTH := 32
const MAX_PROPERTIES_PER_NODE := 64
const DEFAULT_RUN_QUIT_AFTER := 10.0             # seconds
const MAX_RUN_QUIT_AFTER := 600.0
const DEFAULT_ESCAPE_TIMEOUT := 30.0
const EXPORT_TIMEOUT := 600.0
const MAX_EXPORT_SCAN_FILES := 5000
const IMPORT_TIMEOUT := 300.0
const NESTED_CHECK_ATTEMPTS := 25

const _TYPED_LITERAL_RE := "^(Vector2|Vector2i|Vector3|Vector3i|Vector4|Vector4i|Color|Rect2|Rect2i|Transform2D|Transform3D|Basis|Quaternion|Plane|AABB|NodePath|StringName|RID|PackedVector2Array|PackedVector3Array|PackedStringArray|PackedInt32Array|PackedInt64Array|PackedFloat32Array|PackedFloat64Array|PackedColorArray|Callable|Signal)\\s*\\("

var _op := "(unknown)"
var _params: Dictionary = {}
var _root := ""            # absolute project dir as Godot resolved --path (normalized)
var _script_file := ""      # this script path (from --script); used to locate the Node helper
var _rng_seeded := false    # 临时产物名里的随机后缀只需要 seed 一次
var _verdict_script: GDScript = null   # check_verdict.gd（惰性加载）
var _failed := false
var _done := false         # quit() only raises a flag: handlers must not run on

# --------------------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------------------

func _init() -> void:
	_root = _norm_abs(ProjectSettings.globalize_path("res://"))

	var args := OS.get_cmdline_args()
	var script_index := args.find("--script")
	if script_index == -1:
		script_index = args.find("-s")
	if script_index == -1:
		finish_error("could not find --script in command line: " + str(args))
		return
	if args.size() < script_index + 4:
		finish_error("usage: godot --headless --path <project> --script <ops.gd> <operation> <json_params>")
		return

	_script_file = str(args[script_index + 1])
	_op = str(args[script_index + 2])
	var raw_params := str(args[script_index + 3])

	var parser := JSON.new()
	if parser.parse(raw_params) != OK:
		finish_error("invalid JSON params: " + parser.get_error_message() + " (line " + str(parser.get_error_line()) + ")")
		return
	var parsed = parser.get_data()
	if typeof(parsed) != TYPE_DICTIONARY:
		finish_error("params must be a JSON object, got " + type_string(typeof(parsed)))
		return
	_params = parsed

	dispatch()
	# dispatch() always ends in finish()/finish_error(); this is a safety net for a
	# handler that forgot to terminate.
	if not _done:
		finish_error("operation '" + _op + "' returned without calling finish()")

func dispatch() -> void:
	match _op:
		"version": _op_version()
		"project_info": _op_project_info()
		"create_project": _op_create_project()
		"list_scenes": _op_list_scenes()
		"create_scene": _op_create_scene()
		"read_scene": _op_read_scene()
		"add_node": _op_add_node()
		"modify_node": _op_modify_node()
		"remove_node": _op_remove_node()
		"instantiate_scene": _op_instantiate_scene()
		"attach_script": _op_attach_script()
		"connect_signal": _op_connect_signal()
		"read_settings": _op_read_settings()
		"write_settings": _op_write_settings()
		"delete_settings": _op_delete_settings()
		"list_files": _op_list_files()
		"read_file": _op_read_file()
		"write_file": _op_write_file()
		"delete_file": _op_delete_file()
		"create_dir": _op_create_dir()
		"find_symbols": _op_find_symbols()
		"resave_resources": _op_resave_resources()
		"import_assets": _op_import_assets()
		"export_project": _op_export_project()
		"run_project": _op_run_project()
		"parse_check": _op_parse_check()
		"gdscript": _op_gdscript()
		"list_ops":
			finish({
				"ops": [
					"version", "project_info", "create_project", "list_scenes", "create_scene",
					"read_scene", "add_node", "modify_node", "remove_node", "instantiate_scene",
					"attach_script", "connect_signal", "read_settings", "write_settings",
					"delete_settings", "list_files", "read_file", "write_file", "delete_file",
					"create_dir", "find_symbols", "resave_resources", "import_assets",
					"export_project", "run_project", "parse_check", "gdscript",
				],
				"contract": "DESIGN.md 2.1",
			})
		_:
			# close typo suggestions help interactive clients
			finish_error("unknown operation: '" + _op + "' (see op 'list_ops')")

# --------------------------------------------------------------------------------------
# protocol
# --------------------------------------------------------------------------------------

func finish(data: Dictionary) -> void:
	_done = true
	var payload := {"ok": true, "op": _op, "data": json_safe(data)}
	print(PROTOCOL + JSON.stringify(payload))
	quit(0)

func finish_error(message: String) -> void:
	_failed = true
	_done = true
	printerr("[godot-mcp] op '" + _op + "' failed: " + message)
	print(PROTOCOL + JSON.stringify({"ok": false, "op": _op, "error": message}))
	quit(1)

# Handlers call this right after a block of req_*() calls to bail out cleanly.
func stop() -> bool:
	return _done

# --------------------------------------------------------------------------------------
# params helpers
# --------------------------------------------------------------------------------------

func opt_str(key: String, fallback := "") -> String:
	if not _params.has(key) or _params[key] == null:
		return fallback
	return str(_params[key]).strip_edges()

func req_str(key: String) -> String:
	if not _params.has(key) or _params[key] == null:
		return ""
	var v := str(_params[key]).strip_edges()
	if v.is_empty():
		finish_error("missing required parameter: " + key)
		return ""
	return v

func opt_int(key: String, fallback: int) -> int:
	if not _params.has(key) or _params[key] == null:
		return fallback
	return int(_params[key])

func opt_bool(key: String, fallback: bool) -> bool:
	if not _params.has(key) or _params[key] == null:
		return fallback
	return bool(_params[key])

func opt_dict(key: String) -> Dictionary:
	if not _params.has(key) or _params[key] == null:
		return {}
	if typeof(_params[key]) != TYPE_DICTIONARY:
		return {}
	return _params[key]

func opt_array(key: String) -> Array:
	if not _params.has(key) or _params[key] == null:
		return []
	if typeof(_params[key]) != TYPE_ARRAY:
		return []
	return _params[key]

# Validates the optional `project_path` parameter against the --path the process got.
# Relative / empty values are ignored (the server may omit it); an absolute path that
# disagrees with --path is a hard error so we never write into the wrong project.
func check_project_arg() -> void:
	var p := opt_str("project_path")
	if p.is_empty():
		return
	if not p.is_absolute_path():
		return
	var n := _norm_abs(p)
	if n != _root:
		finish_error("project_path mismatch: godot was started with --path '" + _root + "' but params.project_path is '" + n + "'")

# --------------------------------------------------------------------------------------
# generic helpers
# --------------------------------------------------------------------------------------

func _norm_abs(p: String) -> String:
	var s := p.strip_edges().replace("\\", "/")
	while s.length() > 1 and s.ends_with("/"):
		s = s.substr(0, s.length() - 1)
	# macOS /tmp and /var are symlinks to /private/*; normalize so both spellings match.
	if s.begins_with("/private/tmp/"):
		s = s.substr(8)
	elif s.begins_with("/private/var/"):
		s = s.substr(8)
	return s

func json_safe(value):
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT:
			return value
		TYPE_FLOAT:
			var f: float = value
			return f if is_finite(f) else str(f)
		TYPE_STRING:
			return value
		TYPE_STRING_NAME:
			return str(value)
		TYPE_ARRAY, TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, \
		TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY, \
		TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY:
			var out: Array = []
			for item in value:
				out.append(json_safe(item))
			return out
		TYPE_DICTIONARY:
			var dict: Dictionary = {}
			for k in value:
				dict[str(k)] = json_safe(value[k])
			return dict
		TYPE_OBJECT:
			var obj: Object = value
			if obj == null:
				return null
			if obj is Resource and not (obj as Resource).resource_path.is_empty():
				return (obj as Resource).resource_path
			return str(obj)
		_:
			return str(value)

# "res://a/b" | "a/b" | absolute path inside the project -> "res://a/b".
# Returns "" when an absolute path points outside the project or when ".." segments
# would escape the project root (res:// must never resolve outside the project).
func to_res(p: String) -> String:
	var s := p.strip_edges().replace("\\", "/")
	if s.begins_with("res://"):
		return _normalize_virtual(s, "res://")
	if s.begins_with("user://"):
		return _normalize_virtual(s, "user://")
	if s.is_absolute_path():
		var n := _norm_abs(s)
		if n == _root:
			return "res://"
		if n.begins_with(_root + "/"):
			return "res://" + n.substr(_root.length() + 1)
		return ""
	return _normalize_virtual("res://" + s.trim_prefix("./"), "res://")

func _normalize_virtual(path: String, scheme: String) -> String:
	var rest := path.substr(scheme.length())
	var stack: Array[String] = []
	for raw in rest.split("/", false):
		var segment := str(raw)
		if segment == ".":
			continue
		if segment == "..":
			if stack.is_empty():
				return ""  # would escape the project root: refuse
			stack.remove_at(stack.size() - 1)
			continue
		stack.append(segment)
	return scheme + "/".join(PackedStringArray(stack))

func res_to_abs(res_path: String) -> String:
	return ProjectSettings.globalize_path(res_path)

func _file_size(res_path: String) -> int:
	var f := FileAccess.open(res_path, FileAccess.READ)
	if f == null:
		return 0
	var size := f.get_length()
	f.close()
	return int(size)

func ensure_dir_for(res_file_path: String) -> bool:
	var dir_res := res_file_path.get_base_dir()
	if dir_res.is_empty() or dir_res == "res://":
		return true
	var abs_dir := res_to_abs(dir_res)
	if DirAccess.dir_exists_absolute(abs_dir):
		return true
	var err := DirAccess.make_dir_recursive_absolute(abs_dir)
	if err != OK:
		finish_error("cannot create directory '" + dir_res + "': " + error_string(err))
		return false
	return true

func load_scene_or_fail(scene_res: String) -> Node:
	if not FileAccess.file_exists(scene_res):
		finish_error("scene does not exist: " + scene_res + " (" + res_to_abs(scene_res) + ")")
		return null
	var packed := ResourceLoader.load(scene_res, "PackedScene", ResourceLoader.CACHE_MODE_REPLACE)
	if packed == null:
		finish_error("failed to load scene: " + scene_res)
		return null
	if not (packed is PackedScene):
		finish_error("not a PackedScene resource: " + scene_res + " (got " + packed.get_class() + ")")
		return null
	var root := (packed as PackedScene).instantiate()
	if root == null:
		finish_error("failed to instantiate scene: " + scene_res)
		return null
	return root

func save_scene_or_fail(node_root: Node, scene_res: String) -> bool:
	if not ensure_dir_for(scene_res):
		return false
	var packed := PackedScene.new()
	var pack_err := packed.pack(node_root)
	if pack_err != OK:
		finish_error("failed to pack scene: " + error_string(pack_err))
		return false
	var save_err := ResourceSaver.save(packed, scene_res)
	if save_err != OK:
		finish_error("failed to save scene '" + scene_res + "': " + error_string(save_err))
		return false
	# Signal connections survive because PackedScene.pack() serialises every connection
	# carrying Object.CONNECT_PERSIST: connections loaded from a .tscn have the flag
	# already, and connect_signal() sets it explicitly for new ones. Paths are rebuilt
	# from the live tree, so renames and removals stay consistent.
	return true

# Reads the persisted [connection ...] entries of a .tscn (verbatim lines).
func read_connection_lines(scene_res: String) -> Array:
	var out: Array = []
	if not FileAccess.file_exists(scene_res):
		return out
	for raw_line in FileAccess.get_file_as_string(scene_res).split("\n"):
		var line := str(raw_line).strip_edges()
		if line.begins_with("[connection "):
			out.append(line)
	return out

func _connection_fields(line: String) -> Dictionary:
	var re := RegEx.create_from_string('^\\[connection\\s+signal="([^"]*)"\\s+from="([^"]*)"\\s+to="([^"]*)"\\s+method="([^"]*)"(.*)\\]$')
	var m := re.search(line)
	if m == null:
		return {}
	return {"signal": m.get_string(1), "from": m.get_string(2), "to": m.get_string(3), "method": m.get_string(4), "rest": m.get_string(5)}

func all_nodes(root: Node, out: Array = []) -> Array:
	out.append(root)
	for child in root.get_children():
		all_nodes(child, out)
	return out

func count_scene_connections(scene_root: Node) -> int:
	var total := 0
	for node in all_nodes(scene_root):
		for info in node.get_signal_list():
			total += node.get_signal_connection_list(str(info.name)).size()
	return total

# Resolves a node path as described in the header comment.
func find_node(scene_root: Node, node_path: String) -> Node:
	var p := node_path.strip_edges()
	if p.is_empty() or p == "." or p == "/" or p == "root" or p == "/root":
		return scene_root
	if p.begins_with("/"):
		p = p.substr(1)
	var segments := p.split("/", false)
	if segments.size() > 0:
		if segments[0] == scene_root.name or segments[0] == "root":
			segments.remove_at(0)
	if segments.is_empty():
		return scene_root
	var rel := "/".join(PackedStringArray(segments))
	return scene_root.get_node_or_null(NodePath(rel))

func scene_path_of(scene_root: Node, node: Node) -> String:
	if node == scene_root:
		return String(scene_root.name)
	var parts: Array[String] = []
	var cursor: Node = node
	while cursor != null and cursor != scene_root:
		parts.push_front(String(cursor.name))
		cursor = cursor.get_parent()
	parts.push_front(String(scene_root.name))
	return "/".join(PackedStringArray(parts))

func instantiate_node_or_fail(node_type: String) -> Node:
	if node_type.is_empty():
		finish_error("node_type must not be empty")
		return null
	if ClassDB.class_exists(node_type):
		if not ClassDB.can_instantiate(node_type):
			finish_error("class exists but cannot be instantiated (abstract?): " + node_type)
			return null
		var obj = ClassDB.instantiate(node_type)
		if obj == null:
			finish_error("ClassDB.instantiate returned null for: " + node_type)
			return null
		if not (obj is Node):
			finish_error("class is not a Node: " + node_type + " (got " + (obj as Object).get_class() + ")")
			return null
		return obj
	# fall back to the project's global class registry (custom class_name scripts)
	for entry in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) == node_type:
			var script = load(str(entry.get("path", "")))
			if script == null:
				finish_error("failed to load script for global class: " + node_type)
				return null
			var inst = script.new()
			if inst == null or not (inst is Node):
				finish_error("global class is not an instantiable Node: " + node_type)
				return null
			return inst
	finish_error("unknown node type: " + node_type + " (not in ClassDB nor a registered class_name)")
	return null

func coerce_property_value(value):
	if typeof(value) != TYPE_STRING:
		return value
	var s: String = value
	if s.begins_with("res://") or s.begins_with("user://"):
		if ResourceLoader.exists(s):
			var res = load(s)
			if res != null:
				return res
		return s
	if RegEx.create_from_string(_TYPED_LITERAL_RE).search(s) != null:
		var parsed = str_to_var(s)
		if parsed != null:
			return parsed
	return s

func apply_properties(node: Node, props: Dictionary, changed: Array) -> void:
	for key in props:
		var prop := str(key)
		if prop.is_empty():
			continue
		# fail loudly instead of silently setting nothing
		var found := false
		for info in node.get_property_list():
			if str(info.name) == prop:
				found = true
				break
		if not found:
			finish_error("node '" + String(node.name) + "' (" + node.get_class() + ") has no property '" + prop + "'")
			return
		node.set(prop, coerce_property_value(props[key]))
		changed.append(prop)

func collect_files(base_res: String, recursive: bool, exts: Array, out: Array, depth := 0) -> void:
	if out.size() >= MAX_WALK_FILES or depth > MAX_WALK_DEPTH:
		return
	var dir := DirAccess.open(base_res)
	if dir == null:
		return
	dir.list_dir_begin()
	var name := dir.get_next()
	while name != "":
		if out.size() >= MAX_WALK_FILES:
			break
		if name.begins_with("."):
			name = dir.get_next()
			continue
		var child := base_res.path_join(name)
		if dir.current_is_dir():
			if recursive:
				collect_files(child, recursive, exts, out, depth + 1)
		else:
			var ext := name.get_extension().to_lower()
			if exts.is_empty() or exts.has(ext):
				out.append(child)
		name = dir.get_next()
	dir.list_dir_end()

# --------------------------------------------------------------------------------------
# nested process helper (timeout-bounded, captures stdout/stderr separately)
# --------------------------------------------------------------------------------------

# --------------------------------------------------------------------------------------
# nested process helper
#
# 嵌套 op（导入 / 导出 / run_project / deep parse_check / gdscript）需要再起一个 Godot，
# 并且要能「限时、分离 stdout/stderr、拿到真实退出码、可取消、不留残留进程」。
#
# 旧实现写一个 `#!/bin/sh` 脚本再 OS.execute 调 /bin/sh，脚本里用 sleep/kill/pkill
# 做看门狗 —— 原生 Windows 没有 /bin/sh，也没有 sleep/kill/pkill，这条路直接不可用。
#
# 现在的实现：**无 shell 的 Node 助手**（src/nested-helper.mjs）。
#   * 用 OS.create_process 启动，参数逐字传递；实测 OS.execute 会把实参交给 shell
#     （字面量 $HOME 会被展开），所以哪怕只是传路径也不走它；
#   * 嵌套命令与参数只写进 JSON 请求文件，命令行上只有「Node 绝对路径 + 助手路径 + 请求文件」；
#   * 助手内部 spawn(exe, args, shell:false, detached:false)：不经 shell；
#     Godot 启动助手会另建进程组，清理需覆盖完整后代树，不能只杀外层进程组；
#   * 助手自己限时并在超时时杀树，再写结果文件；外层只轮询结果文件，超时则按 pid 杀树兜底。
# --------------------------------------------------------------------------------------

## Node 绝对路径由 MCP server 每次注入，固定嵌套执行使用的版本与路径。
const HELPER_NODE_ENV := "GODOT_MCP_NODE"
## 助手脚本绝对路径（默认取仓库里的 src/nested-helper.mjs）。
const HELPER_PATH_ENV := "GODOT_MCP_HELPER"
## 结果文件轮询间隔与额外宽限：助手自己已经超时杀树，这里只等它把结果写完。
const CAPTURE_POLL_MS := 25
const CAPTURE_RESULT_MARGIN_MS := 20000

## 助手脚本可以落在哪些目录（按优先级）。
##
## 默认 `user://mcp_tmp`（Godot 用户数据目录），**不可写时退回系统临时目录** ——
## 沙箱化的 agent、只读 HOME、CI 容器里 user:// 都可能不可写；旧实现遇到这种情况
## 只回一句 "cannot create helper script <路径>"，于是 run_project 看起来像「游戏没输出」、
## import_assets 看起来像「导入了 0 个资源」、deep parse_check 看起来像「代码没问题」。
## 显式设置 GODOT_MCP_HELPER_DIR 时**只用它**（与 Godot 路径解析同样的严格语义）：
## 部署方可以指定目录，验收也能构造「谁都写不了」的失败路径。
func helper_dirs() -> Array:
	var explicit := OS.get_environment(HELPER_DIR_ENV).strip_edges()
	if not explicit.is_empty():
		return [explicit]
	var dirs: Array = [ProjectSettings.globalize_path(SH_TMP_RES)]
	var sys_tmp := OS.get_temp_dir()
	if not sys_tmp.is_empty():
		dirs.append(sys_tmp.path_join(SH_TMP_FALLBACK_DIR))
	return dirs

## 嵌套进程没跑起来时的统一说法：说清「跑了什么、为什么没跑成、怎么修」。
func spawn_error_message(run: Dictionary, what: String) -> String:
	return what + " 没能执行：" + str(run.get("error", "")) + "；" + str(run.get("hint", ""))

func _capture_spawn_error(reason: String, error: String, hint: String, tried: Array = []) -> Dictionary:
	var out := {
		"stdout": "", "stderr": "", "exit_code": -1, "duration_ms": 0,
		"timed_out": false, "spawn_error": true, "reason": reason,
		"error": error, "hint": hint,
	}
	if tried.size() > 0:
		out["tried"] = tried
	return out

## PATH 里的 node 名称：Windows 上真正可执行的是 node.exe。
func _node_names() -> Array:
	if OS.get_name() == "Windows":
		return ["node.exe", "node.cmd", "node.bat", "node"]
	return ["node"]

## 在 PATH 里找 node（退路；首选是 server 注入的 GODOT_MCP_NODE）。
func _which_node() -> String:
	var path_env := OS.get_environment("PATH")
	var sep := ";" if OS.get_name() == "Windows" else ":"
	for entry in path_env.split(sep, false):
		for name in _node_names():
			var candidate := str(entry).strip_edges().path_join(name)
			if FileAccess.file_exists(candidate):
				return candidate
	return ""

func resolve_node_exe() -> String:
	var explicit := OS.get_environment(HELPER_NODE_ENV).strip_edges()
	if not explicit.is_empty():
		# 显式指定是严格的：写了却不存在就直接报错，不悄悄换一个 Node。
		return explicit if FileAccess.file_exists(explicit) else ""
	return _which_node()

func _ops_script_dir() -> String:
	if _script_file.is_empty():
		return ""
	return _script_file.get_base_dir()

## 判定「嵌套 --check-only 是否可信地跑完」的逻辑单独放在同目录的 check_verdict.gd：
## 它既被这里调用，也能用 `godot --headless --script check_verdict.gd` 跑判定表自测。
func verdict_script() -> GDScript:
	if _verdict_script == null and not _script_file.is_empty():
		var candidate := _script_file.get_base_dir().path_join("check_verdict.gd")
		if FileAccess.file_exists(candidate):
			_verdict_script = load(candidate)
	return _verdict_script

func resolve_helper_script() -> String:
	var explicit := OS.get_environment(HELPER_PATH_ENV).strip_edges()
	if not explicit.is_empty():
		return explicit if FileAccess.file_exists(explicit) else ""
	var here := _ops_script_dir()
	if here.is_empty():
		return ""
	var candidate := here.path_join("..").path_join("src").path_join("nested-helper.mjs").simplify_path()
	return candidate if FileAccess.file_exists(candidate) else ""

## 本次调用的唯一临时产物集合；写不进去就换下一个候选目录。
func _prepare_capture_files() -> Dictionary:
	if not _rng_seeded:
		randomize()
		_rng_seeded = true
	# 唯一性 = 微秒时间戳 + 进程 id + 随机后缀：同一进程内并发/重入也不会撞名
	var stamp := str(Time.get_ticks_usec()) + "-" + str(OS.get_process_id()) + "-" + str(randi() % 1000000)
	var tried: Array = []
	for dir in helper_dirs():
		var dir_s := str(dir)
		DirAccess.make_dir_recursive_absolute(dir_s)
		if not DirAccess.dir_exists_absolute(dir_s):
			tried.append({"dir": dir_s, "error": "cannot create directory"})
			continue
		var files := {
			"dir": dir_s,
			"req": dir_s.path_join("capture_" + stamp + ".json"),
			"out": dir_s.path_join("out_" + stamp + ".txt"),
			"err": dir_s.path_join("err_" + stamp + ".txt"),
			"result": dir_s.path_join("result_" + stamp + ".json"),
			"status": dir_s.path_join("status_" + stamp + ".json"),
		}
		var probe := FileAccess.open(str(files["req"]), FileAccess.WRITE)
		if probe == null:
			tried.append({"dir": dir_s, "error": error_string(FileAccess.get_open_error())})
			continue
		probe.close()
		files["tried"] = tried
		return files
	return {"error": true, "tried": tried}

## 清理本次调用的临时产物；Windows 上文件可能被还没退出的进程占着，所以要有限重试。
## 返回删不掉的文件列表（调用方如实上报，而不是假装干净）。
func _remove_capture_files(files: Dictionary) -> Array:
	var failed: Array = []
	for key in ["req", "out", "err", "result", "status"]:
		if not files.has(key):
			continue
		# 结果文件是「先写 <name>.tmp 再 rename」的原子写：硬杀时 .tmp 会留下，
		# 所以清理必须把 .tmp 兄弟文件一起收掉（否则每次异常都在临时目录里攒垃圾）。
		for path in [str(files[key]), str(files[key]) + ".tmp"]:
			if not FileAccess.file_exists(path):
				continue
			for attempt in range(5):
				if DirAccess.remove_absolute(path) == OK:
					break
				OS.delay_msec(100)
			if FileAccess.file_exists(path):
				failed.append(path)
	return failed

## 等待若干 pid 真的退出（有界）。返回 {alive, waited_ms}。
## 只在 Windows 与 Unix 上可用（OS.is_process_running 的平台限制）；
## 它在本进程不是父进程时会打一行引擎错误 —— 那行正好说明「已经退出了」，可接受。
func _wait_processes_exit(pids: Array, timeout_ms: int) -> Dictionary:
	var wanted: Array = []
	for pid in pids:
		if int(pid) > 0:
			wanted.append(int(pid))
	if wanted.is_empty():
		return {"alive": [], "waited_ms": 0}
	var started := Time.get_ticks_msec()
	var alive: Array = []
	while true:
		alive = []
		for pid in wanted:
			if OS.is_process_running(pid):
				alive.append(pid)
		if alive.is_empty() or Time.get_ticks_msec() - started >= timeout_ms:
			break
		OS.delay_msec(50)
	return {"alive": alive, "waited_ms": Time.get_ticks_msec() - started}

func _run_windows_taskkill(pid: int) -> bool:
	var root := OS.get_environment("SystemRoot").strip_edges()
	if root.is_empty():
		root = "C:\\Windows"
	var taskkill := root.path_join("System32").path_join("taskkill.exe")
	if not FileAccess.file_exists(taskkill):
		return false
	var kill_args := PackedStringArray()
	kill_args.append("/PID")
	kill_args.append(str(pid))
	kill_args.append("/T")
	kill_args.append("/F")
	return OS.create_process(taskkill, kill_args, false) > 0

## 用 Node 助手做「杀树」（无 shell）：先按 pid 快照整棵子树，再逐个回收并确认。
##
## 为什么需要它：Godot 给 OS.create_process 起的进程**新建进程组**，POSIX 上
## `OS.kill(child)` 只杀一个 pid，孙进程会漏；而进程组又覆盖不到（组不同）。
## Node 侧用 ps 快照父子关系，是这里唯一可靠的整树回收方式。
func _run_node_kill_mode(roots: Array, timeout_ms: int) -> Dictionary:
	var node := resolve_node_exe()
	var helper := resolve_helper_script()
	if node.is_empty() or helper.is_empty():
		return {"ok": false, "error": "node 或 helper 不可用，无法整树回收"}
	var files := _prepare_capture_files()
	if files.get("error", false) == true:
		return {"ok": false, "error": "没有可写的助手目录", "tried": files.get("tried", [])}
	var wanted: Array = []
	for pid in roots:
		if int(pid) > 0:
			wanted.append(int(pid))
	var request := {"roots": wanted, "timeoutMs": timeout_ms, "resultPath": str(files["result"])}
	var handle := FileAccess.open(str(files["req"]), FileAccess.WRITE)
	if handle == null:
		_remove_capture_files(files)
		return {"ok": false, "error": "写不进 kill 请求文件"}
	handle.store_string(JSON.stringify(request))
	handle.close()
	var kill_pid := OS.create_process(node, PackedStringArray([helper, "--kill", str(files["req"])]), false)
	if kill_pid <= 0:
		_remove_capture_files(files)
		return {"ok": false, "error": "启动 Node 杀树助手失败"}
	var deadline := Time.get_ticks_msec() + timeout_ms + 5000
	while not FileAccess.file_exists(str(files["result"])) and Time.get_ticks_msec() < deadline:
		OS.delay_msec(CAPTURE_POLL_MS)
	var out := {"ok": false, "error": "Node 杀树助手超时未返回结果", "killer_pid": kill_pid}
	if FileAccess.file_exists(str(files["result"])):
		var parsed = JSON.parse_string(FileAccess.get_file_as_string(str(files["result"])))
		if typeof(parsed) == TYPE_DICTIONARY:
			out = parsed
		else:
			out = {"ok": false, "error": "杀树结果不是合法 JSON", "killer_pid": kill_pid}
	_remove_capture_files(files)
	out["killer_pid"] = kill_pid
	return out

## 外层兜底：助手卡住时按 pid 杀树，并**有界等待确认**（不是发完就当成功）。
##
## Windows：必须在根进程还活着时用 taskkill 的树模式（父子关系是现场枚举的）；
##   若助手已经退出，就改为对**嵌套子进程**做树杀（它自己还有后代）。
## POSIX：交给 Node 杀树助手（见上），不再用 OS.kill 逐个 pid 了事。
## 返回 {ok, method, helper_pid, child_pid, helper_exited, alive, waited_ms, attempts, ...}：
## ok=false 且 alive 非空意味着**确实有残留**，调用方必须如实上报。
func _kill_capture_tree(helper_pid: int, status_path: String) -> Dictionary:
	var child_pid := 0
	if FileAccess.file_exists(status_path):
		var status = JSON.parse_string(FileAccess.get_file_as_string(status_path))
		if typeof(status) == TYPE_DICTIONARY:
			child_pid = int(status.get("pid", 0))
	var helper_exited := helper_pid > 0 and not OS.is_process_running(helper_pid)
	var method := ""
	var attempts := 0
	var waited := {"alive": [], "waited_ms": 0}
	var kill_mode := {}
	if OS.get_name() == "Windows":
		method = "taskkill-tree"
		# 根进程必须还活着才能按关系枚举后代：优先助手，助手已退出就退回嵌套子进程
		var root := helper_pid
		if helper_exited:
			root = child_pid
		if root > 0 and _run_windows_taskkill(root):
			attempts += 1
		waited = _wait_processes_exit([helper_pid, child_pid], 8000)
		if not (waited["alive"] as Array).is_empty():
			# 有限重试一次：taskkill 偶尔会因为句柄/时序没杀干净
			if root > 0 and _run_windows_taskkill(root):
				attempts += 1
			waited = _wait_processes_exit([helper_pid, child_pid], 4000)
	else:
		method = "node-kill-mode"
		kill_mode = _run_node_kill_mode([helper_pid, child_pid], 8000)
		attempts += 1
		waited = _wait_processes_exit([helper_pid, child_pid], 4000)
	var alive: Array = waited["alive"]
	return {
		"ok": alive.is_empty(),
		"method": method,
		"helper_pid": helper_pid,
		"child_pid": child_pid,
		"helper_exited": helper_exited,
		"alive": alive,
		"waited_ms": waited["waited_ms"],
		"attempts": attempts,
		"kill_mode": kill_mode,
	}

## 执行嵌套命令并收集输出。
## 返回的字段与旧实现保持兼容：stdout / stderr / exit_code / duration_ms / timed_out /
## spawn_error / reason / error / hint / helper_dir，另加 killed / still_running / orphaned / signal。
func run_capture(parts: Array, timeout_sec: float) -> Dictionary:
	if parts.is_empty():
		return _capture_spawn_error("empty_command", "嵌套执行的命令为空", "")
	var node := resolve_node_exe()
	if node.is_empty():
		return _capture_spawn_error(
			"node_not_found",
			"找不到 Node 可执行文件（嵌套执行需要它）",
			"MCP server 每次调用都会注入 " + HELPER_NODE_ENV + "=Node 的绝对路径；" +
			"手动跑 ops.gd 时请自行设置该变量，或把 node 放进 PATH（需要 Node 20+）。")
	var helper := resolve_helper_script()
	if helper.is_empty():
		return _capture_spawn_error(
			"helper_missing",
			"找不到嵌套执行助手脚本（src/nested-helper.mjs）",
			"默认按 ops.gd 所在仓库定位；也可以用 " + HELPER_PATH_ENV + " 显式指定绝对路径。")

	var files := _prepare_capture_files()
	if files.get("error", false) == true:
		var tried: Array = files.get("tried", [])
		return _capture_spawn_error(
			"helper_script_unwritable",
			"连一个可写的助手目录都没有",
			"逐个检查权限（沙箱/只读 HOME/CI 容器会让 user:// 不可写）：" + JSON.stringify(tried) +
			"；也可以用 " + HELPER_DIR_ENV + " 显式指向一个可写目录。",
			tried)

	var args := []
	for i in range(1, parts.size()):
		args.append(str(parts[i]))
	var timeout_int := int(max(1.0, ceil(timeout_sec)))
	var request := {
		"exe": str(parts[0]),
		"args": args,
		"cwd": _root,
		"timeoutMs": timeout_int * 1000,
		"outPath": str(files["out"]),
		"errPath": str(files["err"]),
		"resultPath": str(files["result"]),
		"statusPath": str(files["status"]),
	}
	var handle := FileAccess.open(str(files["req"]), FileAccess.WRITE)
	if handle == null:
		_remove_capture_files(files)
		return _capture_spawn_error("helper_request_unwritable", "写不进请求文件 " + str(files["req"]), error_string(FileAccess.get_open_error()))
	handle.store_string(JSON.stringify(request))
	handle.close()

	var started := Time.get_ticks_msec()
	var helper_pid := OS.create_process(node, PackedStringArray([helper, str(files["req"])]), false)
	if helper_pid <= 0:
		_remove_capture_files(files)
		return _capture_spawn_error("helper_spawn_failed", "启动 Node 助手失败：" + node, "检查 node 是否可执行、请求文件是否可读。")

	# 等结果文件：助手自己会在 timeoutMs 后杀树并写结果，这里多给一段余量。
	var deadline := started + timeout_int * 1000 + CAPTURE_RESULT_MARGIN_MS
	while not FileAccess.file_exists(str(files["result"])) and Time.get_ticks_msec() < deadline:
		OS.delay_msec(CAPTURE_POLL_MS)

	var stdout := ""
	var stderr := ""
	if FileAccess.file_exists(str(files["out"])):
		stdout = FileAccess.get_file_as_string(str(files["out"]))
	if FileAccess.file_exists(str(files["err"])):
		stderr = FileAccess.get_file_as_string(str(files["err"]))

	if not FileAccess.file_exists(str(files["result"])):
		# 助手没能在期限内写出结果：按 pid **有界**杀树，并如实报告「输出可能不完整、
		# 是否还有残留、哪些临时文件没清掉」。发完信号就宣布成功是这里最容易犯的错。
		var kill := _kill_capture_tree(helper_pid, str(files["status"]))
		var leftover := _remove_capture_files(files)
		var killed: Dictionary = {
			"stdout": stdout, "stderr": stderr, "exit_code": 137,
			"duration_ms": Time.get_ticks_msec() - started,
			"timed_out": true, "spawn_error": false, "reason": "helper_timeout",
			"helper_dir": str(files["dir"]), "helper_pid": helper_pid,
			"tree_kill": kill, "still_running": not bool(kill["ok"]),
			"error": "Node 助手超时未返回结果（已按 pid 杀树）",
			"hint": "如果反复出现，检查 " + HELPER_DIR_ENV + " 指向的目录是否可写、磁盘是否已满。",
		}
		if not leftover.is_empty():
			killed["leftover_files"] = leftover
		return killed

	# 结果文件已经落盘，但助手可能还没退出（它写完结果才 exit）。Windows 上文件句柄
	# 还没释放时删除会失败，所以先有界等它退出，再带重试地清理临时产物。
	var helper_exit := _wait_processes_exit([helper_pid], 5000)
	var raw := FileAccess.get_file_as_string(str(files["result"]))
	var leftover := _remove_capture_files(files)
	var parsed = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		return _capture_spawn_error(
			"helper_result_unreadable",
			"助手结果文件不是合法 JSON：" + raw.substr(0, 300),
			"结果文件已删除；重跑一次可确认是否偶发。")

	var duration_ms := int(parsed.get("durationMs", Time.get_ticks_msec() - started))
	if bool(parsed.get("spawnError", false)):
		var out := _capture_spawn_error(
			"exe_spawn_failed",
			"嵌套命令没能启动：" + str(parsed.get("error", "")),
			"检查可执行文件路径与权限：" + str(parts[0]))
		out["stderr"] = stderr
		out["stdout"] = stdout
		return out

	var exit_code := 137
	if parsed.get("exitCode") != null:
		exit_code = int(parsed["exitCode"])
	var timed_out := bool(parsed.get("timedOut", false))
	if timed_out:
		# 与旧实现一致：看门狗超时统一以 137 上报，Node 层据此判「被超时终止」。
		exit_code = 137
	var out := {
		"stdout": stdout,
		"stderr": stderr,
		"exit_code": exit_code,
		"duration_ms": duration_ms,
		"timed_out": timed_out,
		"spawn_error": false,
		"signal": parsed.get("signal", null),
		"helper_dir": str(files["dir"]),
		"helper_pid": helper_pid,
		"helper_exited": (helper_exit["alive"] as Array).is_empty(),
		"killed": bool(parsed.get("killed", false)),
		"still_running": bool(parsed.get("stillRunning", false)),
		"orphaned": bool(parsed.get("orphaned", false)),
	}
	# GDScript 的字典字面量没有展开语法，只能事后补键
	if not leftover.is_empty():
		out["leftover_files"] = leftover
	return out

func godot_exe() -> String:
	return OS.get_executable_path()

# --------------------------------------------------------------------------------------
# ops: introspection / project
# --------------------------------------------------------------------------------------

func _op_version() -> void:
	var v := Engine.get_version_info()
	finish({
		"version": "%d.%d.%d" % [int(v.get("major", 0)), int(v.get("minor", 0)), int(v.get("patch", 0))],
		"hash": str(v.get("hash", "")),
		"string": str(v.get("string", "")),
		"status": str(v.get("status", "")),
		"build": str(v.get("build", "")),
	})

func read_project_godot(root: String) -> Dictionary:
	var out: Dictionary = {}
	var cfg := ConfigFile.new()
	if cfg.load(root.path_join("project.godot")) != OK:
		return out
	for section in cfg.get_sections():
		for key in cfg.get_section_keys(section):
			var flat_key := str(key) if str(section).is_empty() else str(section) + "/" + str(key)
			out[flat_key] = json_safe(cfg.get_value(section, key))
	return out

func _op_project_info() -> void:
	check_project_arg()
	if stop():
		return
	var v := Engine.get_version_info()
	finish({
		"name": str(ProjectSettings.get_setting("application/config/name", "")),
		"path": _root,
		"main_scene": str(ProjectSettings.get_setting("application/run/main_scene", "")),
		"settings": read_project_godot(_root),
		"godot_version": str(v.get("string", "")),
	})

func _op_create_project() -> void:
	var raw := opt_str("project_path")
	if raw.is_empty():
		finish_error("missing required parameter: project_path")
		return
	var target := _norm_abs(raw)
	if not target.is_absolute_path():
		finish_error("project_path must be an absolute filesystem path, got: " + raw)
		return
	var name := opt_str("name")
	if name.is_empty():
		name = target.get_file()
	if name.is_empty():
		finish_error("cannot derive a project name; pass 'name'")
		return

	var renderer := opt_str("renderer", "forward_plus")
	var method := "forward_plus"
	match renderer:
		"forward_plus", "forward+":
			method = "forward_plus"
		"mobile":
			method = "mobile"
		"gl_compatibility", "compatibility", "gl":
			method = "gl_compatibility"
		_:
			finish_error("invalid renderer: '" + renderer + "' (expected forward_plus | mobile | gl_compatibility)")
			return

	if not DirAccess.dir_exists_absolute(target):
		var mk := DirAccess.make_dir_recursive_absolute(target)
		if mk != OK:
			finish_error("cannot create project directory '" + target + "': " + error_string(mk))
			return

	var godot_file := target.path_join("project.godot")
	if FileAccess.file_exists(godot_file):
		finish_error("a Godot project already exists at " + godot_file)
		return

	var body := ""
	body += "; Engine configuration file.\n"
	body += "; Generated by godot-mcp (godot/ops.gd, op=create_project).\n"
	body += "\n"
	body += "config_version=5\n"
	body += "\n"
	body += "[application]\n"
	body += "\n"
	body += 'config/name="' + name.replace('"', '\\"') + '"\n'
	body += "config/features=PackedStringArray(\"4.7\", \"" + method + "\")\n"
	body += "\n"
	body += "[rendering]\n"
	body += "\n"
	body += 'renderer/rendering_method="' + method + '"\n'
	body += 'renderer/rendering_method.mobile="' + method + '"\n'

	var f := FileAccess.open(godot_file, FileAccess.WRITE)
	if f == null:
		finish_error("cannot write " + godot_file + ": " + error_string(FileAccess.get_open_error()))
		return
	f.store_string(body)
	f.close()
	if not FileAccess.file_exists(godot_file):
		finish_error("project.godot was not created at " + godot_file)
		return
	finish({"created": true, "path": target, "renderer": method})

# --------------------------------------------------------------------------------------
# ops: scenes
# --------------------------------------------------------------------------------------

func _op_list_scenes() -> void:
	check_project_arg()
	if stop():
		return
	var pattern := opt_str("pattern")
	var found: Array = []
	collect_files("res://", true, ["tscn", "scn"], found)
	var scenes: Array = []
	for p in found:
		var sp := str(p)
		if not pattern.is_empty():
			if not (sp.match(pattern) or sp.get_file().match(pattern) or sp.contains(pattern)):
				continue
		scenes.append({"path": sp, "name": sp.get_file().get_basename()})
	scenes.sort_custom(func(a, b): return str(a["path"]) < str(b["path"]))
	finish({"scenes": scenes, "total": scenes.size()})

func _op_create_scene() -> void:
	check_project_arg()
	if stop():
		return
	var scene_arg := req_str("scene_path")
	var root_type := opt_str("root_type", "Node2D")
	var root_name := opt_str("root_name", "root")
	if stop():
		return

	var scene_res := to_res(scene_arg)
	if scene_res.is_empty() or not scene_res.begins_with("res://"):
		finish_error("scene_path must live inside the project: " + scene_arg)
		return
	if scene_res.get_extension().to_lower() not in ["tscn", "scn"]:
		finish_error("scene_path must end in .tscn or .scn: " + scene_res)
		return

	var overwritten := FileAccess.file_exists(scene_res)
	var node := instantiate_node_or_fail(root_type)
	if stop() or node == null:
		return
	node.name = root_name
	# NOTE: the scene root must NOT get an owner -- `set_owner(self)` triggers
	# "Condition p_owner == this is true" in Godot 4.7 and owner only matters for
	# children that should be serialized into the packed scene.
	if not save_scene_or_fail(node, scene_res):
		return
	node.free()
	finish({"scene_path": scene_res, "overwritten": overwritten, "root_type": root_type, "root_name": root_name})

func _op_read_scene() -> void:
	check_project_arg()
	if stop():
		return
	var scene_arg := req_str("scene_path")
	if stop():
		return
	var max_depth := opt_int("max_depth", DEFAULT_MAX_DEPTH)
	var scene_res := to_res(scene_arg)
	if scene_res.is_empty():
		finish_error("scene_path is outside the project: " + scene_arg)
		return
	var root := load_scene_or_fail(scene_res)
	if stop() or root == null:
		return
	var tree := describe_node(root, root, max_depth, 0)
	var count := count_nodes(root)
	root.free()
	finish({
		"tree": tree,
		"scene_path": scene_res,
		"node_count": count,
		"max_depth": max_depth,
		"connections": connection_lines_as_data(read_connection_lines(scene_res)),
	})

func connection_lines_as_data(lines: Array) -> Array:
	var out: Array = []
	for line in lines:
		var f := _connection_fields(str(line))
		if f.is_empty():
			out.append({"raw": str(line)})
			continue
		out.append({"from": str(f["from"]), "signal": str(f["signal"]), "to": str(f["to"]), "method": str(f["method"]), "raw": str(line)})
	return out

func describe_node(node: Node, scene_root: Node, max_depth: int, depth: int) -> Dictionary:
	var props := node_properties(node)
	var children: Array = []
	var limitize := max_depth > 0
	if not limitize or depth < max_depth:
		for child in node.get_children():
			children.append(describe_node(child, scene_root, max_depth, depth + 1))
	return {
		"name": String(node.name),
		"type": node.get_class(),
		"path": scene_path_of(scene_root, node),
		"properties": props,
		"children": children,
	}

func count_nodes(node: Node) -> int:
	var n := 1
	for child in node.get_children():
		n += count_nodes(child)
	return n

# Returns the properties that differ from a freshly constructed default instance of the
# same class -- i.e. what a .tscn actually stores, minus the noise.
func node_properties(node: Node) -> Dictionary:
	var out: Dictionary = {}
	var default_obj: Object = null
	var cls := node.get_class()
	if ClassDB.class_exists(cls) and ClassDB.can_instantiate(cls):
		default_obj = ClassDB.instantiate(cls)

	var script: Script = node.get_script() as Script
	if script != null:
		var sp: String = script.resource_path
		out["script"] = sp if not sp.is_empty() else "<runtime script>"

	for info in node.get_property_list():
		if out.size() >= MAX_PROPERTIES_PER_NODE:
			out["__truncated"] = true
			break
		var usage: int = int(info.usage)
		if not (usage & PROPERTY_USAGE_STORAGE):
			continue
		if usage & PROPERTY_USAGE_CATEGORY or usage & PROPERTY_USAGE_GROUP:
			continue
		var prop := str(info.name)
		if prop.is_empty() or prop.begins_with("_") or prop == "script" or prop == "owner":
			continue
		var value = node.get(prop)
		if default_obj != null:
			var default_value = default_obj.get(prop)
			if _same_value(value, default_value):
				continue
		out[prop] = json_safe(value)

	if default_obj != null and not (default_obj is RefCounted):
		default_obj.free()
	return out

func _same_value(a, b) -> bool:
	if typeof(a) != typeof(b):
		return false
	match typeof(a):
		TYPE_NIL:
			return true
		TYPE_OBJECT:
			return a == b
		TYPE_DICTIONARY, TYPE_ARRAY:
			return a == b
		_:
			return a == b

func _op_add_node() -> void:
	check_project_arg()
	if stop():
		return
	var scene_arg := req_str("scene_path")
	var node_type := req_str("node_type")
	var node_name := req_str("node_name")
	if stop():
		return
	var parent_arg := opt_str("parent_node_path")
	var props := opt_dict("properties")

	var scene_res := to_res(scene_arg)
	if scene_res.is_empty():
		finish_error("scene_path is outside the project: " + scene_arg)
		return
	var scene_root := load_scene_or_fail(scene_res)
	if stop() or scene_root == null:
		return
	var parent := find_node(scene_root, parent_arg)
	if parent == null:
		finish_error("parent node not found: '" + parent_arg + "'")
		return
	if parent.get_node_or_null(NodePath(node_name)) != null or scene_root.find_child(node_name, true, false) != null:
		scene_root.free()
		finish_error("a node named '" + node_name + "' already exists in " + scene_res)
		return

	var new_node := instantiate_node_or_fail(node_type)
	if stop() or new_node == null:
		scene_root.free()
		return
	new_node.name = node_name
	if not props.is_empty():
		var changed: Array = []
		apply_properties(new_node, props, changed)
		if stop():
			scene_root.free()
			return
	parent.add_child(new_node)
	new_node.owner = scene_root
	if not save_scene_or_fail(scene_root, scene_res):
		scene_root.free()
		return
	var result_path := scene_path_of(scene_root, new_node)
	var parent_path := scene_path_of(scene_root, parent)
	scene_root.free()
	finish({"node_path": result_path, "scene_path": scene_res, "parent": parent_path})

func _op_modify_node() -> void:
	check_project_arg()
	if stop():
		return
	var scene_arg := req_str("scene_path")
	var node_arg := req_str("node_path")
	if stop():
		return
	var props := opt_dict("properties")
	var new_name := opt_str("new_name")
	if props.is_empty() and new_name.is_empty():
		finish_error("nothing to do: pass 'properties' and/or 'new_name'")
		return

	var scene_res := to_res(scene_arg)
	if scene_res.is_empty():
		finish_error("scene_path is outside the project: " + scene_arg)
		return
	var scene_root := load_scene_or_fail(scene_res)
	if stop() or scene_root == null:
		return
	var node := find_node(scene_root, node_arg)
	if node == null:
		scene_root.free()
		finish_error("node not found: '" + node_arg + "' in " + scene_res)
		return

	var changed: Array = []
	if not props.is_empty():
		apply_properties(node, props, changed)
		if stop():
			scene_root.free()
			return
	if not new_name.is_empty():
		node.name = new_name
		changed.append("name")
	if not save_scene_or_fail(scene_root, scene_res):
		scene_root.free()
		return
	var result_path := scene_path_of(scene_root, node)
	scene_root.free()
	finish({"node_path": result_path, "changed": changed, "scene_path": scene_res})

func _op_remove_node() -> void:
	check_project_arg()
	if stop():
		return
	var scene_arg := req_str("scene_path")
	var node_arg := req_str("node_path")
	if stop():
		return
	var scene_res := to_res(scene_arg)
	if scene_res.is_empty():
		finish_error("scene_path is outside the project: " + scene_arg)
		return
	var scene_root := load_scene_or_fail(scene_res)
	if stop() or scene_root == null:
		return
	var node := find_node(scene_root, node_arg)
	if node == null:
		scene_root.free()
		finish_error("node not found: '" + node_arg + "' in " + scene_res)
		return
	if node == scene_root:
		scene_root.free()
		finish_error("refusing to remove the scene root node ('" + node_arg + "'); delete the scene file instead")
		return
	var parent := node.get_parent()
	var removed_path := scene_path_of(scene_root, node)
	var before_connections := count_scene_connections(scene_root)
	parent.remove_child(node)
	node.free()
	var dropped := before_connections - count_scene_connections(scene_root)
	if not save_scene_or_fail(scene_root, scene_res):
		scene_root.free()
		return
	scene_root.free()
	finish({"removed": true, "node_path": removed_path, "scene_path": scene_res, "connections_dropped": dropped})

func _op_instantiate_scene() -> void:
	check_project_arg()
	if stop():
		return
	var scene_arg := req_str("scene_path")
	var instance_arg := req_str("instance_path")
	var parent_arg := opt_str("parent_node_path")
	var node_name := opt_str("node_name")
	if stop():
		return

	var scene_res := to_res(scene_arg)
	var instance_res := to_res(instance_arg)
	if scene_res.is_empty() or instance_res.is_empty():
		finish_error("scene_path/instance_path must live inside the project")
		return
	if instance_res == scene_res:
		finish_error("cannot instantiate a scene inside itself: " + scene_res)
		return

	var scene_root := load_scene_or_fail(scene_res)
	if stop() or scene_root == null:
		return
	var parent := find_node(scene_root, parent_arg)
	if parent == null:
		scene_root.free()
		finish_error("parent node not found: '" + parent_arg + "'")
		return
	if not FileAccess.file_exists(instance_res):
		scene_root.free()
		finish_error("instance scene does not exist: " + instance_res)
		return
	var packed := ResourceLoader.load(instance_res, "PackedScene", ResourceLoader.CACHE_MODE_REPLACE)
	if packed == null or not (packed is PackedScene):
		scene_root.free()
		finish_error("not a loadable PackedScene: " + instance_res)
		return
	var inst: Node = (packed as PackedScene).instantiate()
	if inst == null:
		scene_root.free()
		finish_error("failed to instantiate: " + instance_res)
		return
	if not node_name.is_empty():
		inst.name = node_name
	if parent.get_node_or_null(NodePath(String(inst.name))) != null:
		var taken := String(inst.name)
		scene_root.free()
		inst.free()
		finish_error("parent already has a child named '" + taken + "'")
		return
	parent.add_child(inst)
	inst.owner = scene_root
	if not save_scene_or_fail(scene_root, scene_res):
		scene_root.free()
		return
	var result_path := scene_path_of(scene_root, inst)
	scene_root.free()
	finish({"node_path": result_path, "scene_path": scene_res, "instance_path": instance_res})

func _op_attach_script() -> void:
	check_project_arg()
	if stop():
		return
	var scene_arg := req_str("scene_path")
	var node_arg := req_str("node_path")
	var script_arg := req_str("script_path")
	if stop():
		return
	var scene_res := to_res(scene_arg)
	var script_res := to_res(script_arg)
	if scene_res.is_empty() or script_res.is_empty():
		finish_error("scene_path/script_path must live inside the project")
		return
	if not FileAccess.file_exists(script_res):
		finish_error("script does not exist: " + script_res)
		return
	var script = ResourceLoader.load(script_res, "Script", ResourceLoader.CACHE_MODE_REPLACE)
	if script == null or not (script is Script):
		finish_error("not a loadable Script resource: " + script_res)
		return

	var scene_root := load_scene_or_fail(scene_res)
	if stop() or scene_root == null:
		return
	var node := find_node(scene_root, node_arg)
	if node == null:
		scene_root.free()
		finish_error("node not found: '" + node_arg + "' in " + scene_res)
		return
	node.set_script(script)
	if node.get_script() != script:
		# build the message before releasing the nodes: touching a freed Node is fatal
		var rejected := "script was rejected by node '" + String(node.name) + "' (" + node.get_class() + "); the script probably does not extend a compatible base class"
		scene_root.free()
		finish_error(rejected)
		return
	if not save_scene_or_fail(scene_root, scene_res):
		scene_root.free()
		return
	scene_root.free()
	finish({"node_path": node_arg, "script": script_res, "scene_path": scene_res})

func _op_connect_signal() -> void:
	check_project_arg()
	if stop():
		return
	var scene_arg := req_str("scene_path")
	var from_arg := req_str("from_node")
	var signal_name := req_str("signal")
	var to_arg := req_str("to_node")
	var method := req_str("method")
	if stop():
		return
	var binds := opt_array("binds")

	var scene_res := to_res(scene_arg)
	if scene_res.is_empty():
		finish_error("scene_path is outside the project: " + scene_arg)
		return
	var scene_root := load_scene_or_fail(scene_res)
	if stop() or scene_root == null:
		return
	var from_node := find_node(scene_root, from_arg)
	var to_node := find_node(scene_root, to_arg)
	if from_node == null:
		scene_root.free()
		finish_error("from_node not found: '" + from_arg + "'")
		return
	if to_node == null:
		scene_root.free()
		finish_error("to_node not found: '" + to_arg + "'")
		return
	if not from_node.has_signal(signal_name):
		var from_desc := "node '" + scene_path_of(scene_root, from_node) + "' (" + from_node.get_class() + ") has no signal '" + signal_name + "'"
		scene_root.free()
		finish_error(from_desc)
		return
	if not to_node.has_method(method):
		var to_desc := "node '" + scene_path_of(scene_root, to_node) + "' (" + to_node.get_class() + ") has no method '" + method + "'"
		scene_root.free()
		finish_error(to_desc)
		return

	var callable := Callable(to_node, method)
	if binds.size() > 0:
		callable = callable.bindv(binds)
	if from_node.is_connected(signal_name, callable):
		scene_root.free()
		finish_error("signal '" + signal_name + "' is already connected to " + method)
		return
	# CONNECT_PERSIST is what makes PackedScene.pack() write the [connection] entry;
	# without it Godot 4.7 silently drops the connection when the scene is saved.
	var err := from_node.connect(signal_name, callable, Object.CONNECT_PERSIST)
	if err != OK:
		scene_root.free()
		finish_error("connect failed: " + error_string(err))
		return
	if not save_scene_or_fail(scene_root, scene_res):
		scene_root.free()
		return
	scene_root.free()
	finish({
		"connected": true,
		"scene_path": scene_res,
		"from": from_arg,
		"signal": signal_name,
		"to": to_arg,
		"method": method,
		"binds": binds,
	})

# --------------------------------------------------------------------------------------
# ops: settings
# --------------------------------------------------------------------------------------

func _op_read_settings() -> void:
	check_project_arg()
	if stop():
		return
	if not _params.has("keys") or _params["keys"] == null:
		finish({"settings": read_project_godot(_root), "source": "project.godot"})
		return
	var keys := opt_array("keys")
	if keys.is_empty():
		finish_error("'keys' was provided but is not a non-empty array")
		return
	var out: Dictionary = {}
	var missing: Array = []
	for k in keys:
		var key := str(k)
		if ProjectSettings.has_setting(key):
			out[key] = json_safe(ProjectSettings.get_setting(key))
		else:
			missing.append(key)
	finish({"settings": out, "missing": missing, "source": "ProjectSettings"})

func flatten_settings(src: Dictionary, prefix := "") -> Dictionary:
	var out: Dictionary = {}
	for k in src:
		var key := str(k)
		if key.is_empty():
			continue
		var full := key if prefix.is_empty() else prefix + "/" + key
		if typeof(src[k]) == TYPE_DICTIONARY:
			for sub in flatten_settings(src[k], full):
				out[sub] = flatten_settings(src[k], full)[sub]
		else:
			out[full] = src[k]
	return out

# Project settings are a different world from node properties: a path-like setting must
# be stored as a plain String. Loading "res://x.tscn" into a Resource and letting
# ProjectSettings.save() write `run/main_scene=Resource("res://x.tscn")` produces a
# project.godot that Godot can no longer parse at all.
const PATH_SETTING_EXACT := [
	"application/run/main_scene",
	"application/config/icon",
	"application/boot_splash/image",
	"rendering/environment/defaults/default_environment",
	"gui/theme/custom",
	"gui/theme/custom_font",
]
const PATH_SETTING_SUFFIXES := ["_scene", "/main_scene", "_path", "_script", "_icon", "_file", "_dir", "_folder"]

func is_path_setting(key: String) -> bool:
	if PATH_SETTING_EXACT.has(key):
		return true
	if key.begins_with("autoload/") or key.begins_with("editor/plugins/"):
		return true
	for suffix in PATH_SETTING_SUFFIXES:
		if key.ends_with(suffix):
			return true
	return false

func coerce_setting_value(key: String, value):
	# Godot's JSON parser hands us floats for every number, so an integral float must
	# be folded back to int when the (registered or current) setting is an int.
	var known_type := -1
	if ProjectSettings.has_setting(key):
		known_type = typeof(ProjectSettings.get_setting(key))
	if typeof(value) == TYPE_FLOAT:
		var f: float = value
		if known_type == TYPE_INT and is_finite(f) and f == floor(f):
			return int(f)
		return value
	if typeof(value) != TYPE_STRING:
		if typeof(value) == TYPE_INT and known_type == TYPE_FLOAT:
			return float(value)
		return value
	var s: String = value
	if is_path_setting(key) or s.begins_with("res://") or s.begins_with("user://"):
		return s
	var parsed = str_to_var(s) if RegEx.create_from_string(_TYPED_LITERAL_RE).search(s) != null else null
	if parsed != null:
		return parsed
	var existed := ProjectSettings.has_setting(key)
	var old = ProjectSettings.get_setting(key) if existed else null
	if typeof(old) == TYPE_INT:
		if s.is_valid_int():
			return int(s)
		finish_error("setting '" + key + "' currently holds an int; '" + s + "' is not an integer")
		return null
	if typeof(old) == TYPE_FLOAT:
		if s.is_valid_float():
			return float(s)
		finish_error("setting '" + key + "' currently holds a float; '" + s + "' is not a number")
		return null
	if typeof(old) == TYPE_BOOL and (s == "true" or s == "false"):
		return s == "true"
	return s

func _op_write_settings() -> void:
	check_project_arg()
	if stop():
		return
	var raw: Variant = _params.get("settings", null)
	if raw == null or typeof(raw) != TYPE_DICTIONARY or (raw as Dictionary).is_empty():
		finish_error("missing required parameter: settings (non-empty JSON object)")
		return
	var flat := flatten_settings(raw)
	var changed: Array = []
	for key in flat:
		var existed := ProjectSettings.has_setting(key)
		var new_value = coerce_setting_value(key, flat[key])
		if stop():
			return
		if existed:
			var old = ProjectSettings.get_setting(key)
			# Never let `==` see two different types: GDScript raises
			# "Invalid operands 'String' and 'Object'" instead of returning false.
			if typeof(old) == typeof(new_value):
				var same: bool = is_same(old, new_value) if typeof(old) == TYPE_OBJECT else (old == new_value)
				if same:
					continue
		ProjectSettings.set_setting(key, new_value)
		changed.append(key)
	if changed.is_empty():
		finish({"changed": [], "note": "all values already match; nothing written"})
		return
	var project_file := _root.path_join("project.godot")
	var had_file := FileAccess.file_exists(project_file)
	var snapshot := FileAccess.get_file_as_string(project_file) if had_file else ""
	var err := ProjectSettings.save()
	if err != OK:
		finish_error("failed to write project.godot: " + error_string(err))
		return
	# Safety net: never leave a project.godot that Godot cannot parse. A value that
	# serialises to something unloadable (e.g. Resource("...") inside a path setting)
	# would otherwise brick the whole project on the next launch.
	var validator := ConfigFile.new()
	var check_err := validator.load(project_file)
	if check_err != OK:
		if had_file:
			var restore := FileAccess.open(project_file, FileAccess.WRITE)
			if restore != null:
				restore.store_string(snapshot)
				restore.close()
		finish_error("project.godot would not be loadable again (" + error_string(check_err) + "); reverted the file. Offending keys: " + str(changed))
		return
	for key in changed:
		if not ProjectSettings.has_setting(key):
			finish_error("setting '" + key + "' was not persisted")
			return
	finish({"changed": changed, "project_file": project_file})

func _op_delete_settings() -> void:
	check_project_arg()
	if stop():
		return
	var keys := opt_array("keys")
	if keys.is_empty():
		finish_error("missing required parameter: keys (non-empty array)")
		return
	var deleted: Array = []
	var missing: Array = []
	for k in keys:
		var key := str(k)
		if not ProjectSettings.has_setting(key):
			missing.append(key)
			continue
		ProjectSettings.set_setting(key, null)
		deleted.append(key)
	if deleted.is_empty():
		finish({"deleted": [], "missing": missing, "note": "nothing removed"})
		return
	var err := ProjectSettings.save()
	if err != OK:
		finish_error("failed to write project.godot: " + error_string(err))
		return
	finish({"deleted": deleted, "missing": missing, "project_file": _root.path_join("project.godot")})

# --------------------------------------------------------------------------------------
# ops: files
# --------------------------------------------------------------------------------------

func _op_list_files() -> void:
	check_project_arg()
	if stop():
		return
	var dir_arg := opt_str("dir", "res://")
	var pattern := opt_str("pattern")
	var recursive := opt_bool("recursive", true)
	var base := to_res(dir_arg)
	if base.is_empty():
		finish_error("dir is outside the project: " + dir_arg)
		return
	var abs_base := res_to_abs(base)
	if not DirAccess.dir_exists_absolute(abs_base):
		finish_error("directory does not exist: " + base)
		return
	var found: Array = []
	collect_files(base, recursive, [], found)
	var files: Array = []
	for p in found:
		var sp := str(p)
		if not pattern.is_empty():
			if not (sp.match(pattern) or sp.get_file().match(pattern) or sp.contains(pattern)):
				continue
		var entry := {
			"path": sp,
			"type": "file",
			"size": _file_size(sp),
			"ext": sp.get_extension().to_lower(),
		}
		files.append(entry)
	files.sort_custom(func(a, b): return str(a["path"]) < str(b["path"]))
	finish({"files": files, "total": files.size(), "dir": base, "recursive": recursive})

func _op_read_file() -> void:
	check_project_arg()
	if stop():
		return
	var path_arg := req_str("path")
	if stop():
		return
	var max_bytes := opt_int("max_bytes", DEFAULT_MAX_READ_BYTES)
	if max_bytes <= 0:
		max_bytes = DEFAULT_MAX_READ_BYTES
	var target := to_res(path_arg)
	if target.is_empty():
		finish_error("path is outside the project: " + path_arg)
		return
	if target == "res://":
		finish_error("path must point at a file, not the project root")
		return
	if not FileAccess.file_exists(target):
		finish_error("file does not exist: " + target)
		return
	var f := FileAccess.open(target, FileAccess.READ)
	if f == null:
		finish_error("cannot open " + target + ": " + error_string(FileAccess.get_open_error()))
		return
	var size := f.get_length()
	var to_read := int(min(size, max_bytes))
	var buf := f.get_buffer(to_read)
	f.close()
	var binary := buf.find(0) != -1
	var text := buf.get_string_from_utf8()
	if not binary and text.contains("\uFFFD"):
		binary = true
	finish({
		"path": target,
		"content": Marshalls.raw_to_base64(buf) if binary else text,
		"bytes": buf.size(),
		"size": size,
		"encoding": "base64" if binary else "utf-8",
		"truncated": buf.size() < size,
	})

func _op_write_file() -> void:
	check_project_arg()
	if stop():
		return
	var path_arg := req_str("path")
	if stop():
		return
	if not _params.has("content"):
		finish_error("missing required parameter: content")
		return
	var content := str(_params["content"])
	var encoding := opt_str("encoding", "utf-8").to_lower()
	var target := to_res(path_arg)
	if target.is_empty():
		finish_error("path is outside the project: " + path_arg)
		return
	if target == "res://" or target.ends_with("/"):
		finish_error("path must point at a file: " + target)
		return
	if not ensure_dir_for(target):
		return
	var f := FileAccess.open(target, FileAccess.WRITE)
	if f == null:
		finish_error("cannot write " + target + ": " + error_string(FileAccess.get_open_error()))
		return
	if encoding == "base64":
		f.store_buffer(Marshalls.base64_to_raw(content))
	elif encoding == "utf-8" or encoding == "utf8" or encoding == "text":
		f.store_string(content)
	else:
		f.close()
		finish_error("unsupported encoding: '" + encoding + "' (expected utf-8 | base64)")
		return
	f.close()
	var written := -1
	var check := FileAccess.open(target, FileAccess.READ)
	if check != null:
		written = check.get_length()
		check.close()
	finish({"path": target, "bytes": written, "encoding": encoding})

func _op_delete_file() -> void:
	check_project_arg()
	if stop():
		return
	var path_arg := req_str("path")
	if stop():
		return
	var target := to_res(path_arg)
	if target.is_empty():
		finish_error("path is outside the project: " + path_arg)
		return
	if target == "res://":
		finish_error("refusing to delete the project root")
		return
	var abs_target := res_to_abs(target)
	if DirAccess.dir_exists_absolute(abs_target):
		finish_error("path is a directory, not a file: " + target + " (use a dir-removal op)")
		return
	if not FileAccess.file_exists(target):
		finish_error("file does not exist: " + target)
		return
	var err := DirAccess.remove_absolute(abs_target)
	if err != OK:
		finish_error("failed to delete " + target + ": " + error_string(err))
		return
	var uid_deleted := false
	var uid_path := target + ".uid"
	if FileAccess.file_exists(uid_path):
		if DirAccess.remove_absolute(res_to_abs(uid_path)) == OK:
			uid_deleted = true
	finish({"deleted": true, "path": target, "uid_deleted": uid_deleted})

func _op_create_dir() -> void:
	check_project_arg()
	if stop():
		return
	var path_arg := req_str("path")
	if stop():
		return
	var target := to_res(path_arg)
	if target.is_empty() or target == "res://":
		finish_error("path must be a directory inside the project: " + path_arg)
		return
	var abs_target := res_to_abs(target)
	var existed := DirAccess.dir_exists_absolute(abs_target)
	if not existed:
		var err := DirAccess.make_dir_recursive_absolute(abs_target)
		if err != OK:
			finish_error("failed to create " + target + ": " + error_string(err))
			return
	if not DirAccess.dir_exists_absolute(abs_target):
		finish_error("directory was not created: " + target)
		return
	finish({"created": true, "path": target, "existed": existed})

func _op_find_symbols() -> void:
	check_project_arg()
	if stop():
		return
	var path_arg := req_str("path")
	if stop():
		return
	var target := to_res(path_arg)
	if target.is_empty():
		finish_error("path is outside the project: " + path_arg)
		return
	if not FileAccess.file_exists(target):
		finish_error("file does not exist: " + target)
		return
	if target.get_extension().to_lower() != "gd":
		finish_error("find_symbols only supports .gd files, got: " + target)
		return
	var source := FileAccess.get_file_as_string(target)
	var classes := _regex_all(source, "(?m)^\\s*class_name\\s+([A-Za-z_][A-Za-z0-9_]*)", 1)
	classes.append_array(_regex_all(source, "(?m)^class\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*:", 1))
	var functions := _regex_all(source, "(?m)^(?:static\\s+)?func\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(", 1)
	var signals_found := _regex_all(source, "(?m)^signal\\s+([A-Za-z_][A-Za-z0-9_]*)", 1)
	var exports := _regex_all(source, "(?m)^@export[^\\n]*?var\\s+([A-Za-z_][A-Za-z0-9_]*)", 1)
	# top-level vars only (locals are indented, so `^` anchors exclude them)
	var variables := _regex_all(source, "(?m)^(?:@[A-Za-z_][^\\n]*\\s+)?var\\s+([A-Za-z_][A-Za-z0-9_]*)", 1)
	finish({
		"path": target,
		"classes": classes,
		"functions": functions,
		"signals": signals_found,
		"exports": exports,
		"variables": variables,
		"extends": (_regex_all(source, "(?m)^extends\\s+(.+)$", 1) as Array).slice(0, 1),
	})

func _regex_all(source: String, pattern: String, group: int) -> Array:
	var out: Array = []
	var re := RegEx.create_from_string(pattern)
	if re == null:
		return out
	for m in re.search_all(source):
		out.append(m.get_string(group))
	return out

# --------------------------------------------------------------------------------------
# ops: resources / import / export / run
# --------------------------------------------------------------------------------------

func _op_resave_resources() -> void:
	check_project_arg()
	if stop():
		return
	var targets: Array = []
	var requested := opt_array("paths")
	if requested.is_empty():
		collect_files("res://", true, ["tscn", "scn", "tres", "res", "gd", "gdshader", "shader"], targets)
	else:
		for p in requested:
			var r := to_res(str(p))
			if r.is_empty():
				finish_error("path is outside the project: " + str(p))
				return
			targets.append(r)

	var resaved: Array = []
	var failed: Array = []
	for t in targets:
		var path := str(t)
		if not FileAccess.file_exists(path):
			failed.append({"path": path, "error": "file does not exist"})
			continue
		var res = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		if res == null:
			failed.append({"path": path, "error": "failed to load"})
			continue
		var err := ResourceSaver.save(res, path)
		if err != OK:
			failed.append({"path": path, "error": error_string(err)})
			continue
		resaved.append(path)
	finish({"resaved": resaved, "failed": failed, "total": targets.size()})

func _op_import_assets() -> void:
	check_project_arg()
	if stop():
		return
	var requested := opt_array("paths")
	var run := run_capture([godot_exe(), "--headless", "--path", _root, "--import"], IMPORT_TIMEOUT)
	# 嵌套 --import 没跑起来时，下面那些「找到了 .import 文件」只是磁盘上的旧状态，
	# 报成「导入成功」就是假成功。
	if bool(run.get("spawn_error", false)):
		finish_error(spawn_error_message(run, "import_assets 的嵌套 --import"))
		return

	var imported: Array = []
	if requested.is_empty():
		var found: Array = []
		collect_files("res://", true, ["import"], found)
		for p in found:
			var sp := str(p)
			imported.append(sp.trim_suffix(".import"))
	else:
		for p in requested:
			var r := to_res(str(p))
			if r.is_empty():
				finish_error("path is outside the project: " + str(p))
				return
			if FileAccess.file_exists(r + ".import"):
				imported.append(r)
	imported.sort()
	finish({
		"imported": imported,
		"count": imported.size(),
		"exit_code": run["exit_code"],
		"timed_out": run["timed_out"],
		"stderr_tail": _tail(run["stderr"], 2000),
	})

func _tail(text, max_chars: int) -> String:
	var s := str(text)
	if s.length() <= max_chars:
		return s
	return s.substr(s.length() - max_chars)

func _op_export_project() -> void:
	check_project_arg()
	if stop():
		return
	var preset := req_str("preset")
	var output_arg := req_str("output_path")
	if stop():
		return
	var debug := opt_bool("debug", false)

	var presets_file := _root.path_join("export_presets.cfg")
	if not FileAccess.file_exists(presets_file):
		finish_error("no export presets configured: " + presets_file + " does not exist")
		return
	var cfg := ConfigFile.new()
	if cfg.load(presets_file) != OK:
		finish_error("cannot parse " + presets_file)
		return
	var preset_found := false
	var known: Array = []
	for section in cfg.get_sections():
		if not str(section).begins_with("preset."):
			continue
		var pname := str(cfg.get_value(section, "name", ""))
		if not pname.is_empty():
			known.append(pname)
		if pname == preset:
			preset_found = true
	if not preset_found:
		finish_error("export preset '" + preset + "' not found in export_presets.cfg (known: " + str(known) + ")")
		return

	var out_abs := output_arg
	if not out_abs.is_absolute_path():
		out_abs = _norm_abs(_root.path_join(output_arg))
	else:
		out_abs = _norm_abs(out_abs)
	var out_dir := out_abs.get_base_dir()
	if not DirAccess.dir_exists_absolute(out_dir):
		var mk := DirAccess.make_dir_recursive_absolute(out_dir)
		if mk != OK:
			finish_error("cannot create output directory '" + out_dir + "': " + error_string(mk))
			return

	var flag := "--export-debug" if debug else "--export-release"
	var run := run_capture([godot_exe(), "--headless", "--path", _root, flag, preset, out_abs], EXPORT_TIMEOUT)
	if bool(run.get("spawn_error", false)):
		finish_error(spawn_error_message(run, "export_project 的嵌套 --export"))
		return

	# The artifact is a FILE on most platforms (.apk/.exe/.zip/.x86_64) but a DIRECTORY
	# on macOS (Foo.app is a bundle). FileAccess.file_exists() reports false for
	# directories, so both cases must be accepted.
	var is_file := FileAccess.file_exists(out_abs)
	var is_dir := DirAccess.dir_exists_absolute(out_abs)
	var exit_code := int(run["exit_code"])

	if exit_code != 0:
		# Godot's export CLI exits non-zero when it refused to export. Never report
		# success here: a surviving artifact is almost certainly a stale previous build.
		var stale := ""
		if is_file or is_dir:
			stale = " Note: an artifact already exists at that path (likely a stale previous export, not verified as current)."
		finish_error("export failed with exit code " + str(exit_code) + " at " + out_abs + ":" + stale + " " + _tail(run["stderr"], 1500))
		return
	if not is_file and not is_dir:
		finish_error("export produced no output at " + out_abs + " (exit " + str(exit_code) + "): " + _tail(run["stderr"], 1500))
		return

	var bytes := 0
	var entries := 1
	var truncated := false
	if is_dir:
		var scan := measure_export_output(out_abs)
		bytes = int(scan["bytes"])
		entries = int(scan["entries"])
		truncated = bool(scan["truncated"])
	else:
		var fh := FileAccess.open(out_abs, FileAccess.READ)
		if fh != null:
			bytes = int(fh.get_length())
			fh.close()
	finish({
		"output_path": out_abs,
		"bytes": bytes,
		"kind": "directory" if is_dir else "file",
		"entries": entries,
		"size_truncated": truncated,
		"preset": preset,
		"debug": debug,
		"exit_code": exit_code,
		"duration_ms": run["duration_ms"],
		"stderr_tail": _tail(run["stderr"], 1500),
	})

# Recursively totals the size of an exported artifact directory (macOS .app bundles are
# directories). Bounded so a pathological output tree cannot stall the op.
func measure_export_output(path_abs: String) -> Dictionary:
	var bytes := 0
	var entries := 0
	var truncated := false
	var pending: Array[String] = [path_abs]
	while pending.size() > 0:
		var current: String = pending.pop_back()
		var dir := DirAccess.open(current)
		if dir == null:
			continue
		dir.list_dir_begin()
		var name := dir.get_next()
		while name != "":
			if name != "." and name != "..":
				var child := current.path_join(name)
				if dir.current_is_dir():
					pending.append(child)
				elif entries >= MAX_EXPORT_SCAN_FILES:
					truncated = true
				else:
					entries += 1
					var fh := FileAccess.open(child, FileAccess.READ)
					if fh != null:
						bytes += fh.get_length()
						fh.close()
			if truncated:
				break
			name = dir.get_next()
		dir.list_dir_end()
		if truncated:
			break
	return {"entries": entries, "bytes": bytes, "truncated": truncated}

func _op_run_project() -> void:
	check_project_arg()
	if stop():
		return
	var headless := opt_bool("headless", true)
	var scene_arg := opt_str("scene")
	# `quit_after` is in seconds (default 10, clamped to 1..600); the game is bounded by
	# Godot's own --quit-after frame counter and by the watchdog inside run_capture().
	var quit_after := float(opt_int("quit_after", int(DEFAULT_RUN_QUIT_AFTER)))
	quit_after = clampf(quit_after, 1.0, MAX_RUN_QUIT_AFTER)
	var frames := int(round(quit_after * 60.0))

	var argv: Array = [godot_exe(), "--path", _root]
	if headless:
		argv.append("--headless")
	argv.append("--quit-after")
	argv.append(str(frames))
	if not scene_arg.is_empty():
		var scene_res := to_res(scene_arg)
		if scene_res.is_empty() or not FileAccess.file_exists(scene_res):
			finish_error("scene does not exist: " + scene_arg)
			return
		argv.append(scene_res)

	var run := run_capture(argv, quit_after + 30.0)
	if bool(run.get("spawn_error", false)):
		# 旧实现在这里只回一句 "cannot create helper script"，调用方读到的是「游戏没输出」，
		# 既不像失败也不知怎么修。
		finish_error(spawn_error_message(run, "run_project 的嵌套运行"))
		return
	var out := {
		"stdout": str(run["stdout"]),
		"stderr": str(run["stderr"]),
		"exit_code": run["exit_code"],
		"duration_ms": run["duration_ms"],
		"timed_out": run["timed_out"],
		"headless": headless,
		"quit_after_seconds": quit_after,
	}
	# 默认是 headless。这条太容易被忽略：无头用的是 dummy 渲染器，没有帧缓冲，
	# 于是 `rt.screenshot` 和 `await RenderingServer.frame_post_draw` 会直接失败或
	# 永久挂起。把「这次跑的是哪种显示」显式回给调用方，省掉一轮 180 秒的排查。
	if headless:
		out["display"] = "dummy"
		out["note"] = "headless run: no framebuffer, so screenshots and frame-synced capture are unavailable. Use godot_session(action=\"game\") for a windowed run."
	else:
		out["display"] = "window"
	finish(out)

# --------------------------------------------------------------------------------------
# ops: parse_check
# --------------------------------------------------------------------------------------

func _op_parse_check() -> void:
	check_project_arg()
	if stop():
		return
	var targets: Array = []
	var requested := opt_array("paths")
	if requested.is_empty():
		collect_files("res://", true, ["gd"], targets)
	else:
		for p in requested:
			var r := to_res(str(p))
			if r.is_empty():
				finish_error("path is outside the project: " + str(p))
				return
			targets.append(r)

	# 默认用进程内编译做「初筛」：快，但会漏。同一个进程里，某个全局类第一次
	# 解析失败后，后续引用它的脚本可能直接拿到缓存的坏占位符、reload() 反而返回 OK
	# —— 实测 4 个同样的依赖脚本，只有第 1 个被判为可疑。所以 deep=true 时跳过
	# 初筛，对每个请求文件都真跑一遍 --check-only（每个文件一个 Godot 进程，慢但准）。
	var deep := opt_bool("deep", false)
	var suspicious: Array = []
	if deep:
		for t in targets:
			suspicious.append(str(t))
	else:
		for t in targets:
			var path := str(t)
			if not FileAccess.file_exists(path):
				suspicious.append(path)
				continue
			var source := FileAccess.get_file_as_string(path)
			var probe := GDScript.new()
			probe.source_code = source
			if probe.reload() != OK:
				suspicious.append(path)

	# 一个脚本 load 不起来，往往不是它自己有语法错，而是它依赖的脚本错了
	# （依赖解析失败 → 它也 load 不起来）。若逐个复核时只记「被查的那个文件」，
	# N 个受影响文件就会报出 N 条一模一样的错误，把真正的源文件淹没掉 ——
	# 实测过一次：5 个文件全部报 board.gd 的同一行同一条消息，看起来像 5 个 bug。
	# 所以这里读出诊断真正指向的文件（origin），按 (origin,line,message) 归并：
	# 一条真错只产生一条记录，其余列为 affects。
	var groups := {}
	var order: Array = []
	var attempts := 0
	var checks_failed := 0
	for path in suspicious:
		if attempts >= NESTED_CHECK_ATTEMPTS:
			var cap_key := "cap|" + str(path)
			groups[cap_key] = {
				"path": str(path), "origin": str(path), "line": 0,
				"message": "not re-checked (attempt cap reached)",
				"cascade": false, "affects": [str(path)], "check_failed": true,
			}
			order.append(cap_key)
			checks_failed += 1
			continue
		attempts += 1
		# `--check-only` exits 0 even for a script that fails to parse, so the verdict
		# has to come from stderr, not from the exit code.
		var run := run_capture([godot_exe(), "--headless", "--path", _root, "--check-only", "--script", str(path)], 60.0)
		if bool(run.get("spawn_error", false)):
			# 嵌套检查一个文件都没跑成 —— 这时**必须**报错：返回「0 个错误」等于告诉调用方
			# 「代码是干净的」，而实际上没有任何文件被真正检查过（真机踩到过这次）。
			finish_error(spawn_error_message(run, "deep parse_check 的逐文件 --check-only"))
			return
		var combined := str(run["stderr"]) + "\n" + str(run["stdout"])
		# 「这次检查是否可信地跑完了」的判定：**单一来源**在 check_verdict.gd
		# （规则：timeout/orphan/still_running/杀树失败 → 不可信；exit 0 → 可信；
		#  exit 1 且解析出带定位的诊断 → 可信（Windows 的 --check-only 解析失败就是 1）；
		#  其它非零（137、崩溃码…）→ 不可信，即便日志里残留 Parse Error 文本）。
		var exit_code := int(run["exit_code"])
		var parsed_errors: Array = _parse_godot_errors(combined, str(path))
		var has_located_diagnostic := false
		for err in parsed_errors:
			if int(err.get("line", 0)) > 0 and _looks_like_script_path(str(err.get("origin", ""))):
				has_located_diagnostic = true
				break
		var verdict_script := verdict_script()
		if verdict_script == null:
			finish_error("缺少 check_verdict.gd（应与 ops.gd 同目录发布）：" + _script_file.get_base_dir())
			return
		var verdict: Dictionary = verdict_script.check_completed(run, has_located_diagnostic)
		if not bool(verdict["completed"]):
			var fail_key := "failed|" + str(path)
			groups[fail_key] = {
				"path": str(path), "origin": str(path), "line": 0,
				"message": (
					"check did not complete: exit=%d timed_out=%s orphaned=%s still_running=%s kill_failed=%s" % [
						exit_code, str(bool(run.get("timed_out", false))),
						str(bool(run.get("orphaned", false))), str(bool(run.get("still_running", false))),
						str(bool(verdict["kill_failed"])),
					] if bool(verdict["incomplete"]) else
					"check exited %d without a valid located diagnostic (unexplained nonzero exit)" % exit_code
				),
				"cascade": false, "affects": [str(path)], "check_failed": true,
				"stderr_tail": _tail(combined, 800),
			}
			order.append(fail_key)
			checks_failed += 1
			continue
		var has_diagnostic := _looks_like_engine_error(combined)
		if not has_diagnostic:
			continue  # exit 0 且没有引擎诊断：初筛假阳性（例如 unresolved preload）
		for err in parsed_errors:
			var key := "%s|%d|%s" % [str(err["origin"]), int(err["line"]), str(err["message"])]
			if groups.has(key):
				groups[key]["affects"].append(str(path))
			else:
				err["affects"] = [str(path)]
				groups[key] = err
				order.append(key)

	var errors: Array = []
	var cascade_count := 0
	for key in order:
		var entry: Dictionary = groups[key]
		# cascade 的判定放在归并之后做：只要 origin 出现在 affects 里，就说明
		# 「有一个被查文件自己就是源文件」，这条错误是主错误；否则它是被连累的。
		# 用「后算」而不是「先算」，结果与遍历顺序无关。
		entry["cascade"] = not (entry["affects"] as Array).has(entry["origin"])
		if bool(entry["cascade"]):
			cascade_count += 1
		errors.append(entry)
	# 主错误（诊断就指向它自己）排前面：调用方读第一条就该拿到要修的那个文件
	errors.sort_custom(_error_sort)

	finish({
		"errors": errors,
		"checked": targets.size(),
		"suspect": suspicious.size(),
		"unique_errors": errors.size(),
		"cascade_errors": cascade_count,
		"deep": deep,
		# 「有几个文件的检查根本没跑完」必须显式可见：调用方看到 0 errors 时，
		# 只有同时看到 incomplete=false 才能认为代码是干净的。
		"checks_failed": checks_failed,
		"incomplete": checks_failed > 0,
	})

func _error_sort(a: Dictionary, b: Dictionary) -> bool:
	var ca := bool(a.get("cascade", false))
	var cb := bool(b.get("cascade", false))
	if ca == cb:
		return str(a.get("origin", "")) < str(b.get("origin", ""))
	return not ca

## 把诊断里的文件位置归一化成 res:// 形式，好和请求的路径直接比较。
func _diag_file(raw: String) -> String:
	var f := raw.strip_edges()
	if f.is_empty():
		return f
	if f.begins_with("res://") or f.begins_with("user://"):
		return f
	if f.is_absolute_path():
		var abs_root := res_to_abs("res://")
		if not abs_root.ends_with("/"):
			abs_root += "/"
		if f.begins_with(abs_root):
			return "res://" + f.substr(abs_root.length())
	return f

## 诊断里的位置必须落在项目脚本上才算数：引擎自己会把自己的 .cpp 源码路径
## （modules/gdscript/gdscript_resource_format.cpp:46）打进同一段输出里。
func _looks_like_script_path(f: String) -> bool:
	return f.begins_with("res://") or f.begins_with("user://") or f.ends_with(".gd")

## 把一次 `--check-only` 的输出解析成 0..N 条 {path,origin,line,message,cascade}。
##
## 实测输出形状：
##   SCRIPT ERROR: Parse Error: Cannot infer the type of "c" ...        ← 根因消息
##             at: GDScript::reload (res://base.gd:8)                   ← 根因位置（紧邻下一行）
##   SCRIPT ERROR: Compile Error: Failed to compile depended scripts.   ← 依赖方被连累的包装帧
##             at: GDScript::reload (res://dep1.gd:0)                  ← 不是根因，行号还是 0
##   ERROR: Failed to load script "res://dep1.gd" ...
##      at: load (modules/gdscript/gdscript_resource_format.cpp:46)    ← 引擎内部路径，必须忽略
##
## 所以规则是：只认「Parse Error 那一行紧跟着的位置」，且只认项目内的脚本路径。
## 之前按「任意 (file:line) 出现即更新」的写法，会被上面的包装帧和 .cpp 帧依次覆盖，
## 最后把根因丢成 dep1.gd:0 甚至引擎的 .cpp —— 比不解析还误导人。
func _parse_godot_errors(output: String, path: String) -> Array:
	var found: Array = []
	var lines := output.split("\n")
	var any_loc_re := RegEx.create_from_string("\\(([^()]+):(\\d+)\\)")
	var msg_re := RegEx.create_from_string("(?m)^\\s*(?:ERROR|SCRIPT ERROR|WARNING):\\s*(.+)$")
	var fallback_message := ""
	for i in range(lines.size()):
		var l := str(lines[i])
		if l.strip_edges().is_empty():
			continue
		if l.contains("Parse error"):
			# 泛化包装行：Failed to load script "..." with error "Parse error".
			if fallback_message.is_empty():
				var fm := msg_re.search(l)
				if fm != null:
					fallback_message = fm.get_string(1).strip_edges()
			continue
		if not l.contains("Parse Error"):
			continue
		var message := ""
		var pm := msg_re.search(l)
		if pm != null:
			message = pm.get_string(1).strip_edges()
		if message.is_empty():
			message = _tail(l.strip_edges(), 300)
		var origin := path
		var line := 0
		for j in range(i + 1, mini(i + 4, lines.size())):
			var lm := any_loc_re.search(str(lines[j]))
			if lm == null:
				continue
			var f := _diag_file(lm.get_string(1))
			if _looks_like_script_path(f):
				origin = f
				line = int(lm.get_string(2))
			break  # 只认紧邻的第一个位置行，不管它是不是脚本路径
		found.append({"path": origin, "origin": origin, "line": line, "message": message, "cascade": origin != path})
	if found.is_empty():
		var message := fallback_message
		if message.is_empty():
			message = _tail(output.strip_edges(), 600)
		found.append({"path": path, "origin": path, "line": 0, "message": message, "cascade": false})
	return found

# --------------------------------------------------------------------------------------
# ops: gdscript escape hatch
# --------------------------------------------------------------------------------------

func _op_gdscript() -> void:
	check_project_arg()
	if stop():
		return
	var source := req_str_raw("source")
	if stop():
		return
	if source.strip_edges().is_empty():
		finish_error("'source' must not be empty")
		return
	var uid := opt_str("uid")
	if uid.is_empty():
		uid = str(Time.get_ticks_usec())
	var safe_id := ""
	for ch in uid:
		var c := str(ch)
		safe_id += c if (c.is_valid_identifier() or c == "-" or c == "_" or (c >= "0" and c <= "9")) else "_"
	if safe_id.is_empty():
		safe_id = str(Time.get_ticks_usec())

	var tmp_abs := res_to_abs(TMP_RES)
	if DirAccess.make_dir_recursive_absolute(tmp_abs) != OK and not DirAccess.dir_exists_absolute(tmp_abs):
		finish_error("cannot create temp dir " + tmp_abs)
		return

	var script_abs := tmp_abs.path_join("mcp_escape_" + safe_id + ".gd")
	var payload_abs := tmp_abs.path_join("mcp_escape_" + safe_id + ".json")
	var script_res := TMP_RES.path_join("mcp_escape_" + safe_id + ".gd")

	if FileAccess.file_exists(payload_abs):
		DirAccess.remove_absolute(payload_abs)

	var composed := compose_escape_source(source, payload_abs)
	var f := FileAccess.open(script_abs, FileAccess.WRITE)
	if f == null:
		finish_error("cannot write temp escape script " + script_abs + ": " + error_string(FileAccess.get_open_error()))
		return
	f.store_string(composed)
	f.close()

	var timeout := float(opt_int("timeout", int(DEFAULT_ESCAPE_TIMEOUT)))
	if timeout <= 0.0:
		timeout = DEFAULT_ESCAPE_TIMEOUT
	timeout = clampf(timeout, 1.0, 300.0)

	var run := run_capture(
		[godot_exe(), "--headless", "--path", _root, "--script", script_abs, "--quit-after", "600"],
		timeout
	)

	var payload_text := ""
	if FileAccess.file_exists(payload_abs):
		payload_text = FileAccess.get_file_as_string(payload_abs)
		DirAccess.remove_absolute(payload_abs)
	if FileAccess.file_exists(script_abs):
		DirAccess.remove_absolute(script_abs)
	var uid_sidecar := script_abs + ".uid"
	if FileAccess.file_exists(uid_sidecar):
		DirAccess.remove_absolute(uid_sidecar)
	if DirAccess.dir_exists_absolute(tmp_abs) and DirAccess.open(tmp_abs) != null:
		_remove_dir_if_empty(tmp_abs)

	# 放在临时脚本清理之后：即使嵌套进程起不来，也不给项目里留垃圾。
	if bool(run.get("spawn_error", false)):
		finish_error(spawn_error_message(run, "gdscript 逃生舱的嵌套执行"))
		return

	var stdout := str(run["stdout"])
	var stderr := str(run["stderr"])
	# drop the engine banner / temp-script path noise from the reported stdout
	var cleaned := PackedStringArray()
	for raw_line in stdout.split("\n"):
		var l := str(raw_line)
		if l.begins_with("Godot Engine v") or l.strip_edges().is_empty():
			continue
		if l.contains(script_res) or l.contains(script_abs):
			continue
		cleaned.append(l)

	var data := {
		"stdout": "\n".join(cleaned),
		"stderr": _tail(stderr, 4000),
		"exit_code": run["exit_code"],
		"timed_out": run["timed_out"],
		"duration_ms": run["duration_ms"],
	}
	if not payload_text.strip_edges().is_empty():
		var parsed = JSON.parse_string(payload_text)
		if typeof(parsed) == TYPE_DICTIONARY:
			data["result"] = parsed.get("value", null)
			data["result_text"] = str(parsed.get("text", ""))
			data["mode"] = "MCP_RESULT"
		else:
			data["result"] = payload_text
			data["mode"] = "raw_payload"
	else:
		if cleaned.size() == 0 and _looks_like_engine_error(stderr):
			# e.g. a parse error in the supplied source: no payload, no output, errors on
			# stderr (Godot still exits 0 for "Failed to load script", so we cannot rely
			# on the exit code alone).
			finish_error("escape script failed: " + _tail(stderr.strip_edges(), 1200))
			return
		data["result"] = "\n".join(cleaned).strip_edges()
		data["mode"] = "stdout"
	finish(data)

func _looks_like_engine_error(stderr: String) -> bool:
	return stderr.contains("SCRIPT ERROR") or stderr.contains("Parse Error") or stderr.contains("ERROR:")

func req_str_raw(key: String) -> String:
	if not _params.has(key) or _params[key] == null:
		finish_error("missing required parameter: " + key)
		return ""
	return str(_params[key])

func _remove_dir_if_empty(abs_dir: String) -> void:
	var dir := DirAccess.open(abs_dir)
	if dir == null:
		return
	dir.list_dir_begin()
	var name := dir.get_next()
	var empty := true
	while name != "":
		if name != "." and name != "..":
			empty = false
			break
		name = dir.get_next()
	dir.list_dir_end()
	if empty:
		DirAccess.remove_absolute(abs_dir)

func compose_escape_source(source: String, payload_abs: String) -> String:
	var has_result_fn := RegEx.create_from_string("(?m)^\\s*(?:static\\s+)?func\\s+MCP_RESULT\\s*\\(").search(source) != null

	var prelude := "\n# ---- godot-mcp escape-hatch prelude (auto-injected) ----\n"
	prelude += "var __mcp_payload_path := " + JSON.stringify(payload_abs) + "\n"
	if not has_result_fn:
		prelude += "func MCP_RESULT(value):\n"
		prelude += "\tvar __mcp_f := FileAccess.open(__mcp_payload_path, FileAccess.WRITE)\n"
		prelude += "\tif __mcp_f != null:\n"
		prelude += "\t\t__mcp_f.store_string(JSON.stringify({\"has\": true, \"value\": __mcp_enc(value), \"text\": str(value)}))\n"
		prelude += "\t\t__mcp_f.close()\n"
		prelude += "\treturn value\n"
	prelude += "func __mcp_enc(v):\n"
	prelude += "\tmatch typeof(v):\n"
	prelude += "\t\tTYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:\n"
	prelude += "\t\t\treturn v\n"
	prelude += "\t\tTYPE_ARRAY, TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY:\n"
	prelude += "\t\t\tvar __mcp_a := []\n"
	prelude += "\t\t\tfor __mcp_x in v:\n"
	prelude += "\t\t\t\t__mcp_a.append(__mcp_enc(__mcp_x))\n"
	prelude += "\t\t\treturn __mcp_a\n"
	prelude += "\t\tTYPE_DICTIONARY:\n"
	prelude += "\t\t\tvar __mcp_d := {}\n"
	prelude += "\t\t\tfor __mcp_k in v:\n"
	prelude += "\t\t\t\t__mcp_d[str(__mcp_k)] = __mcp_enc(v[__mcp_k])\n"
	prelude += "\t\t\treturn __mcp_d\n"
	prelude += "\t\t_:\n"
	prelude += "\t\t\treturn str(v)\n"

	# Insert the prelude after the leading `extends` / `class_name` / annotation lines.
	var lines := source.split("\n")
	var insert_after := -1
	var scanned := 0
	for i in lines.size():
		if scanned > 25:
			break
		scanned += 1
		var t := str(lines[i]).strip_edges()
		if t.is_empty() or t.begins_with("#"):
			continue
		if t.begins_with("extends ") or t.begins_with("class_name ") or t.begins_with("@tool") or t.begins_with("@icon") or t.begins_with("@warning_ignore"):
			insert_after = i
			continue
		break

	if insert_after >= 0:
		var head := "\n".join(PackedStringArray(lines.slice(0, insert_after + 1)))
		var tail := "\n".join(PackedStringArray(lines.slice(insert_after + 1)))
		return head + "\n" + prelude + tail
	return "extends SceneTree\n" + prelude + source
