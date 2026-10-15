extends Node
## Godot MCP Runtime — L3 (live game control) layer.
##
## Drop-in autoload for any Godot project. Listens on 127.0.0.1:9091 and speaks
## newline-delimited JSON over plain TCP:
##
##   request  {"id": "...", "op": "rt.info", "params": {...}}
##   response {"id": "...", "ok": true,  "data": {...}}
##            {"id": "...", "ok": false, "error": "..."}
##
## Frozen contract: godot-mcp DESIGN.md §2.3.
##   rt.info · rt.scene_tree · rt.get_node · rt.get_property · rt.set_property
##   rt.call_method · rt.screenshot · rt.input · rt.eval · rt.quit
##   (+ additive: rt.ping · rt.wait · rt.performance)
##
## process_mode is PROCESS_MODE_ALWAYS: the bridge keeps answering while the
## game is paused (get_tree().paused == true).
##
## ---------------------------------------------------------------------------
## Startup gate — when does the bridge listen and when does it stay closed?
## ---------------------------------------------------------------------------
## This socket has NO authentication and `rt.eval` is arbitrary code execution,
## so it is treated as a development-only facility. `_ready()` opens the port
## only in these cases:
##
##   * running inside the editor                    -> OS.has_feature("editor")
##   * debug builds: editor "play", a `--headless` debug run, or a *debug*
##     export (`--export-debug`)                    -> OS.is_debug_build()
##   * deliberate opt-in on any build, including a release export:
##     GODOT_MCP_RUNTIME_FORCE=1|true|yes|on
##
## A **release export** (`--export-release`) therefore starts NO server: nothing
## is bound to 9091, nothing is pushed as an error/warning, `_process` is
## switched off and the node is inert. To remote-debug a shipped release build
## on purpose, launch it with GODOT_MCP_RUNTIME_FORCE=1.
##
## GODOT_MCP_RUNTIME_DISABLE=1 always wins over everything and keeps the port
## closed (handy for a debug build you do not want to expose).
##
## Port override: GODOT_MCP_RUNTIME_PORT (default 9091).
## Debug logging: GODOT_MCP_RUNTIME_DEBUG=1.
##
## This file is intentionally self-contained: no dependency on the editor addon
## (mcp_bridge.gd) or on the headless ops.gd, so it can be copied alone into
## res://addons/godot_mcp_bridge/runtime/.
##
## Several JSON <-> Variant conversion helpers are adapted from
## tugcantopaloglu/godot-mcp (MIT, Copyright (c) 2025 Tugcan Topaloglu;
## original work Coding-Solo/godot-mcp, Copyright (c) 2025 Solomon Elias).

const DEFAULT_PORT: int = 9091
const ENV_PORT: String = "GODOT_MCP_RUNTIME_PORT"
const ENV_DEBUG: String = "GODOT_MCP_RUNTIME_DEBUG"
const ENV_FORCE: String = "GODOT_MCP_RUNTIME_FORCE"
const ENV_DISABLE: String = "GODOT_MCP_RUNTIME_DISABLE"
const PROTOCOL: String = "godot-mcp-runtime/1"

const MAX_QUEUE: int = 64
const MAX_LOG_LINES: int = 500
const BUSY_WATCHDOG_MSEC: int = 30000
const MAX_JSON_DEPTH: int = 24
const EVAL_TIMEOUT_MSEC: int = 15000
const MAX_LINE_BYTES: int = 16 * 1024 * 1024

const EVAL_WRAPPER_HEAD: String = """extends Node

var mcp_result = null

func MCP_RESULT(v):
	mcp_result = v

func _run():
"""

var port: int = DEFAULT_PORT

var _server: TCPServer = null
var _clients: Dictionary = {}        # instance_id -> {tcp, buf, since}
var _queue: Array = []
var _busy: bool = false
var _busy_since: int = 0
var _current_job: Dictionary = {}
var _log_lines: Array = []
var _debug: bool = false
var _requests_served: int = 0
var _last_error: String = ""
var _quit_requested: bool = false
var _quit_code: int = 0
var _started_at: int = 0

var listening: bool = false          # true only once the port is really open
var gate_reason: String = ""         # non-empty => the security gate closed it


# ---------------------------------------------------------------- lifecycle --

func _ready() -> void:
	# Keep answering even when the game is paused.
	process_mode = Node.PROCESS_MODE_ALWAYS
	_install_error_recorder()
	_debug = _env_flag(ENV_DEBUG)
	var env_port: String = OS.get_environment(ENV_PORT).strip_edges()
	if env_port.is_valid_int():
		port = int(env_port)

	# Security gate — see the file header. Never open a control port on our own
	# inside a release build.
	gate_reason = bridge_gate_reason(
		OS.is_debug_build(),
		OS.has_feature("editor"),
		_env_flag(ENV_FORCE),
		_env_flag(ENV_DISABLE))
	if not gate_reason.is_empty():
		listening = false
		# Deliberately not push_error()/push_warning(): a shipped release game
		# must stay quiet. print_verbose() only appears with --verbose.
		print_verbose("Godot MCP Runtime: bridge disabled (%s)" % gate_reason)
		set_process(false)
		return

	listening = true
	if _env_flag(ENV_FORCE) and not OS.is_debug_build() and not OS.has_feature("editor"):
		_log("bridge enabled explicitly by %s" % ENV_FORCE)
	_started_at = Time.get_ticks_msec()
	_server = TCPServer.new()
	var err: int = _server.listen(port, "127.0.0.1")
	if err != OK:
		_server = null
		listening = false
		_last_error = "cannot listen on 127.0.0.1:%d (error %d)" % [port, err]
		push_error("Godot MCP Runtime: %s" % _last_error)
		_log("ERROR: %s" % _last_error)
		return
	_log("listening on 127.0.0.1:%d" % port)


func _exit_tree() -> void:
	if _recorder != null and OS.has_method("remove_logger"):
		OS.remove_logger(_recorder)
		_recorder = null
	for id in _clients.keys():
		var tcp: StreamPeerTCP = _clients[id].get("tcp")
		if tcp != null:
			tcp.disconnect_from_host()
	_clients.clear()
	if _server != null:
		_server.stop()
		_server = null


func _process(_delta: float) -> void:
	_poll_clients()
	_freeze_watchdog()
	if _busy and Time.get_ticks_msec() - _busy_since > BUSY_WATCHDOG_MSEC:
		var op: String = String(_current_job.get("op", "?"))
		_log("WARN: op '%s' stuck for >%d ms, releasing the queue" % [op, BUSY_WATCHDOG_MSEC])
		_send_raw(int(_current_job.get("client", -1)), {
			"id": _current_job.get("id", null),
			"op": op,
			"ok": false,
			"error": "runtime watchdog: op '%s' did not finish within %d ms" % [op, BUSY_WATCHDOG_MSEC],
		})
		_busy = false
		_current_job = {}

	if not _busy and not _queue.is_empty():
		var job: Dictionary = _queue.pop_front()
		_busy = true
		_busy_since = Time.get_ticks_msec()
		_current_job = job
		_run_job(job)

	# rt.quit is deferred until the response has been written out.
	if _quit_requested and not _busy and _queue.is_empty():
		_log("quitting (exit code %d)" % _quit_code)
		get_tree().quit(_quit_code)


# ------------------------------------------------------------------ network --

func _poll_clients() -> void:
	if _server == null:
		return
	while _server.is_connection_available():
		var tcp: StreamPeerTCP = _server.take_connection()
		if tcp == null:
			break
		var id: int = tcp.get_instance_id()
		_clients[id] = {"tcp": tcp, "buf": "", "since": Time.get_ticks_msec()}
		_log("client connected (%d)" % id)

	var dead: Array = []
	for id in _clients.keys():
		var entry: Dictionary = _clients[id]
		var tcp: StreamPeerTCP = entry.get("tcp")
		if tcp == null:
			dead.append(id)
			continue
		tcp.poll()
		var status: int = tcp.get_status()
		if status == StreamPeerTCP.STATUS_ERROR or status == StreamPeerTCP.STATUS_NONE:
			dead.append(id)
			continue
		if status != StreamPeerTCP.STATUS_CONNECTED:
			continue
		var available: int = tcp.get_available_bytes()
		if available <= 0:
			continue
		var chunk: Array = tcp.get_data(available)
		if int(chunk[0]) != OK:
			dead.append(id)
			continue
		var bytes: PackedByteArray = chunk[1]
		if String(entry.get("buf", "")).length() + bytes.size() > MAX_LINE_BYTES:
			_log("client %d exceeded the %d byte line limit, dropping" % [id, MAX_LINE_BYTES])
			dead.append(id)
			continue
		_ingest(id, bytes.get_string_from_utf8())

	for id in dead:
		_close_client(id, true)


func _close_client(id: int, log_it: bool) -> void:
	var entry: Dictionary = _clients.get(id, {})
	if not entry.is_empty():
		var tcp: StreamPeerTCP = entry.get("tcp")
		if tcp != null and tcp.get_status() == StreamPeerTCP.STATUS_CONNECTED:
			tcp.disconnect_from_host()
	_clients.erase(id)
	if log_it:
		_log("client disconnected (%d)" % id)


func _ingest(client_id: int, text: String) -> void:
	var entry: Dictionary = _clients.get(client_id, {})
	if entry.is_empty():
		return
	var buf: String = String(entry.get("buf", "")) + text
	while true:
		var nl: int = buf.find("\n")
		if nl < 0:
			break
		var line: String = buf.substr(0, nl).strip_edges()
		buf = buf.substr(nl + 1)
		if not line.is_empty():
			_enqueue(client_id, line)
	var tail: String = buf.strip_edges()
	if not tail.is_empty():
		var probe := JSON.new()
		if probe.parse(tail) == OK and probe.data is Dictionary and (probe.data as Dictionary).has("op"):
			_enqueue(client_id, tail)
			buf = ""
	entry["buf"] = buf


func _enqueue(client_id: int, line: String) -> void:
	var probe := JSON.new()
	if probe.parse(line) != OK:
		_send_raw(client_id, {"id": null, "ok": false, "error": "invalid JSON: %s" % probe.get_error_message()})
		return
	var parsed: Variant = probe.data
	if not (parsed is Dictionary):
		_send_raw(client_id, {"id": null, "ok": false, "error": "request must be a JSON object"})
		return
	var req: Dictionary = parsed
	if not req.has("op") or not (req["op"] is String):
		_send_raw(client_id, {"id": req.get("id", null), "ok": false, "error": "request is missing the 'op' string field"})
		return
	if _queue.size() >= MAX_QUEUE:
		_send_raw(client_id, {"id": req.get("id", null), "ok": false, "error": "runtime queue full (%d pending)" % MAX_QUEUE})
		return
	var params: Dictionary = {}
	if req.get("params") is Dictionary:
		params = req["params"]
	_queue.append({
		"client": client_id,
		"id": req.get("id", null),
		"op": String(req["op"]),
		"params": params,
	})


func _send_raw(client_id: int, payload: Dictionary) -> void:
	var entry: Dictionary = _clients.get(client_id, {})
	if entry.is_empty():
		return
	var tcp: StreamPeerTCP = entry.get("tcp")
	if tcp == null or tcp.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		return
	var text: String = JSON.stringify(payload) + "\n"
	tcp.put_data(text.to_utf8_buffer())


# ----------------------------------------------------------------- dispatch --

func _run_job(job: Dictionary) -> void:
	var op: String = String(job.get("op", ""))
	var resp: Variant = await _execute(op, job.get("params", {}))
	if not (resp is Dictionary):
		resp = _err("internal error: op '%s' produced no response" % op)
	var out: Dictionary = resp
	out["id"] = job.get("id", null)
	out["op"] = op
	_requests_served += 1
	if not bool(out.get("ok", false)):
		_last_error = String(out.get("error", ""))
	_log("<- %s ok=%s" % [op, str(out.get("ok", false))])
	_send_raw(int(job.get("client", -1)), out)
	_busy = false
	_current_job = {}


func _execute(op: String, params: Dictionary) -> Dictionary:
	var result: Variant = null
	match op:
		# --- §2.3 required ops -------------------------------------------------
		"rt.info", "info":
			result = _op_info(params)
		"rt.scene_tree", "scene_tree":
			result = _op_scene_tree(params)
		"rt.get_node", "get_node":
			result = _op_get_node(params)
		"rt.get_property", "get_property":
			result = _op_get_property(params)
		"rt.set_property", "set_property":
			result = _op_set_property(params)
		"rt.call_method", "call_method":
			result = _op_call_method(params)
		"rt.screenshot", "screenshot":
			result = await _op_screenshot(params)
		"rt.input", "input":
			result = await _op_input(params)
		"rt.eval", "eval":
			result = await _op_eval(params)
		"rt.quit", "quit":
			result = _op_quit(params)
		# --- additive extras ---------------------------------------------------
		"rt.ping":
			result = _ok({"pong": true, "nonce": params.get("nonce", null), "port": port, "protocol": PROTOCOL})
		"rt.wait":
			result = await _op_wait(params)
		"rt.performance":
			result = _op_performance(params)
		"rt.freeze":
			result = _op_freeze(params)
		"rt.resume":
			result = _op_resume(params)
		"rt.step":
			result = await _op_step(params)
		"rt.digest":
			result = _op_digest(params)
		"rt.errors":
			result = _op_errors(params)
		"rt.act":
			result = await _op_act(params)
		"rt.ui":
			result = _op_ui(params)
		_:
			result = _err("unknown op: '%s'" % op)
	if not (result is Dictionary):
		return _err("internal error: op '%s' returned %s instead of a result dictionary" % [op, type_string(typeof(result))])
	return result


# ---------------------------------------------------------------------- ops --

func _op_info(_params: Dictionary) -> Dictionary:
	var version: Dictionary = Engine.get_version_info()
	var tree: SceneTree = get_tree()
	var scene: Node = tree.current_scene if tree != null else null
	var root: Window = tree.root if tree != null else null
	return _ok({
		"project_name": String(ProjectSettings.get_setting("application/config/name", "")),
		"project_path": ProjectSettings.globalize_path("res://"),
		"godot_version": String(version.get("string", "")),
		"godot_version_info": version,
		"scene": str(scene.get_path()) if scene != null else "",
		"scene_file": String(scene.scene_file_path) if scene != null else "",
		"node_count": _count_nodes(root) if root != null else 0,
		"fps": Engine.get_frames_per_second(),
		"frame": Engine.get_process_frames(),
		"physics_frame": Engine.get_physics_frames(),
		"paused": bool(tree.paused) if tree != null else false,
		"time_scale": Engine.time_scale,
		"frozen": _frozen,
		"freeze_mode": ("pause" if _freeze_hard else "time") if _frozen else "none",
		"auto_resumes": _auto_resumes,
		"error_count": _error_seq,
		"error_recorder": _recorder != null,
		"window_size": {"x": root.size.x, "y": root.size.y} if root != null else {"x": 0, "y": 0},
		"headless": _is_headless(),
		"display_driver": DisplayServer.get_name(),
		"runtime_port": port,
		"gate": _describe_gate(),
		"listening": listening,
		"protocol": PROTOCOL,
		"clients": _open_clients(),
		"requests_served": _requests_served,
		"uptime_ms": Time.get_ticks_msec() - _started_at,
		"last_error": _last_error,
		"os": OS.get_name(),
	})


func _op_scene_tree(params: Dictionary) -> Dictionary:
	var root: Node = get_tree().root
	var max_depth: int = int(params.get("max_depth", 64))
	if max_depth <= 0:
		max_depth = 64
	var with_properties: bool = bool(params.get("with_properties", false))
	return _ok({
		"tree": _build_tree(root, "", 0, max_depth, with_properties),
		"node_count": _count_nodes(root),
		"with_properties": with_properties,
	})


func _op_get_node(params: Dictionary) -> Dictionary:
	var node: Node = _find_node(params)
	if node == null:
		return _err("node not found: '%s'" % params.get("node_path", ""))
	var props: Dictionary = {}
	if bool(params.get("with_properties", true)):
		props = _editor_properties(node)
	var signals: Array = []
	for s in node.get_signal_list():
		signals.append(String(s.get("name", "")))
	var children: Array = []
	for child in node.get_children():
		children.append({"name": String(child.name), "type": child.get_class(), "path": str(child.get_path()), "child_count": child.get_child_count()})
	return _ok({
		"name": String(node.name),
		"type": node.get_class(),
		"path": str(node.get_path()),
		"scene_file_path": String(node.scene_file_path),
		"script": _script_path(node),
		"child_count": node.get_child_count(),
		"children": children,
		"groups": _to_string_array(node.get_groups()),
		"signals": signals,
		"properties": props,
		"visible": node is CanvasItem and (node as CanvasItem).is_visible_in_tree(),
		"process_mode": int(node.process_mode),
	})


func _op_get_property(params: Dictionary) -> Dictionary:
	var node: Node = _find_node(params)
	if node == null:
		return _err("node not found: '%s'" % params.get("node_path", ""))
	var prop: String = String(params.get("property", "")).strip_edges()
	if prop.is_empty():
		return _err("property is required")
	if not _has_property(node, prop):
		return _err("node '%s' (%s) has no property '%s'" % [node.name, node.get_class(), prop])
	var value: Variant = node.get(prop)
	return _ok({
		"node_path": str(node.get_path()),
		"property": prop,
		"value": _variant_to_json(value),
		"type": type_string(typeof(value)),
	})


func _op_set_property(params: Dictionary) -> Dictionary:
	var node: Node = _find_node(params)
	if node == null:
		return _err("node not found: '%s'" % params.get("node_path", ""))
	var prop: String = String(params.get("property", "")).strip_edges()
	if prop.is_empty():
		return _err("property is required")
	if not _has_property(node, prop):
		return _err("node '%s' (%s) has no property '%s'" % [node.name, node.get_class(), prop])
	if not params.has("value"):
		return _err("value is required (use null to reset)")
	var previous: Variant = node.get(prop)
	var value: Variant = _json_to_variant_for_property(node, prop, params["value"])
	if params.get("type_hint") is String and not String(params["type_hint"]).is_empty():
		value = _json_to_variant(params["value"], String(params["type_hint"]))
	node.set(prop, value)
	return _ok({
		"node_path": str(node.get_path()),
		"property": prop,
		"value": _variant_to_json(node.get(prop)),
		"previous": _variant_to_json(previous),
		"changed": str(node.get(prop)) != str(previous),
	})


func _op_call_method(params: Dictionary) -> Dictionary:
	var node: Node = _find_node(params)
	if node == null:
		return _err("node not found: '%s'" % params.get("node_path", ""))
	var method: String = String(params.get("method", "")).strip_edges()
	if method.is_empty():
		return _err("method is required")
	if not node.has_method(method):
		return _err("node '%s' (%s) has no method '%s'" % [node.name, node.get_class(), method])
	var args: Array = []
	if params.get("args") is Array:
		args = params["args"]
	var value: Variant = node.callv(method, args)
	return _ok({
		"node_path": str(node.get_path()),
		"method": method,
		"result": _variant_to_json(value),
		"arg_count": args.size(),
	})


func _op_screenshot(params: Dictionary) -> Dictionary:
	if _is_headless():
		# The dummy renderer has no framebuffer; fail early instead of letting
		# the render server log a null-texture error.
		return _err("rt.screenshot needs a real display driver; the headless dummy renderer has no framebuffer (run the game without --headless)")
	var viewport: Viewport = get_viewport()
	if viewport == null:
		return _err("no viewport available")
	# 必须等到帧真正画完再取图：只 await process_frame 会拿到上一帧（甚至更旧的）
	# 缓冲 —— 表现是「同一张图连拍两次字节完全相同」或「迷宫是新的、HUD 是旧的」，
	# 极易被误判成渲染 bug。frame_post_draw 只在真显示驱动下发出，headless 上面已挡掉。
	await RenderingServer.frame_post_draw
	var texture: ViewportTexture = viewport.get_texture()
	if texture == null:
		return _err("viewport has no texture (headless rendering has no framebuffer); run the game with a real display driver")
	var image: Image = texture.get_image()
	if image == null:
		return _err("viewport texture returned no image (not rendered yet?)")

	var width: int = image.get_width()
	var height: int = image.get_height()
	var png: PackedByteArray = image.save_png_to_buffer()
	var out_path: String = String(params.get("path", "")).strip_edges()
	# 给了 path 就落盘，并且默认不再回 base64 —— 一张 PNG 的 base64 动辄上千 token，
	# 而调用方通常只需要一个能直接打开的文件路径。要 base64 就显式 inline=true。
	var want_inline: bool = bool(params.get("inline", out_path.is_empty()))
	var result: Dictionary = {
		"format": "png",
		"width": width,
		"height": height,
		"bytes": png.size(),
		"headless": false,
		"captured_frame": Engine.get_process_frames(),
	}
	if not out_path.is_empty():
		var write_err := image.save_png(out_path)
		if write_err != OK:
			return _err("cannot write screenshot to '%s' (error %d); use an absolute path or user://" % [out_path, write_err])
		result["saved"] = ProjectSettings.globalize_path(out_path) if out_path.begins_with("user://") else out_path
	if want_inline:
		# 只回一个 base64 字段。曾经同时回 base64 / png_base64 / data_uri，
		# 三者是同一份数据的三种写法 —— 而截图动辄几十上百 KB，
		# 一份 base64 在工具结果里就是上千 token，重复三份纯属浪费。
		# 需要 data URI 的调用方自行拼 "data:image/png;base64," + png_base64。
		result["png_base64"] = Marshalls.raw_to_base64(png)
	return _ok(result)


func _op_input(params: Dictionary) -> Dictionary:
	var type: String = String(params.get("type", "")).strip_edges().to_lower()
	if type.is_empty():
		if params.has("action"):
			type = "action"
		elif params.has("key") or params.has("keycode"):
			type = "key"
		elif params.has("relative_x") or params.has("relative_y"):
			type = "mouse_motion"
		elif params.has("x") or params.has("y"):
			type = "mouse_button"
	match type:
		"action":
			return await _input_action(params)
		"key", "key_press":
			return await _input_key(params)
		"mouse_button", "click", "mouse":
			return await _input_mouse_button(params)
		"mouse_motion", "mousemove", "mouse_move":
			return _input_mouse_motion(params)
		"text":
			return _input_text(params)
		_:
			return _err("unsupported input type '%s' (use action, key, mouse_button, mouse_motion or text)" % type)


func _input_action(params: Dictionary) -> Dictionary:
	var action: String = String(params.get("action", "")).strip_edges()
	if action.is_empty():
		return _err("action is required")
	var strength: float = float(params.get("strength", 1.0))
	var has_pressed: bool = params.has("pressed")
	var pressed: bool = bool(params.get("pressed", true))
	if has_pressed and not pressed:
		Input.action_release(action)
		return _ok({"injected": "action_release", "action": action})
	Input.action_press(action, strength)
	if has_pressed:
		return _ok({"injected": "action_press", "action": action, "strength": strength})
	# tap: release on the next frame
	await get_tree().process_frame
	Input.action_release(action)
	return _ok({"injected": "action_tap", "action": action, "strength": strength})


func _input_key(params: Dictionary) -> Dictionary:
	var key_name: String = String(params.get("key", "")).strip_edges()
	var keycode: int = int(params.get("keycode", 0))
	if keycode == 0 and not key_name.is_empty():
		keycode = _keycode_from_string(key_name)
	if keycode == 0:
		return _err("unknown key '%s' (pass a Godot key name such as 'A', 'SPACE', 'ESCAPE' or an integer keycode)" % key_name)
	var has_pressed: bool = params.has("pressed")
	var pressed: bool = bool(params.get("pressed", true))
	var echo: bool = bool(params.get("echo", false))

	var event := InputEventKey.new()
	event.keycode = keycode as Key
	event.physical_keycode = keycode as Key
	event.unicode = int(params.get("unicode", _unicode_for_key(keycode)))
	event.pressed = pressed
	event.echo = echo
	event.shift_pressed = bool(params.get("shift", false))
	event.ctrl_pressed = bool(params.get("ctrl", false))
	event.alt_pressed = bool(params.get("alt", false))
	event.meta_pressed = bool(params.get("meta", false))
	Input.parse_input_event(event)

	if has_pressed:
		return _ok({"injected": "key", "key": key_name, "keycode": keycode, "pressed": pressed})
	await get_tree().process_frame
	var release := InputEventKey.new()
	release.keycode = keycode as Key
	release.physical_keycode = keycode as Key
	release.pressed = false
	Input.parse_input_event(release)
	return _ok({"injected": "key_tap", "key": key_name, "keycode": keycode})


func _input_mouse_button(params: Dictionary) -> Dictionary:
	var x: float = float(params.get("x", 0.0))
	var y: float = float(params.get("y", 0.0))
	var button: int = _mouse_button_from_value(params.get("button", 1))
	var has_pressed: bool = params.has("pressed")
	var pressed: bool = bool(params.get("pressed", true))
	var position: Vector2 = Vector2(x, y)

	var event := InputEventMouseButton.new()
	event.position = position
	event.global_position = position
	event.button_index = button as MouseButton
	event.button_mask = (1 << (button - 1)) if pressed else 0
	event.pressed = pressed
	event.double_click = bool(params.get("double_click", false))
	event.factor = float(params.get("factor", 1.0))
	Input.parse_input_event(event)

	if has_pressed:
		return _ok({"injected": "mouse_button", "button": button, "pressed": pressed, "position": {"x": x, "y": y}})
	await get_tree().process_frame
	var release := InputEventMouseButton.new()
	release.position = position
	release.global_position = position
	release.button_index = button as MouseButton
	release.button_mask = 0
	release.pressed = false
	Input.parse_input_event(release)
	return _ok({"injected": "mouse_click", "button": button, "position": {"x": x, "y": y}})


func _input_mouse_motion(params: Dictionary) -> Dictionary:
	var x: float = float(params.get("x", 0.0))
	var y: float = float(params.get("y", 0.0))
	var rx: float = float(params.get("relative_x", 0.0))
	var ry: float = float(params.get("relative_y", 0.0))
	var event := InputEventMouseMotion.new()
	event.position = Vector2(x, y)
	event.global_position = Vector2(x, y)
	event.relative = Vector2(rx, ry)
	event.button_mask = int(params.get("button_mask", 0))
	Input.parse_input_event(event)
	return _ok({"injected": "mouse_motion", "position": {"x": x, "y": y}, "relative": {"x": rx, "y": ry}})


func _input_text(params: Dictionary) -> Dictionary:
	var text: String = String(params.get("text", ""))
	if text.is_empty():
		return _err("text is required")
	for i in text.length():
		var event := InputEventKey.new()
		event.unicode = text.unicode_at(i)
		event.pressed = true
		Input.parse_input_event(event)
		var release := InputEventKey.new()
		release.unicode = text.unicode_at(i)
		release.pressed = false
		Input.parse_input_event(release)
	return _ok({"injected": "text", "text": text, "length": text.length()})


func _op_eval(params: Dictionary) -> Dictionary:
	var source: String = String(params.get("source", params.get("code", "")))
	if source.strip_edges().is_empty():
		return _err("source is required")
	var is_full: bool = source.strip_edges().begins_with("extends")
	var code: String = source if is_full else EVAL_WRAPPER_HEAD + _indent(source)

	var script := GDScript.new()
	script.source_code = code
	var err: int = script.reload()
	if err != OK:
		var failed: Dictionary = _err("GDScript failed to compile (error %d); the failing line is reported in the engine log" % err)
		failed["data"] = {"source": code}
		return failed
	var instance: Variant = script.new()
	if instance == null:
		return _err("script.new() returned null")

	var is_node: bool = instance is Node
	if is_node:
		instance.process_mode = Node.PROCESS_MODE_ALWAYS
		add_child(instance)

	var state: Array = [false, null]
	_launch_eval(state, instance)
	var timeout_ms: int = int(params.get("timeout_ms", EVAL_TIMEOUT_MSEC))
	var finished: bool = await _await_completion(state, timeout_ms)

	var data: Dictionary = {
		"finished": finished,
		"timed_out": not finished,
		"wrapped": not is_full,
	}
	if finished:
		data["result"] = _variant_to_json(state[1])
		data["mcp_result"] = data["result"]
		data["returned"] = state[1] != null
		if is_node and is_instance_valid(instance):
			instance.queue_free()
	else:
		data["error_detail"] = "the coroutine is still running in the game; increase timeout_ms if the source awaits a long signal"
	if bool(params.get("echo_source", false)):
		data["source"] = code
	return _ok(data)


func _op_wait(params: Dictionary) -> Dictionary:
	var frames: int = int(params.get("frames", 1))
	if frames < 0:
		frames = 0
	for i in frames:
		await get_tree().process_frame
	return _ok({"waited_frames": frames, "frame": Engine.get_process_frames()})


func _op_performance(_params: Dictionary) -> Dictionary:
	return _ok({
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"process_time": Performance.get_monitor(Performance.TIME_PROCESS),
		"physics_process_time": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS),
		"static_memory": Performance.get_monitor(Performance.MEMORY_STATIC),
		"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
		"node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"orphan_node_count": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
		"render_objects": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
		"render_draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
	})


# ---------------------------------------------------------------------------- 时间控制
#
# 为什么需要这一组：让「观察」永远不和「游戏推进」抢跑。
#   freeze → digest → step → digest → ...
# 每一步之间的状态完全静止，所以断言不会因为多跑了几帧而飘。
#
# 实现上的两个硬约束（都是踩过的）：
#   1. **绝对不能用 SceneTreeTimer**。create_timer 走的是缩放后的时间，
#      time_scale=0 时它永远不会触发，await 会一直挂到客户端超时。
#      所以推进只能用 `await get_tree().process_frame`。
#   2. 冻结时 delta 恒为 0，游戏实际上不会前进；因此 step 期间必须把
#      time_scale 临时恢复成可推进的值，推进完再还原。

const STEP_MAX_FRAMES: int = 1800        # 30 秒 @60fps，留出客户端超时余量
const STEP_MAX_MS: float = 30_000.0
const STEP_DEFAULT_UNTIL_FRAMES: int = 600
## until 表达式里可以直接用的名字。Expression 看不到全局单例，只能显式传。
const UNTIL_INPUT_NAMES: Array = [
	"tree", "node", "self", "Engine", "Input", "Performance", "OS", "Time", "ProjectSettings",
]
## 冻着且没有任何客户端连着超过这个时长，就自动解冻。
## 理由：冻结会把游戏停住，如果客户端崩了/断了，用户看到的就是一个「卡死的游戏」，
## 而且他自己没有任何办法解冻。宁可自动松手。
const FREEZE_IDLE_RESUME_MS: int = 120_000

var _saved_time_scale: float = 1.0
var _saved_paused: bool = false
var _frozen: bool = false
var _freeze_hard: bool = true
var _frozen_at_ms: int = 0
var _auto_resumes: int = 0


## 冻结游戏。
##   mode="pause"（默认）：get_tree().paused = true + time_scale = 0
##       —— 连 _process 都不再被调用，是真正的「观察不会和推进抢跑」。
##   mode="time"：只把 time_scale 置 0
##       —— _process 仍会每帧调用（delta=0）。适合想保留渲染/动画但停住模拟，
##          或者游戏自己管理 paused 语义、你不想抢它的 paused 标志。
func _op_freeze(params: Dictionary) -> Dictionary:
	var mode: String = String(params.get("mode", "pause")).strip_edges().to_lower()
	if mode != "time":
		mode = "pause"
	if not _frozen:
		_saved_time_scale = Engine.time_scale
		_saved_paused = get_tree().paused
		_freeze_hard = mode == "pause"
		_frozen = true
		_frozen_at_ms = Time.get_ticks_msec()
	Engine.time_scale = 0.0
	if _freeze_hard:
		get_tree().paused = true
	return _ok({
		"frozen": true,
		"mode": mode,
		"time_scale": Engine.time_scale,
		"paused": get_tree().paused,
		"previous_time_scale": _saved_time_scale,
		"previous_paused": _saved_paused,
		"frame": Engine.get_process_frames(),
		"note": "用 rt.step 推进、rt.resume 恢复。冻结期间不要依赖 SceneTreeTimer（它走缩放时间，不会触发）。",
	})


func _op_resume(_params: Dictionary) -> Dictionary:
	_unfreeze()
	return _ok({
		"frozen": false,
		"time_scale": Engine.time_scale,
		"paused": get_tree().paused,
		"frame": Engine.get_process_frames(),
		"auto_resumes": _auto_resumes,
	})


func _unfreeze() -> void:
	_frozen = false
	Engine.time_scale = _saved_time_scale
	if _freeze_hard:
		get_tree().paused = _saved_paused


## 冻结看门狗：没人连着又冻太久就自动解冻，避免用户拿到一个永远卡住的游戏。
func _freeze_watchdog() -> void:
	if not _frozen:
		return
	if Time.get_ticks_msec() - _frozen_at_ms < FREEZE_IDLE_RESUME_MS:
		return
	if _open_clients() > 0:
		_frozen_at_ms = Time.get_ticks_msec()
		return
	_auto_resumes += 1
	_unfreeze()
	print("[godot-mcp] 冻结超过 %d 秒且无客户端连接，已自动解冻（rt.resume 可手动恢复）" % (FREEZE_IDLE_RESUME_MS / 1000))


func _until_input_names() -> Array:
	return UNTIL_INPUT_NAMES


func _until_inputs() -> Array:
	return [
		get_tree(), self, self, Engine, Input, Performance, OS, Time, ProjectSettings,
	]


func _op_step(params: Dictionary) -> Dictionary:
	var until: String = String(params.get("until", "")).strip_edges()
	var want_frames: int = int(params.get("frames", 0))
	var want_ms: float = float(params.get("ms", 0.0))
	if want_frames > STEP_MAX_FRAMES or want_ms > STEP_MAX_MS:
		return _err("step 超出上限（frames<=%d, ms<=%.0f）；要推进更长的时间请分多次调用" % [STEP_MAX_FRAMES, STEP_MAX_MS])

	var budget_frames: int = STEP_MAX_FRAMES
	var budget_ms: float = STEP_MAX_MS
	if not until.is_empty():
		# step-until 必须有上限，否则条件永不成立时会一直转到客户端超时
		var max_frames: int = int(params.get("max_frames", STEP_DEFAULT_UNTIL_FRAMES))
		var max_ms: float = float(params.get("max_ms", float(STEP_DEFAULT_UNTIL_FRAMES) * 16.7))
		budget_frames = clampi(max_frames if max_frames > 0 else STEP_DEFAULT_UNTIL_FRAMES, 1, STEP_MAX_FRAMES)
		budget_ms = clampf(max_ms if max_ms > 0.0 else float(budget_frames) * 16.7, 1.0, STEP_MAX_MS)
	elif want_frames > 0:
		budget_frames = clampi(want_frames, 1, STEP_MAX_FRAMES)
	elif want_ms > 0.0:
		budget_ms = clampf(want_ms, 0.1, STEP_MAX_MS)
	else:
		budget_frames = 1

	var expr: Expression = null
	if not until.is_empty():
		expr = Expression.new()
		# Expression 的解析器**看不到 Engine / Input 这类全局单例**（实测报
		# "Invalid named index 'Engine' for base type Object"），必须把它们当显式
		# 输入传进去。base_instance 传桥节点本身，这样 `self` 也能写。
		var perr: int = expr.parse(until, _until_input_names())
		if perr != OK:
			return _err("until 表达式解析失败：%s\n表达式：%s\n可用输入：%s" % [expr.get_error_text(), until, ", ".join(_until_input_names())])

	var errors_at_start: int = _error_seq
	var progressed_frames: int = 0
	var progressed_ms: float = 0.0
	var satisfied: bool = until.is_empty()
	var saved: float = Engine.time_scale
	var was_frozen: bool = _frozen
	var was_hard: bool = _freeze_hard
	# 推进期间必须两样都放开：time_scale 归 0 会让 delta 恒为 0，
	# paused=true 则连 _process 都不会被调用 —— 那样「走一帧」是不成立的。
	var advance_scale: float = _saved_time_scale if was_frozen else saved
	if advance_scale <= 0.0:
		advance_scale = 1.0
	Engine.time_scale = advance_scale
	if was_frozen and was_hard:
		get_tree().paused = false

	var started_ms: int = Time.get_ticks_msec()
	while progressed_frames < budget_frames and progressed_ms < budget_ms:
		await get_tree().process_frame
		progressed_frames += 1
		# get_process_delta_time() 返回的已经是缩放后的 delta，不要再乘一次
		progressed_ms += get_process_delta_time() * 1000.0
		if expr != null:
			var value: Variant = expr.execute(_until_inputs(), self, false)
			if expr.has_execute_failed():
				Engine.time_scale = saved
				if was_frozen and was_hard:
					get_tree().paused = true
				return _err("until 表达式执行失败：%s\n表达式：%s" % [expr.get_error_text(), until])
			if bool(value):
				satisfied = true
				break

	Engine.time_scale = saved
	if was_frozen and was_hard:
		get_tree().paused = true
	var result: Dictionary = {
		"frames": progressed_frames,
		"ms": snappedf(progressed_ms, 0.01),
		"wall_ms": Time.get_ticks_msec() - started_ms,
		"frozen": _frozen,
		"paused": get_tree().paused,
		"time_scale": Engine.time_scale,
		"frame": Engine.get_process_frames(),
		"mode": "until" if expr != null else ("frames" if want_frames > 0 else "ms"),
	}
	if expr != null:
		result["until"] = until
		result["satisfied"] = satisfied
	result["errors_new"] = _error_seq - errors_at_start
	result["errors_total"] = _error_seq
	return _ok(result)


# ---------------------------------------------------------------------------- 运行时错误捕获
#
# 为什么必须有这个：改完一段 GDScript 之后，「它有没有炸」是 agent 最该立刻知道的事，
# 而现在唯一能看到错误的途径是游戏进程的 stdout —— 那要人去翻会话日志，而且
# 「哪一行、调用链是什么」在里面是糊的。
#
# 实现走 `OS.add_logger(Logger)`：引擎把每一条错误（含脚本运行时错误）都送进
# `_log_error()`，并且带上真实的 ScriptBacktrace。
#
# 一个必须知道的细节：`file`/`line` 对 push_error 来说指向的是**引擎内部**位置
# （实测是 core/variant/variant_utility.cpp:1023），真正属于用户脚本的位置只在
# backtrace 里。所以定位优先取 backtrace 里第一个 res:// 帧。

const ERROR_RING: int = 300
const ACT_MAX_STEPS: int = 64

var _errors: Array = []
var _error_seq: int = 0
var _errors_dropped: int = 0
var _recorder: ErrorRecorder = null


class ErrorRecorder:
	extends Logger
	var bridge: Node = null

	func _log_error(function: String, file: String, line: int, code: String, rationale: String,
			_editor_notify: bool, error_type: int, script_backtraces: Array) -> void:
		if bridge != null:
			bridge._record_error(function, file, line, code, rationale, error_type, script_backtraces)


func _install_error_recorder() -> void:
	if _recorder != null or not OS.has_method("add_logger"):
		return
	_recorder = ErrorRecorder.new()
	_recorder.bridge = self
	OS.add_logger(_recorder)


func _error_type_name(error_type: int) -> String:
	match error_type:
		1:
			return "warning"
		2:
			return "script"
		3:
			return "shader"
		_:
			return "error"


func _backtrace_frames(backtraces: Array) -> Array:
	var frames: Array = []
	for bt in backtraces:
		if bt == null:
			continue
		for i in bt.get_frame_count():
			frames.append({
				"function": String(bt.get_frame_function(i)),
				"file": String(bt.get_frame_file(i)),
				"line": int(bt.get_frame_line(i)),
			})
	return frames


func _record_error(function: String, file: String, line: int, code: String, rationale: String,
		error_type: int, backtraces: Array) -> void:
	var frames: Array = _backtrace_frames(backtraces)
	var where := {"function": function, "file": file, "line": line}
	for frame in frames:
		var f: String = String(frame["file"])
		if f.begins_with("res://") or f.begins_with("user://"):
			where = frame
			break
	var entry: Dictionary = {
		"seq": _error_seq,
		"at_ms": Time.get_ticks_msec() - _started_at,
		"frame": Engine.get_process_frames(),
		"type": _error_type_name(error_type),
		"error_type": error_type,
		"code": code,
		"rationale": rationale,
		"function": String(where["function"]),
		"file": String(where["file"]),
		"line": int(where["line"]),
		"backtrace": frames,
	}
	_error_seq += 1
	_errors.append(entry)
	if _errors.size() > ERROR_RING:
		_errors = _errors.slice(_errors.size() - ERROR_RING)
		_errors_dropped += 1


func _op_errors(params: Dictionary) -> Dictionary:
	if bool(params.get("clear", false)):
		var cleared: int = _errors.size()
		_errors.clear()
		_errors_dropped = 0
		return _ok({"cleared": cleared, "total": _error_seq, "next_since": _error_seq - 1})

	var since: int = int(params.get("since", -1))
	var limit: int = clampi(int(params.get("limit", 50)), 1, ERROR_RING)
	var want_type: String = String(params.get("type", "")).strip_edges().to_lower()
	var out: Array = []
	for e in _errors:
		if since >= 0 and int(e["seq"]) <= since:
			continue
		if not want_type.is_empty() and String(e["type"]) != want_type:
			continue
		out.append(e)
	var truncated: bool = out.size() > limit
	if truncated:
		out = out.slice(out.size() - limit)
	var result: Dictionary = {
		"errors": out,
		"returned": out.size(),
		"total": _error_seq,
		"dropped": _errors_dropped,
		"next_since": _error_seq - 1,
		"truncated": truncated,
		"recorder": _recorder != null,
	}
	if _recorder == null:
		result["note"] = "本引擎不支持 OS.add_logger，无法捕获运行时错误；只能看会话 stdout"
	return _ok(result)


# ---------------------------------------------------------------------------- UI 与输入序列
#
# 单次 rt.input 不够用：真实操作是「按下 → 等两帧 → 松开 → 点按钮 → 再等」，
# 而每一步之后游戏变成什么样，调用方需要立刻看到。所以把序列和观测合到一个 op 里：
# 一次调用执行整串操作，逐步回报「这一步之后我关心的节点是什么状态」。

func _ui_pick(x: float, y: float) -> Control:
	# 先序 + 子节点倒序入栈 = 画在最上面的控件最先被检查
	var stack: Array = [get_tree().root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		if n is Control:
			var c := n as Control
			if c.is_visible_in_tree() and c.mouse_filter != Control.MOUSE_FILTER_IGNORE 					and c.get_global_rect().has_point(Vector2(x, y)):
				return c
		var kids: Array = n.get_children()
		for i in range(kids.size() - 1, -1, -1):
			stack.append(kids[i])
	return null


func _describe_control(c: Control) -> Dictionary:
	var r: Rect2 = c.get_global_rect()
	var out: Dictionary = {
		"path": str(c.get_path()),
		"name": String(c.name),
		"class": c.get_class(),
		"rect": {"x": snappedf(r.position.x, 0.1), "y": snappedf(r.position.y, 0.1), "w": snappedf(r.size.x, 0.1), "h": snappedf(r.size.y, 0.1)},
		"visible": c.is_visible_in_tree(),
		"mouse_filter": c.mouse_filter,
	}
	if _has_property(c, "text"):
		out["text"] = String(c.text)
	if _has_property(c, "disabled"):
		out["disabled"] = bool(c.disabled)
	if _has_property(c, "button_pressed"):
		out["button_pressed"] = bool(c.button_pressed)
	return out


func _op_ui(params: Dictionary) -> Dictionary:
	var limit: int = clampi(int(params.get("limit", 64)), 1, 512)
	var include_hidden: bool = bool(params.get("include_hidden", false))
	var out: Array = []
	var stack: Array = [get_tree().root]
	while not stack.is_empty() and out.size() < limit:
		var n: Node = stack.pop_back()
		if n is Control:
			var c := n as Control
			if (include_hidden or c.is_visible_in_tree()) and c.mouse_filter != Control.MOUSE_FILTER_IGNORE:
				out.append(_describe_control(c))
		var kids: Array = n.get_children()
		for i in range(kids.size() - 1, -1, -1):
			stack.append(kids[i])
	return _ok({
		"count": out.size(),
		"truncated": out.size() >= limit,
		"frame": Engine.get_process_frames(),
		"controls": out,
	})


func _advance_frames(count: int) -> Dictionary:
	var f: int = 0
	var ms: float = 0.0
	while f < count:
		await get_tree().process_frame
		f += 1
		ms += get_process_delta_time() * 1000.0
	return {"frames": f, "ms": ms}


func _resolve_watch(selectors: Array) -> Array:
	var out: Array = []
	var seen: Dictionary = {}
	for raw in selectors:
		var sel: String = String(raw)
		if sel.begins_with("group:"):
			var g: String = sel.substr(6)
			if get_tree().has_group(g):
				for n in get_tree().get_nodes_in_group(g):
					if not seen.has(n.get_instance_id()):
						seen[n.get_instance_id()] = true
						out.append(n)
			continue
		var node: Node = _find_node({"path": sel, "node_path": sel})
		if node != null and not seen.has(node.get_instance_id()):
			seen[node.get_instance_id()] = true
			out.append(node)
	return out


func _watch_snapshot(nodes: Array, extra_props: Array) -> Array:
	if nodes.is_empty():
		return []
	var wanted: Array = []
	wanted.append_array(extra_props)
	for p in ["position", "rotation", "visible", "text", "value", "disabled"]:
		if not wanted.has(p):
			wanted.append(p)
	var out: Array = []
	for n in nodes:
		if n == null or not is_instance_valid(n):
			continue
		out.append(_digest_node(n, wanted))
	return out


func _op_act(params: Dictionary) -> Dictionary:
	var steps: Variant = params.get("steps", [])
	if not (steps is Array) or (steps as Array).is_empty():
		return _err("steps 必须是非空数组，每项形如 {type:'tap', action:'ui_accept'}")
	if (steps as Array).size() > ACT_MAX_STEPS:
		return _err("steps 最多 %d 步（一次调用做太多会顶穿客户端超时）" % ACT_MAX_STEPS)

	var step_list: Array = steps
	var frames_per_step: int = clampi(int(params.get("frames_per_step", 1)), 0, 120)
	var continue_on_error: bool = bool(params.get("continue_on_error", false))
	var watch_props: Array = _string_list(params.get("watch_props", []))
	var watched: Array = _resolve_watch(_string_list(params.get("watch", [])))

	var errors_before: int = _error_seq
	var total_frames: int = 0
	var total_ms: float = 0.0
	var started: int = Time.get_ticks_msec()
	var report: Array = []
	var aborted: bool = false

	# 输入只有在「没被暂停」时才可能被处理：paused 下可暂停节点的 _input/_process
	# 都不会被调用。所以序列期间临时解冻，跑完再冻回去 —— 否则会出现
	# 「按键注入了但游戏没反应」这种最难查的现象。
	var was_frozen: bool = _frozen
	var was_hard: bool = _freeze_hard
	if was_frozen:
		var scale_now: float = _saved_time_scale if _saved_time_scale > 0.0 else 1.0
		Engine.time_scale = scale_now
		if was_hard:
			get_tree().paused = false

	var initial: Array = _watch_snapshot(watched, watch_props)

	for i in range(step_list.size()):
		var raw: Variant = step_list[i]
		var step: Dictionary = raw if raw is Dictionary else {}
		var entry: Dictionary = await _act_step(step, frames_per_step)
		entry["index"] = i
		entry["after"] = _watch_snapshot(watched, watch_props)
		report.append(entry)
		total_frames += int(entry.get("frames", 0))
		total_ms += float(entry.get("ms", 0.0))
		if not bool(entry.get("ok", true)) and not continue_on_error:
			aborted = true
			break

	if was_frozen:
		Engine.time_scale = 0.0
		if was_hard:
			get_tree().paused = true

	return _ok({
		"steps": report,
		"executed": report.size(),
		"planned": step_list.size(),
		"aborted": aborted,
		"frames": total_frames,
		"ms": snappedf(total_ms, 0.01),
		"wall_ms": Time.get_ticks_msec() - started,
		"initial": initial,
		"watched": watched.size(),
		"frozen": _frozen,
		"errors": {"new": _error_seq - errors_before, "total": _error_seq},
	})


func _act_step(step: Dictionary, frames_default: int) -> Dictionary:
	var type: String = String(step.get("type", step.get("action", ""))).strip_edges().to_lower()
	var out: Dictionary = {"type": type, "ok": true, "frames": 0, "ms": 0.0}
	var pre_frames: int = 0
	var pre_ms: float = 0.0

	match type:
		"wait", "":
			pass
		"press", "release", "tap":
			var pressed: bool = type != "release"
			var released: bool = type != "press"
			var action_name: String = String(step.get("action_name", step.get("action", ""))).strip_edges()
			if not action_name.is_empty() and action_name != type:
				if pressed:
					Input.action_press(action_name, float(step.get("strength", 1.0)))
				else:
					Input.action_release(action_name)
				out["injected"] = {"kind": "action", "action": action_name, "pressed": pressed}
			else:
				var keycode: int = int(step.get("keycode", 0))
				if keycode == 0:
					keycode = _keycode_from_string(String(step.get("key", "")).strip_edges())
				if keycode == 0:
					return {"type": type, "ok": false, "frames": 0, "ms": 0.0, "error": "需要 action 或 key/keycode"}
				_press_key(keycode, pressed)
				out["injected"] = {"kind": "key", "keycode": keycode, "pressed": pressed}
				if released and pressed:
					# tap：按下去、放一帧让它被派发、再松开
					var gap: Dictionary = await _advance_frames(1)
					pre_frames += int(gap["frames"])
					pre_ms += float(gap["ms"])
					_press_key(keycode, false)
		"move":
			var before := _mouse_position()
			var rel_x := float(step.get("relative_x", 0.0))
			var rel_y := float(step.get("relative_y", 0.0))
			var ev := InputEventMouseMotion.new()
			ev.relative = Vector2(rel_x, rel_y)
			if step.has("x") or step.has("y"):
				var target := Vector2(float(step.get("x", before.x)), float(step.get("y", before.y)))
				ev.position = target
				ev.global_position = target
				ev.relative = target - before
				DisplayServer.warp_mouse(target)
			else:
				ev.position = before + Vector2(rel_x, rel_y)
				ev.global_position = ev.position
			Input.parse_input_event(ev)
			out["injected"] = {"kind": "mouse_motion", "from": {"x": before.x, "y": before.y}, "relative": {"x": ev.relative.x, "y": ev.relative.y}}
		"click":
			var point := Vector2(float(step.get("x", 0.0)), float(step.get("y", 0.0)))
			var target_control: Control = null
			if step.has("node"):
				var n: Node = _find_node({"path": String(step.get("node", "")), "node_path": String(step.get("node", ""))})
				if n is Control:
					target_control = n as Control
					point = target_control.get_global_rect().get_center()
				else:
					return {"type": type, "ok": false, "frames": 0, "ms": 0.0, "error": "node 不是 Control：%s" % String(step.get("node", ""))}
			elif not step.has("x") and not step.has("y"):
				return {"type": type, "ok": false, "frames": 0, "ms": 0.0, "error": "click 需要 x/y 或 node"}
			else:
				target_control = _ui_pick(point.x, point.y)
			var button: int = int(step.get("button", MOUSE_BUTTON_LEFT))
			var hit := _ui_pick(point.x, point.y)
			if hit != null:
				out["hit"] = _describe_control(hit)
			DisplayServer.warp_mouse(point)
			for press_state in [true, false]:
				var mb := InputEventMouseButton.new()
				mb.button_index = button
				mb.pressed = press_state
				mb.position = point
				mb.global_position = point
				Input.parse_input_event(mb)
				await _advance_frames(1)
			out["injected"] = {"kind": "click", "x": point.x, "y": point.y, "button": button}
			if target_control != null and target_control != hit:
				out["target"] = _describe_control(target_control)
		"text":
			var text: String = String(step.get("text", ""))
			if text.is_empty():
				return {"type": type, "ok": false, "frames": 0, "ms": 0.0, "error": "text 不能为空"}
			for ch in text:
				var ev := InputEventKey.new()
				ev.pressed = true
				ev.unicode = String(ch).unicode_at(0)
				ev.keycode = 0
				Input.parse_input_event(ev)
			out["injected"] = {"kind": "text", "length": text.length()}
		"call":
			var node_arg: String = String(step.get("node", step.get("node_path", "")))
			var method: String = String(step.get("method", ""))
			var target: Node = _find_node({"path": node_arg, "node_path": node_arg})
			if target == null:
				return {"type": type, "ok": false, "frames": 0, "ms": 0.0, "error": "node 不存在：%s" % node_arg}
			if not target.has_method(method):
				return {"type": type, "ok": false, "frames": 0, "ms": 0.0, "error": "node 没有方法 %s" % method}
			var args: Array = step.get("args", [])
			var value: Variant = target.callv(method, args)
			out["injected"] = {"kind": "call", "node": node_arg, "method": method}
			out["result"] = _variant_to_json(value)
		_:
			return {"type": type, "ok": false, "frames": 0, "ms": 0.0, "error": "不支持的步骤类型 '%s'（wait/press/release/tap/move/click/text/call）" % type}

	# 每个步骤默认推进一帧：事件要跨帧才会被引擎派发，不推进等于没注入
	var advance: int = frames_default
	var until_ms: float = -1.0
	if type == "wait":
		if step.has("ms"):
			until_ms = clampf(float(step.get("ms", 0.0)), 0.0, STEP_MAX_MS)
		else:
			advance = clampi(int(step.get("frames", 1)), 0, STEP_MAX_FRAMES)
	var taken: Dictionary
	if until_ms >= 0.0:
		taken = await _advance_until_ms(until_ms)
	else:
		taken = await _advance_frames(advance)
	out["frames"] = pre_frames + int(taken["frames"])
	out["ms"] = snappedf(pre_ms + float(taken["ms"]), 0.01)
	return out


func _advance_until_ms(target_ms: float) -> Dictionary:
	var f: int = 0
	var ms: float = 0.0
	var budget: float = clampf(target_ms, 0.0, STEP_MAX_MS)
	while ms < budget and f < STEP_MAX_FRAMES:
		await get_tree().process_frame
		f += 1
		ms += get_process_delta_time() * 1000.0
	return {"frames": f, "ms": ms}


func _press_key(keycode: int, pressed: bool) -> void:
	var ev := InputEventKey.new()
	ev.keycode = keycode
	ev.physical_keycode = keycode
	ev.pressed = pressed
	Input.parse_input_event(ev)


func _mouse_position() -> Vector2:
	return get_viewport().get_mouse_position() if get_viewport() != null else Vector2.ZERO


# ---------------------------------------------------------------------------- 状态 digest
#
# 截图是最后手段，不是第一手段：一张图的 token 成本顶得上一整棵树的数字状态，
# 而且「位置差了几个像素」这种问题在图里根本看不出来。digest 把节点状态直接
# 变成结构化 JSON，让 agent 用数字断言而不是看图猜。

const DIGEST_DEFAULT_PROPS: Array = [
	"position", "global_position", "rotation", "scale", "visible", "modulate",
	"velocity", "text", "value", "current_animation", "playing",
]


func _op_digest(params: Dictionary) -> Dictionary:
	var limit: int = clampi(int(params.get("limit", 32)), 1, 512)
	var groups: Array = _string_list(params.get("groups", []))
	var paths: Array = _string_list(params.get("paths", []))
	var classes: Array = _string_list(params.get("classes", []))
	var extra: Array = _string_list(params.get("props", []))

	var wanted: Array = []
	wanted.append_array(extra)
	for p in DIGEST_DEFAULT_PROPS:
		if not wanted.has(p):
			wanted.append(p)

	var nodes: Array = _collect_digest_nodes(groups, paths, classes, limit)
	var out: Array = []
	for n in nodes:
		out.append(_digest_node(n, wanted))

	var unknown_groups: Array = []
	for g in groups:
		if not get_tree().has_group(String(g)):
			unknown_groups.append(String(g))

	var result: Dictionary = {
		"frame": Engine.get_process_frames(),
		"time_scale": Engine.time_scale,
		"frozen": _frozen,
		"count": out.size(),
		"truncated": nodes.size() >= limit,
		"selector": {"groups": groups, "paths": paths, "classes": classes},
		"nodes": out,
	}
	if not unknown_groups.is_empty():
		result["missing_groups"] = unknown_groups
	return _ok(result)


func _string_list(raw: Variant) -> Array:
	var out: Array = []
	if raw is Array:
		for v in raw:
			out.append(String(v))
	elif raw is String and not String(raw).is_empty():
		out.append(String(raw))
	elif raw is PackedStringArray:
		for v in raw:
			out.append(String(v))
	return out


func _collect_digest_nodes(groups: Array, paths: Array, classes: Array, limit: int) -> Array:
	var out: Array = []
	var seen: Dictionary = {}
	var tree: SceneTree = get_tree()
	var scene: Node = tree.current_scene if tree != null else null

	for g in groups:
		if tree != null and tree.has_group(String(g)):
			for n in tree.get_nodes_in_group(String(g)):
				if out.size() >= limit:
					break
				_push_digest_node(out, seen, n, limit)
	for p in paths:
		if out.size() >= limit:
			break
		var n: Node = _find_node({"path": String(p), "node_path": String(p)})
		if n != null and (tree == null or n != tree.root):
			_push_digest_node(out, seen, n, limit)
	if not classes.is_empty() and scene != null:
		_walk_digest_classes(scene, classes, out, seen, limit)

	# 没给任何选择器时给一个可预测的默认值：当前场景根 + 直接子节点。
	# 不默认扫整棵树 —— 大项目会瞬间把结果撑爆，而调用方多半只想知道顶层结构。
	if groups.is_empty() and paths.is_empty() and classes.is_empty() and scene != null:
		_push_digest_node(out, seen, scene, limit)
		for child in scene.get_children():
			_push_digest_node(out, seen, child, limit)
	return out


func _walk_digest_classes(node: Node, classes: Array, out: Array, seen: Dictionary, limit: int) -> void:
	if out.size() >= limit:
		return
	for c in classes:
		if node.is_class(String(c)):
			_push_digest_node(out, seen, node, limit)
			break
	for child in node.get_children():
		if out.size() >= limit:
			return
		_walk_digest_classes(child, classes, out, seen, limit)


func _push_digest_node(out: Array, seen: Dictionary, node: Node, limit: int) -> void:
	if node == null or out.size() >= limit:
		return
	var id: int = node.get_instance_id()
	if seen.has(id):
		return
	seen[id] = true
	out.append(node)


func _digest_node(node: Node, wanted: Array) -> Dictionary:
	var out: Dictionary = {
		"path": str(node.get_path()),
		"name": String(node.name),
		"class": node.get_class(),
	}
	for p in wanted:
		var key: String = String(p)
		if _has_property(node, key):
			out[key] = _variant_to_json(node.get(key))
	# 少数几类节点的「当前状态」藏在不叫 velocity 的地方，单独补上
	if node is AnimationPlayer:
		var ap := node as AnimationPlayer
		out["current_animation"] = String(ap.current_animation)
		out["animation_position"] = snappedf(ap.current_animation_position, 0.001)
		out["is_playing"] = ap.is_playing()
	elif node is AnimatedSprite2D:
		var asp := node as AnimatedSprite2D
		out["animation"] = String(asp.animation)
		out["sprite_frame"] = asp.frame
		out["sprite_playing"] = asp.is_playing()
	elif node is Timer:
		var tm := node as Timer
		out["time_left"] = snappedf(tm.time_left, 0.001)
		out["stopped"] = tm.is_stopped()
	return out


func _op_quit(params: Dictionary) -> Dictionary:
	_quit_code = int(params.get("exit_code", 0))
	_quit_requested = true
	return _ok({"quitting": true, "exit_code": _quit_code})


# ------------------------------------------------------------------- helpers --

func _ok(data: Dictionary) -> Dictionary:
	return {"ok": true, "data": data}


func _err(message: String) -> Dictionary:
	return {"ok": false, "error": message}


func _log(line: String) -> void:
	var stamped: String = "[%s] %s" % [Time.get_time_string_from_system(), line]
	_log_lines.append(stamped)
	if _log_lines.size() > MAX_LOG_LINES:
		_log_lines = _log_lines.slice(_log_lines.size() - MAX_LOG_LINES)
	if _debug:
		print("[GodotMCPRuntime] %s" % line)


func _is_headless() -> bool:
	return DisplayServer.get_name() == "headless"


## Truthy for "1", "true", "yes", "on" (case-insensitive).
static func _env_flag(name: String) -> bool:
	var value: String = OS.get_environment(name).strip_edges().to_lower()
	return value == "1" or value == "true" or value == "yes" or value == "on"


## Pure startup-gate decision, split out so it can be unit-tested without a
## release binary. Returns "" when the bridge may listen, otherwise the reason
## why it must stay closed.
static func bridge_gate_reason(is_debug_build: bool, in_editor: bool, forced: bool, disabled: bool) -> String:
	if disabled:
		return "%s is set" % ENV_DISABLE
	if forced:
		return ""
	if in_editor:
		return ""
	if is_debug_build:
		return ""
	return "release build without %s=1" % ENV_FORCE


func _describe_gate() -> String:
	if not gate_reason.is_empty():
		return "closed: %s" % gate_reason
	if _env_flag(ENV_FORCE):
		return "open: forced by %s" % ENV_FORCE
	if OS.has_feature("editor"):
		return "open: editor"
	if OS.is_debug_build():
		return "open: debug build"
	return "open"


func _open_clients() -> int:
	var n: int = 0
	for id in _clients.keys():
		var tcp: StreamPeerTCP = _clients[id].get("tcp")
		if tcp != null and tcp.get_status() == StreamPeerTCP.STATUS_CONNECTED:
			n += 1
	return n


## Resolve "/root/Main/Player", "Main/Player", "./Player", "." or "".
func _find_node(params: Dictionary) -> Node:
	var path: String = String(params.get("node_path", params.get("path", ""))).strip_edges()
	var tree: SceneTree = get_tree()
	if tree == null:
		return null
	var root: Node = tree.root
	if path.is_empty() or path == "." or path == "/" or path == "/root":
		return root
	var direct: Node = root.get_node_or_null(NodePath(path))
	if direct != null:
		return direct
	if not path.begins_with("/"):
		direct = root.get_node_or_null(NodePath(path.trim_prefix("./")))
		if direct != null:
			return direct
		if not path.contains("/"):
			return root.find_child(path, true, false)
	return null


func _count_nodes(node: Node) -> int:
	if node == null:
		return 0
	var n: int = 1
	for child in node.get_children():
		n += _count_nodes(child)
	return n


func _script_path(node: Node) -> String:
	var s: Variant = node.get_script()
	if s is Script:
		return String((s as Script).resource_path)
	return ""


func _build_tree(node: Node, rel: String, depth: int, max_depth: int, with_properties: bool) -> Dictionary:
	var info: Dictionary = {
		"name": String(node.name),
		"type": node.get_class(),
		"path": str(node.get_path()),
		"child_count": node.get_child_count(),
	}
	var script_path: String = _script_path(node)
	if not script_path.is_empty():
		info["script"] = script_path
	if node is CanvasItem:
		info["visible"] = (node as CanvasItem).is_visible_in_tree()
	if with_properties:
		info["properties"] = _editor_properties(node)
	if depth >= max_depth:
		if node.get_child_count() > 0:
			info["truncated"] = true
		return info
	var children: Array = []
	for child in node.get_children():
		children.append(_build_tree(child, "%s/%s" % [rel, child.name], depth + 1, max_depth, with_properties))
	if not children.is_empty():
		info["children"] = children
	return info


func _editor_properties(node: Node) -> Dictionary:
	var out: Dictionary = {}
	for p in node.get_property_list():
		var usage: int = int(p.get("usage", 0))
		if usage & PROPERTY_USAGE_EDITOR == 0:
			continue
		var name: String = String(p.get("name", ""))
		if name.is_empty() or name.begins_with("_") or name == "script":
			continue
		out[name] = _variant_to_json(node.get(name))
	return out


func _has_property(node: Object, prop: String) -> bool:
	for p in node.get_property_list():
		if String(p.get("name", "")) == prop:
			return true
	return false


func _to_string_array(value: Variant) -> Array:
	var out: Array = []
	if value is Array or value is PackedStringArray:
		for v in value:
			out.append(str(v))
	return out


func _indent(source: String) -> String:
	var out: String = ""
	for line in source.split("\n"):
		out += "\t" + line + "\n"
	return out


func _launch_eval(state: Array, instance: Variant) -> void:
	var value: Variant = null
	if instance is Object:
		var obj: Object = instance
		if obj.has_method("_run"):
			value = await obj.call("_run")
		elif obj.has_method("execute"):
			value = await obj.call("execute")
		if value == null and _has_property(obj, "mcp_result"):
			value = obj.get("mcp_result")
	state[0] = true
	state[1] = value


func _await_completion(state: Array, timeout_ms: int) -> bool:
	var deadline: int = Time.get_ticks_msec() + maxi(timeout_ms, 1)
	while not bool(state[0]):
		if Time.get_ticks_msec() > deadline:
			return false
		await get_tree().process_frame
	return true


func _keycode_from_string(key_name: String) -> int:
	var name: String = key_name.strip_edges()
	var from_engine: int = int(OS.find_keycode_from_string(name))
	if from_engine != 0:
		return from_engine
	var upper: String = name.to_upper()
	var map: Dictionary = {
		"ESC": KEY_ESCAPE, "RETURN": KEY_ENTER, "SPACE": KEY_SPACE, "TAB": KEY_TAB,
		"UP": KEY_UP, "DOWN": KEY_DOWN, "LEFT": KEY_LEFT, "RIGHT": KEY_RIGHT,
		"SHIFT": KEY_SHIFT, "CTRL": KEY_CTRL, "CONTROL": KEY_CTRL, "ALT": KEY_ALT,
		"DELETE": KEY_DELETE, "BACKSPACE": KEY_BACKSPACE, "ENTER": KEY_ENTER,
	}
	if map.has(upper):
		return int(map[upper])
	if name.length() == 1:
		return name.unicode_at(0)
	return 0


func _unicode_for_key(keycode: int) -> int:
	if keycode >= KEY_A and keycode <= KEY_Z:
		return keycode - KEY_A + 97
	if keycode >= KEY_0 and keycode <= KEY_9:
		return keycode - KEY_0 + 48
	if keycode == KEY_SPACE:
		return 32
	if keycode == KEY_ENTER:
		return 10
	return 0


func _mouse_button_from_value(value: Variant) -> int:
	if value is int or value is float:
		return int(value)
	var name: String = String(value).strip_edges().to_lower()
	match name:
		"left", "":
			return MOUSE_BUTTON_LEFT
		"right":
			return MOUSE_BUTTON_RIGHT
		"middle":
			return MOUSE_BUTTON_MIDDLE
		"wheel_up", "up":
			return MOUSE_BUTTON_WHEEL_UP
		"wheel_down", "down":
			return MOUSE_BUTTON_WHEEL_DOWN
		"wheel_left":
			return MOUSE_BUTTON_WHEEL_LEFT
		"wheel_right":
			return MOUSE_BUTTON_WHEEL_RIGHT
	return MOUSE_BUTTON_LEFT


# ------------------------------------------------- JSON <-> Variant helpers --
# Adapted from tugcantopaloglu/godot-mcp (MIT).

func _variant_to_json(value: Variant, depth: int = 0) -> Variant:
	if value == null:
		return null
	if depth > MAX_JSON_DEPTH:
		return "<max depth>"
	if value is bool or value is int or value is float or value is String:
		return value
	if value is StringName or value is NodePath:
		return String(value)
	if value is Vector2:
		return {"x": value.x, "y": value.y}
	if value is Vector2i:
		return {"x": value.x, "y": value.y}
	if value is Vector3:
		return {"x": value.x, "y": value.y, "z": value.z}
	if value is Vector3i:
		return {"x": value.x, "y": value.y, "z": value.z}
	if value is Vector4:
		return {"x": value.x, "y": value.y, "z": value.z, "w": value.w}
	if value is Color:
		return {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
	if value is Quaternion:
		return {"x": value.x, "y": value.y, "z": value.z, "w": value.w}
	if value is Basis:
		return {"x": _variant_to_json(value.x, depth + 1), "y": _variant_to_json(value.y, depth + 1), "z": _variant_to_json(value.z, depth + 1)}
	if value is Transform3D:
		return {"basis": _variant_to_json(value.basis, depth + 1), "origin": _variant_to_json(value.origin, depth + 1)}
	if value is Transform2D:
		return {"x": _variant_to_json(value.x, depth + 1), "y": _variant_to_json(value.y, depth + 1), "origin": _variant_to_json(value.origin, depth + 1)}
	if value is Rect2:
		return {"position": _variant_to_json(value.position, depth + 1), "size": _variant_to_json(value.size, depth + 1)}
	if value is Rect2i:
		return {"position": _variant_to_json(value.position, depth + 1), "size": _variant_to_json(value.size, depth + 1)}
	if value is AABB:
		return {"position": _variant_to_json(value.position, depth + 1), "size": _variant_to_json(value.size, depth + 1)}
	if value is Plane:
		return {"normal": _variant_to_json(value.normal, depth + 1), "d": value.d}
	if value is PackedByteArray:
		var bytes: Array = []
		for b in value:
			bytes.append(int(b))
		return bytes
	if value is PackedInt32Array or value is PackedInt64Array:
		var ints: Array = []
		for item in value:
			ints.append(int(item))
		return ints
	if value is PackedFloat32Array or value is PackedFloat64Array:
		var floats: Array = []
		for item in value:
			floats.append(float(item))
		return floats
	if value is PackedStringArray:
		var strings: Array = []
		for item in value:
			strings.append(String(item))
		return strings
	if value is PackedVector2Array:
		var v2: Array = []
		for item in value:
			v2.append(_variant_to_json(item, depth + 1))
		return v2
	if value is PackedVector3Array:
		var v3: Array = []
		for item in value:
			v3.append(_variant_to_json(item, depth + 1))
		return v3
	if value is PackedColorArray:
		var vc: Array = []
		for item in value:
			vc.append(_variant_to_json(item, depth + 1))
		return vc
	if value is Array:
		var arr: Array = []
		for item in value:
			arr.append(_variant_to_json(item, depth + 1))
		return arr
	if value is Dictionary:
		var dict_out: Dictionary = {}
		for key in value:
			dict_out[str(key)] = _variant_to_json(value[key], depth + 1)
		return dict_out
	if value is Node:
		return {"_type": "Node", "class": value.get_class(), "name": String(value.name), "path": str(value.get_path())}
	if value is Resource:
		return {"_type": "Resource", "class": value.get_class(), "path": String(value.resource_path)}
	if value is Object:
		return {"_type": "Object", "class": value.get_class(), "id": value.get_instance_id()}
	return str(value)


func _json_to_variant(value: Variant, type_hint: String = "") -> Variant:
	if value == null:
		return null
	if value is String and not type_hint.is_empty():
		var trimmed: String = (value as String).strip_edges()
		if trimmed.begins_with("{") or trimmed.begins_with("["):
			var parser := JSON.new()
			if parser.parse(trimmed) == OK:
				value = parser.data
	if value is Dictionary:
		var dict: Dictionary = value
		match type_hint:
			"Vector2":
				return Vector2(float(dict.get("x", 0)), float(dict.get("y", 0)))
			"Vector2i":
				return Vector2i(int(dict.get("x", 0)), int(dict.get("y", 0)))
			"Vector3":
				return Vector3(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)))
			"Vector3i":
				return Vector3i(int(dict.get("x", 0)), int(dict.get("y", 0)), int(dict.get("z", 0)))
			"Vector4":
				return Vector4(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)), float(dict.get("w", 0)))
			"Color":
				return Color(float(dict.get("r", 0)), float(dict.get("g", 0)), float(dict.get("b", 0)), float(dict.get("a", 1)))
			"Quaternion":
				return Quaternion(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)), float(dict.get("w", 1)))
			"Rect2":
				var r_pos: Dictionary = dict.get("position", {"x": 0, "y": 0})
				var r_size: Dictionary = dict.get("size", {"x": 0, "y": 0})
				return Rect2(float(r_pos.get("x", 0)), float(r_pos.get("y", 0)), float(r_size.get("x", 0)), float(r_size.get("y", 0)))
			"AABB":
				var a_pos: Dictionary = dict.get("position", {"x": 0, "y": 0, "z": 0})
				var a_size: Dictionary = dict.get("size", {"x": 0, "y": 0, "z": 0})
				return AABB(
					Vector3(float(a_pos.get("x", 0)), float(a_pos.get("y", 0)), float(a_pos.get("z", 0))),
					Vector3(float(a_size.get("x", 0)), float(a_size.get("y", 0)), float(a_size.get("z", 0))))
			"Basis":
				var bx: Dictionary = dict.get("x", {"x": 1, "y": 0, "z": 0})
				var by: Dictionary = dict.get("y", {"x": 0, "y": 1, "z": 0})
				var bz: Dictionary = dict.get("z", {"x": 0, "y": 0, "z": 1})
				return Basis(
					Vector3(float(bx.get("x", 0)), float(bx.get("y", 0)), float(bx.get("z", 0))),
					Vector3(float(by.get("x", 0)), float(by.get("y", 0)), float(by.get("z", 0))),
					Vector3(float(bz.get("x", 0)), float(bz.get("y", 0)), float(bz.get("z", 0))))
			"Transform2D":
				var tx: Dictionary = dict.get("x", {"x": 1, "y": 0})
				var ty: Dictionary = dict.get("y", {"x": 0, "y": 1})
				var t_origin: Dictionary = dict.get("origin", {"x": 0, "y": 0})
				return Transform2D(
					Vector2(float(tx.get("x", 0)), float(tx.get("y", 0))),
					Vector2(float(ty.get("x", 0)), float(ty.get("y", 0))),
					Vector2(float(t_origin.get("x", 0)), float(t_origin.get("y", 0))))
			"Transform3D":
				var basis_dict: Dictionary = dict.get("basis", {})
				var origin_dict: Dictionary = dict.get("origin", {"x": 0, "y": 0, "z": 0})
				var basis: Basis = _json_to_variant(basis_dict, "Basis") if basis_dict.size() > 0 else Basis.IDENTITY
				return Transform3D(basis, Vector3(float(origin_dict.get("x", 0)), float(origin_dict.get("y", 0)), float(origin_dict.get("z", 0))))
			"NodePath":
				return NodePath(String(dict.get("path", "")))
			"StringName":
				return StringName(String(dict.get("name", "")))
		if dict.has("basis") and dict.has("origin"):
			return _json_to_variant(dict, "Transform3D")
		if dict.has("r") and dict.has("g") and dict.has("b"):
			return _json_to_variant(dict, "Color")
		if dict.has("x") and dict.has("y") and dict.has("z") and dict.has("w"):
			return _json_to_variant(dict, "Quaternion")
		if dict.has("position") and dict.has("size"):
			if dict["position"] is Dictionary and (dict["position"] as Dictionary).has("z"):
				return _json_to_variant(dict, "AABB")
			return _json_to_variant(dict, "Rect2")
		if dict.has("x") and dict.has("y") and dict.has("z"):
			return _json_to_variant(dict, "Vector3")
		if dict.has("x") and dict.has("y") and dict.size() == 2:
			return _json_to_variant(dict, "Vector2")
		return value
	return value


func _json_to_variant_for_property(node: Object, property: String, value: Variant) -> Variant:
	for p in node.get_property_list():
		if String(p.get("name", "")) == property:
			var type_id: int = int(p.get("type", 0))
			match type_id:
				TYPE_VECTOR2:
					return _json_to_variant(value, "Vector2")
				TYPE_VECTOR2I:
					return _json_to_variant(value, "Vector2i")
				TYPE_VECTOR3:
					return _json_to_variant(value, "Vector3")
				TYPE_VECTOR3I:
					return _json_to_variant(value, "Vector3i")
				TYPE_VECTOR4:
					return _json_to_variant(value, "Vector4")
				TYPE_COLOR:
					return _json_to_variant(value, "Color")
				TYPE_QUATERNION:
					return _json_to_variant(value, "Quaternion")
				TYPE_RECT2:
					return _json_to_variant(value, "Rect2")
				TYPE_RECT2I:
					return _json_to_variant(value, "Rect2i")
				TYPE_AABB:
					return _json_to_variant(value, "AABB")
				TYPE_BASIS:
					return _json_to_variant(value, "Basis")
				TYPE_TRANSFORM3D:
					return _json_to_variant(value, "Transform3D")
				TYPE_TRANSFORM2D:
					return _json_to_variant(value, "Transform2D")
				TYPE_NODE_PATH:
					return NodePath(String(value))
				TYPE_STRING_NAME:
					return StringName(String(value))
				TYPE_BOOL:
					if value is String:
						return (value as String).to_lower() == "true"
					return bool(value)
				TYPE_INT:
					return int(value)
				TYPE_FLOAT:
					return float(value)
				TYPE_STRING:
					return String(value)
				TYPE_OBJECT, TYPE_ARRAY, TYPE_DICTIONARY:
					return value
			break
	return _json_to_variant(value)
