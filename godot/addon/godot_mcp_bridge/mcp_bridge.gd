@tool
extends Node
## Godot MCP Bridge — L2 (live editor control) layer.
##
## Runs inside the Godot editor as a child of the `godot_mcp_bridge` EditorPlugin.
## Listens for WebSocket clients on 127.0.0.1:9089 (WebSocketPeer server mode,
## handshake performed via TCPServer + accept_stream) and speaks
## newline-delimited JSON:
##
##   request  {"id": "...", "op": "editor.info", "params": {...}}
##   response {"id": "...", "ok": true,  "data": {...}}
##            {"id": "...", "ok": false, "error": "..."}
##
## Frozen contract: godot-mcp DESIGN.md §2.2.
## Port override: GODOT_MCP_BRIDGE_PORT (default 9089).
## Debug logging: GODOT_MCP_BRIDGE_DEBUG=1 prints bridge traffic to the editor log.
##
## Scene mutations go through EditorInterface.get_editor_undo_redo(), so every
## change is a real, user-undoable editor action (Ctrl+Z) — this is the key
## difference from the cold L1 headless layer.
##
## Several JSON <-> Variant conversion helpers are adapted from
## tugcantopaloglu/godot-mcp (MIT, Copyright (c) 2025 Tugcan Topaloglu;
## original work Coding-Solo/godot-mcp, Copyright (c) 2025 Solomon Elias).

const DEFAULT_PORT: int = 9089
const ENV_PORT: String = "GODOT_MCP_BRIDGE_PORT"
const ENV_DEBUG: String = "GODOT_MCP_BRIDGE_DEBUG"
const PROTOCOL: String = "godot-mcp-bridge/1"

const MAX_QUEUE: int = 64
const MAX_LOG_LINES: int = 1000
const BUSY_WATCHDOG_MSEC: int = 30000
const HANDSHAKE_TIMEOUT_MSEC: int = 10000
const MAX_JSON_DEPTH: int = 24
const EXEC_TIMEOUT_MSEC: int = 15000

const EXEC_WRAPPER_HEAD: String = """extends Node

var mcp_result = null

func MCP_RESULT(v):
	mcp_result = v

func _run():
"""

var port: int = DEFAULT_PORT

var _tcp: TCPServer = null
var _peers: Dictionary = {}          # instance_id -> {ws, buf, opened, since}
var _queue: Array = []
var _busy: bool = false
var _busy_since: int = 0
var _current_job: Dictionary = {}
var _log_lines: Array = []
var _debug: bool = false
var _requests_served: int = 0
var _last_error: String = ""


# ---------------------------------------------------------------- lifecycle --

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_debug = OS.get_environment(ENV_DEBUG).strip_edges() == "1"
	var env_port: String = OS.get_environment(ENV_PORT).strip_edges()
	if env_port.is_valid_int():
		port = int(env_port)
	_start_server()


func shutdown() -> void:
	for id in _peers.keys():
		_close_peer(id, false)
	_peers.clear()
	if _tcp != null:
		_tcp.stop()
		_tcp = null
	_log("shutdown")


func _start_server() -> void:
	if _tcp != null:
		_tcp.stop()
	_tcp = TCPServer.new()
	var err: int = _tcp.listen(port, "127.0.0.1")
	if err != OK:
		_tcp = null
		_last_error = "cannot listen on 127.0.0.1:%d (error %d)" % [port, err]
		push_error("Godot MCP Bridge: %s" % _last_error)
		_log("ERROR: %s" % _last_error)
		return
	_log("listening on ws://127.0.0.1:%d" % port)


func _process(_delta: float) -> void:
	_poll_network()
	if _busy and Time.get_ticks_msec() - _busy_since > BUSY_WATCHDOG_MSEC:
		var op: String = String(_current_job.get("op", "?"))
		_log("WARN: op '%s' stuck for >%d ms, releasing the queue" % [op, BUSY_WATCHDOG_MSEC])
		_send_raw(int(_current_job.get("peer", -1)), {
			"id": _current_job.get("id", null),
			"op": op,
			"ok": false,
			"error": "bridge watchdog: op '%s' did not finish within %d ms" % [op, BUSY_WATCHDOG_MSEC],
		})
		_busy = false
		_current_job = {}
	if _busy or _queue.is_empty():
		return
	var job: Dictionary = _queue.pop_front()
	_busy = true
	_busy_since = Time.get_ticks_msec()
	_current_job = job
	_run_job(job)


# ------------------------------------------------------------------ network --

func _poll_network() -> void:
	if _tcp == null:
		return
	while _tcp.is_connection_available():
		var conn: StreamPeerTCP = _tcp.take_connection()
		if conn == null:
			break
		var ws := WebSocketPeer.new()
		var err: int = ws.accept_stream(conn)
		if err != OK:
			_log("ERROR: websocket handshake could not start (error %d)" % err)
			conn.disconnect_from_host()
			continue
		var id: int = ws.get_instance_id()
		_peers[id] = {"ws": ws, "buf": "", "opened": false, "since": Time.get_ticks_msec()}
		_log("client connected (peer %d), awaiting WebSocket handshake" % id)

	var dead: Array = []
	for id in _peers.keys():
		var entry: Dictionary = _peers[id]
		var ws: WebSocketPeer = entry.get("ws")
		if ws == null:
			dead.append(id)
			continue
		ws.poll()
		var state: int = ws.get_ready_state()
		if state == WebSocketPeer.STATE_OPEN:
			if not bool(entry.get("opened", false)):
				entry["opened"] = true
				_log("websocket open (peer %d)" % id)
			while ws.get_available_packet_count() > 0:
				var pkt: PackedByteArray = ws.get_packet()
				_ingest(id, pkt.get_string_from_utf8())
		elif state == WebSocketPeer.STATE_CLOSED:
			dead.append(id)
		elif not bool(entry.get("opened", false)) and Time.get_ticks_msec() - int(entry.get("since", 0)) > HANDSHAKE_TIMEOUT_MSEC:
			_log("peer %d did not complete the WebSocket handshake in %d ms" % [id, HANDSHAKE_TIMEOUT_MSEC])
			dead.append(id)

	for id in dead:
		_close_peer(id, true)


func _close_peer(id: int, log_it: bool) -> void:
	var entry: Dictionary = _peers.get(id, {})
	if not entry.is_empty():
		var ws: WebSocketPeer = entry.get("ws")
		if ws != null and ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
			ws.close(1000, "bye")
	_peers.erase(id)
	if log_it:
		_log("client disconnected (peer %d)" % id)


## Split a websocket text frame into newline-delimited JSON requests.
func _ingest(peer_id: int, text: String) -> void:
	var entry: Dictionary = _peers.get(peer_id, {})
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
			_enqueue(peer_id, line)
	# Tolerant path: a client may send one complete JSON object without "\n".
	var tail: String = buf.strip_edges()
	if not tail.is_empty():
		var probe := JSON.new()
		if probe.parse(tail) == OK and probe.data is Dictionary and (probe.data as Dictionary).has("op"):
			_enqueue(peer_id, tail)
			buf = ""
	entry["buf"] = buf


func _enqueue(peer_id: int, line: String) -> void:
	var probe := JSON.new()
	if probe.parse(line) != OK:
		_send_raw(peer_id, {"id": null, "ok": false, "error": "invalid JSON: %s" % probe.get_error_message()})
		return
	var parsed: Variant = probe.data
	if not (parsed is Dictionary):
		_send_raw(peer_id, {"id": null, "ok": false, "error": "request must be a JSON object"})
		return
	var req: Dictionary = parsed
	if not req.has("op") or not (req["op"] is String):
		_send_raw(peer_id, {"id": req.get("id", null), "ok": false, "error": "request is missing the 'op' string field"})
		return
	if _queue.size() >= MAX_QUEUE:
		_send_raw(peer_id, {
			"id": req.get("id", null),
			"ok": false,
			"error": "bridge queue full (%d pending)" % MAX_QUEUE,
		})
		return
	var params: Dictionary = {}
	if req.get("params") is Dictionary:
		params = req["params"]
	_queue.append({
		"peer": peer_id,
		"id": req.get("id", null),
		"op": String(req["op"]),
		"params": params,
	})


func _send_raw(peer_id: int, payload: Dictionary) -> void:
	var entry: Dictionary = _peers.get(peer_id, {})
	if entry.is_empty():
		return
	var ws: WebSocketPeer = entry.get("ws")
	if ws == null or ws.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return
	# Text frames: JSON is text, and browser/Node clients receive binary frames
	# as Blob/ArrayBuffer, which is needlessly awkward for line-delimited JSON.
	ws.send_text(JSON.stringify(payload) + "\n")
	ws.poll()


# ------------------------------------------------------------------ dispatch --

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
	_send_raw(int(job.get("peer", -1)), out)
	_busy = false
	_current_job = {}


func _execute(op: String, params: Dictionary) -> Dictionary:
	var result: Variant = null
	match op:
		# --- §2.2 required ops -------------------------------------------------
		"editor.info", "info":
			result = _op_info(params)
		"editor.scene_tree", "scene_tree":
			result = _op_scene_tree(params)
		"editor.select", "select":
			result = _op_select(params)
		"editor.add_node", "add_node":
			result = _op_add_node(params)
		"editor.set_property", "set_property":
			result = _op_set_property(params)
		"editor.remove_node", "remove_node":
			result = _op_remove_node(params)
		"editor.save_scene", "save_scene":
			result = _op_save_scene(params)
		"editor.open_scene", "open_scene":
			result = await _op_open_scene(params)
		"editor.reload_scripts", "reload_scripts":
			result = await _op_reload_scripts(params)
		"editor.run", "run":
			result = await _op_run(params)
		"editor.stop", "stop":
			result = await _op_stop(params)
		"editor.execute", "execute":
			result = await _op_execute(params)
		"editor.console_log", "console_log":
			result = _op_console_log(params)
		# --- additive extras (documented in INSTALL.md) ------------------------
		"editor.ping":
			result = _ok({"pong": true, "nonce": params.get("nonce", null), "port": port, "protocol": PROTOCOL})
		"editor.node_info":
			result = _op_node_info(params)
		"editor.save_all_scenes":
			result = _op_save_all_scenes(params)
		"editor.list_open_scenes":
			result = _op_list_open_scenes(params)
		"editor.reload_scene":
			result = await _op_reload_scene(params)
		"editor.bridge_status":
			result = _op_bridge_status(params)
		_:
			result = _err("unknown op: '%s'" % op)
	if not (result is Dictionary):
		return _err("internal error: op '%s' returned %s instead of a result dictionary" % [op, type_string(typeof(result))])
	return result


# ----------------------------------------------------------------------- ops --

func _op_info(_params: Dictionary) -> Dictionary:
	var root: Node = EditorInterface.get_edited_scene_root()
	var version: Dictionary = Engine.get_version_info()
	return _ok({
		"godot_version": String(version.get("string", "")),
		"godot_version_info": version,
		"project_path": ProjectSettings.globalize_path("res://"),
		"project_name": String(ProjectSettings.get_setting("application/config/name", "")),
		"edited_scene": _root_path(root),
		"open_scenes": _open_scenes(),
		"unsaved_scenes": _packed_to_array(EditorInterface.get_unsaved_scenes()),
		"playing": EditorInterface.is_playing_scene(),
		"playing_scene": String(EditorInterface.get_playing_scene()),
		"bridge_port": port,
		"protocol": PROTOCOL,
		"display_driver": DisplayServer.get_name(),
		"headless": _is_headless(),
		"clients": _open_peers(),
		"requests_served": _requests_served,
		"last_error": _last_error,
	})


func _op_scene_tree(params: Dictionary) -> Dictionary:
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null:
		return _err("no scene is currently open in the editor; use editor.open_scene first")
	var max_depth: int = int(params.get("max_depth", 64))
	if max_depth <= 0:
		max_depth = 64
	var with_properties: bool = bool(params.get("with_properties", false))
	var tree: Dictionary = _build_tree(root, ".", 0, max_depth, with_properties)
	return _ok({
		"tree": tree,
		"edited_scene": _root_path(root),
		"node_count": _count_nodes(root),
		"with_properties": with_properties,
	})


func _op_node_info(params: Dictionary) -> Dictionary:
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null:
		return _err("no scene is currently open in the editor")
	var node: Node = _resolve_node(root, String(params.get("node_path", "")))
	if node == null:
		return _err("node not found: '%s'" % params.get("node_path", ""))
	var props: Dictionary = {}
	if bool(params.get("with_properties", true)):
		props = _editor_properties(node)
	var signals: Array = []
	for s in node.get_signal_list():
		signals.append(String(s.get("name", "")))
	return _ok({
		"name": String(node.name),
		"type": node.get_class(),
		"path": _rel_path(root, node),
		"scene_file_path": String(node.scene_file_path),
		"script": _script_path(node),
		"child_count": node.get_child_count(),
		"children": _child_summaries(root, node),
		"groups": _packed_to_array(node.get_groups()),
		"signals": signals,
		"properties": props,
	})


func _op_select(params: Dictionary) -> Dictionary:
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null:
		return _err("no scene is currently open in the editor")
	var node: Node = _resolve_node(root, String(params.get("node_path", "")))
	if node == null:
		return _err("node not found: '%s'" % params.get("node_path", ""))
	var selection: EditorSelection = EditorInterface.get_selection()
	if bool(params.get("clear", true)):
		selection.clear()
	selection.add_node(node)
	if not _is_headless():
		EditorInterface.edit_node(node)
	return _ok({
		"selected": _rel_path(root, node),
		"selection_count": selection.get_selected_nodes().size(),
	})


func _op_add_node(params: Dictionary) -> Dictionary:
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null:
		return _err("no scene is currently open in the editor")
	var parent_path: String = String(params.get("parent_path", "")).strip_edges()
	var parent: Node = root if parent_path.is_empty() else _resolve_node(root, parent_path)
	if parent == null:
		return _err("parent node not found: '%s'" % parent_path)

	var type_name: String = String(params.get("type", params.get("node_type", "Node"))).strip_edges()
	var node: Node = _instantiate_node(type_name)
	if node == null:
		return _err("cannot instantiate node type '%s' (not a ClassDB class, nor a loadable script path)" % type_name)

	var props: Dictionary = {}
	if params.get("properties") is Dictionary:
		props = (params["properties"] as Dictionary).duplicate()
	var requested_name: String = String(params.get("name", props.get("name", type_name)))
	props.erase("name")
	requested_name = requested_name.validate_node_name().strip_edges()
	if requested_name.is_empty():
		requested_name = "Node"
	node.name = _unique_child_name(parent, requested_name)

	for key in props.keys():
		if not _has_property(node, String(key)):
			node.free()
			return _err("node type '%s' has no property '%s'" % [type_name, key])

	var undo: EditorUndoRedoManager = EditorInterface.get_editor_undo_redo()
	undo.create_action("MCP: add %s" % node.name)
	undo.add_do_method(parent, "add_child", node)
	undo.add_do_method(node, "set_owner", root)
	undo.add_do_method(node, "set_name", String(node.name))
	for key in props.keys():
		var prop: String = String(key)
		undo.add_do_property(node, prop, _json_to_variant_for_property(node, prop, props[key]))
		undo.add_undo_property(node, prop, node.get(prop))
	undo.add_do_reference(node)
	undo.add_undo_method(parent, "remove_child", node)
	undo.commit_action()

	var selection: EditorSelection = EditorInterface.get_selection()
	selection.clear()
	selection.add_node(node)
	return _ok({
		"node_path": _rel_path(root, node),
		"node_name": String(node.name),
		"type": node.get_class(),
		"parent_path": _rel_path(root, parent),
		"properties": props.keys(),
		"undoable": true,
	})


func _op_set_property(params: Dictionary) -> Dictionary:
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null:
		return _err("no scene is currently open in the editor")
	var node: Node = _resolve_node(root, String(params.get("node_path", "")))
	if node == null:
		return _err("node not found: '%s'" % params.get("node_path", ""))
	var prop: String = String(params.get("property", "")).strip_edges()
	if prop.is_empty():
		return _err("property is required")
	if not _has_property(node, prop):
		return _err("node '%s' (%s) has no property '%s'" % [_rel_path(root, node), node.get_class(), prop])
	if not params.has("value"):
		return _err("value is required (use null to reset)")

	var previous: Variant = node.get(prop)
	var value: Variant = _json_to_variant_for_property(node, prop, params["value"])
	var undo: EditorUndoRedoManager = EditorInterface.get_editor_undo_redo()
	undo.create_action("MCP: set %s.%s" % [node.name, prop])
	undo.add_do_property(node, prop, value)
	undo.add_undo_property(node, prop, previous)
	undo.commit_action()
	return _ok({
		"node_path": _rel_path(root, node),
		"property": prop,
		"value": _variant_to_json(node.get(prop)),
		"previous": _variant_to_json(previous),
		"undoable": true,
	})


func _op_remove_node(params: Dictionary) -> Dictionary:
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null:
		return _err("no scene is currently open in the editor")
	var node: Node = _resolve_node(root, String(params.get("node_path", "")))
	if node == null:
		return _err("node not found: '%s'" % params.get("node_path", ""))
	if node == root:
		return _err("refusing to remove the edited scene root; use editor.open_scene to switch scenes")
	var parent: Node = node.get_parent()
	if parent == null:
		return _err("node '%s' has no parent" % node.name)

	var path: String = _rel_path(root, node)
	var undo: EditorUndoRedoManager = EditorInterface.get_editor_undo_redo()
	undo.create_action("MCP: remove %s" % node.name)
	undo.add_do_method(parent, "remove_child", node)
	undo.add_undo_method(parent, "add_child", node)
	undo.add_undo_method(node, "set_owner", root)
	undo.add_undo_reference(node)
	undo.commit_action()
	return _ok({"removed": path, "node_name": String(node.name), "undoable": true})


func _op_save_scene(_params: Dictionary) -> Dictionary:
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null:
		return _err("no scene is currently open in the editor")
	var path: String = _root_path(root)
	if path.is_empty():
		return _err("the edited scene has never been saved; save it once in the editor first")
	var err: int = EditorInterface.save_scene()
	if err != OK:
		return _err("save_scene failed (error %d) for '%s'" % [err, path])
	return _ok({"saved": true, "scene_path": path})


func _op_save_all_scenes(_params: Dictionary) -> Dictionary:
	var before: Array = _packed_to_array(EditorInterface.get_unsaved_scenes())
	EditorInterface.save_all_scenes()
	return _ok({"saved": before, "unsaved_after": _packed_to_array(EditorInterface.get_unsaved_scenes())})


func _op_open_scene(params: Dictionary) -> Dictionary:
	var path: String = _normalize_res_path(String(params.get("scene_path", "")))
	if path.is_empty():
		return _err("scene_path is required")
	if not ResourceLoader.exists(path, "PackedScene"):
		return _err("scene not found (or not a PackedScene): '%s'" % path)
	EditorInterface.open_scene_from_path(path)
	var pred := func() -> bool:
		var r: Node = EditorInterface.get_edited_scene_root()
		return r != null and String(r.scene_file_path) == path
	var confirmed: bool = await _await_until(pred, 8000)
	var root: Node = EditorInterface.get_edited_scene_root()
	return _ok({
		"opened": true,
		"confirmed": confirmed,
		"scene_path": path,
		"edited_scene": _root_path(root),
		"open_scenes": _open_scenes(),
	})


func _op_list_open_scenes(_params: Dictionary) -> Dictionary:
	return _ok({
		"open_scenes": _open_scenes(),
		"edited_scene": _root_path(EditorInterface.get_edited_scene_root()),
		"unsaved_scenes": _packed_to_array(EditorInterface.get_unsaved_scenes()),
	})


func _op_reload_scene(params: Dictionary) -> Dictionary:
	var path: String = _normalize_res_path(String(params.get("scene_path", "")))
	if path.is_empty():
		var root: Node = EditorInterface.get_edited_scene_root()
		path = _root_path(root)
	if path.is_empty():
		return _err("scene_path is required (no scene is open)")
	var before: Node = EditorInterface.get_edited_scene_root()
	var before_id: int = before.get_instance_id() if before != null else 0
	EditorInterface.reload_scene_from_path(path)
	var pred := func() -> bool:
		var r: Node = EditorInterface.get_edited_scene_root()
		return r != null and String(r.scene_file_path) == path and r.get_instance_id() != before_id
	var confirmed: bool = await _await_until(pred, 8000)
	if not confirmed:
		return _err("reload_scene_from_path('%s') did not produce a fresh scene root within 8000 ms" % path)
	return _ok({"reloaded": confirmed, "scene_path": path, "note": "unsaved in-editor changes to this scene are discarded"})


func _op_reload_scripts(params: Dictionary) -> Dictionary:
	var fs: EditorFileSystem = EditorInterface.get_resource_filesystem()
	fs.scan()
	var pred := func() -> bool:
		return not fs.is_scanning()
	var finished: bool = await _await_until(pred, 10000)
	var reloaded: Array = []
	if bool(params.get("reload_open_scenes", false)):
		var open_scenes: Array = _open_scenes()
		for p in open_scenes:
			if EditorInterface.get_unsaved_scenes().has(String(p)):
				continue  # never silently discard unsaved editor state
			EditorInterface.reload_scene_from_path(String(p))
			reloaded.append(String(p))
	return _ok({
		"scanned": true,
		"scan_finished": finished,
		"still_scanning": fs.is_scanning(),
		"reloaded_scenes": reloaded,
	})


func _op_run(params: Dictionary) -> Dictionary:
	if EditorInterface.is_playing_scene():
		return _err("a scene is already playing; call editor.stop first")
	var scene: String = _normalize_res_path(String(params.get("scene", "")))
	if scene.is_empty():
		EditorInterface.play_main_scene()
	else:
		if not ResourceLoader.exists(scene, "PackedScene"):
			return _err("scene not found: '%s'" % scene)
		EditorInterface.play_custom_scene(scene)
	var pred := func() -> bool:
		return EditorInterface.is_playing_scene()
	var started: bool = await _await_until(pred, 8000)
	if not started:
		return _err("the editor did not start playing within 8000 ms (the requested scene may be missing or unavailable in this editor mode)")
	return _ok({
		"started": started,
		"playing": EditorInterface.is_playing_scene(),
		"playing_scene": String(EditorInterface.get_playing_scene()),
	})


func _op_stop(_params: Dictionary) -> Dictionary:
	var was: bool = EditorInterface.is_playing_scene()
	EditorInterface.stop_playing_scene()
	var pred := func() -> bool:
		return not EditorInterface.is_playing_scene()
	var stopped: bool = await _await_until(pred, 5000)
	return _ok({"was_playing": was, "stopped": stopped, "playing": EditorInterface.is_playing_scene()})


func _op_execute(params: Dictionary) -> Dictionary:
	var source: String = String(params.get("source", params.get("code", "")))
	if source.strip_edges().is_empty():
		return _err("source is required")
	var is_full: bool = source.strip_edges().begins_with("extends")
	var code: String = source if is_full else EXEC_WRAPPER_HEAD + _indent(source)

	var script := GDScript.new()
	script.source_code = code
	var err: int = script.reload()
	if err != OK:
		var failed: Dictionary = _err("GDScript failed to compile (error %d); the failing line is reported in the editor log" % err)
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
	_launch_execute(state, instance)
	var timeout_ms: int = int(params.get("timeout_ms", EXEC_TIMEOUT_MSEC))
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
		data["error_detail"] = "the coroutine is still running in the editor; increase timeout_ms if the source awaits a long signal"
	if bool(params.get("echo_source", false)):
		data["source"] = code
	return _ok(data)


func _op_console_log(params: Dictionary) -> Dictionary:
	var limit: int = int(params.get("limit", 50))
	if limit <= 0:
		limit = 50

	var file_lines: Array = []
	var log_path: String = ""
	var source: String = "bridge_buffer"
	var explicit_path: String = String(params.get("log_file", "")).strip_edges()
	var candidates: Array = []
	if not explicit_path.is_empty():
		candidates.append({"path": explicit_path, "source": "explicit_file"})
	candidates.append_array(_log_file_candidates())
	for candidate in candidates:
		var p: String = String(candidate.get("path", ""))
		if p.is_empty() or not FileAccess.file_exists(p):
			continue
		var tail: Array = _tail_lines(p, limit)
		if tail.is_empty():
			continue
		file_lines = tail
		log_path = p
		source = String(candidate.get("source", "log_file"))
		break

	var bridge_lines: Array = _log_lines.slice(maxi(0, _log_lines.size() - limit))
	var lines: Array = file_lines
	if lines.is_empty():
		lines = bridge_lines
	var note: String = ""
	if file_lines.is_empty():
		note = "no engine log file was readable, so this is the bridge's own ring buffer; start the editor with --log-file <abs path> and pass it as the log_file param, or enable debug/file_logging/enable_file_logging, to read real engine output"
	elif source == "project_log_file":
		note = "this is the project's user://logs/godot.log — when a scene has been played from the editor it holds the *game's* output, not the editor console; pass log_file explicitly to read the editor's own --log-file"
	return _ok({
		"lines": lines,
		"count": lines.size(),
		"source": source,
		"log_path": log_path,
		"engine_log_lines": file_lines,
		"bridge_lines": bridge_lines,
		"note": note,
	})


func _op_bridge_status(_params: Dictionary) -> Dictionary:
	var port_source: String = "default"
	if OS.get_environment(ENV_PORT).strip_edges().is_valid_int():
		port_source = "env:%s" % ENV_PORT
	return _ok({
		"port": port,
		"port_source": port_source,
		"protocol": PROTOCOL,
		"clients": _open_peers(),
		"queue": _queue.size(),
		"busy": _busy,
		"busy_means": "true while this very request is being served (always true here)",
		"requests_served": _requests_served,
		"last_error": _last_error,
		"headless": _is_headless(),
		"log_lines": _log_lines.size(),
	})


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
		print("[GodotMCPBridge] %s" % line)


func _is_headless() -> bool:
	return DisplayServer.get_name() == "headless"


func _open_peers() -> int:
	var n: int = 0
	for id in _peers.keys():
		var ws: WebSocketPeer = _peers[id].get("ws")
		if ws != null and ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
			n += 1
	return n


func _open_scenes() -> Array:
	return _packed_to_array(EditorInterface.get_open_scenes())


func _packed_to_array(value: Variant) -> Array:
	var out: Array = []
	if value is PackedStringArray or value is Array:
		for v in value:
			out.append(str(v))
	return out


func _root_path(root: Node) -> String:
	if root == null:
		return ""
	return String(root.scene_file_path)


func _normalize_res_path(path: String) -> String:
	var p: String = path.strip_edges()
	if p.is_empty():
		return ""
	if p.begins_with("res://") or p.begins_with("user://"):
		return p
	return "res://" + p.trim_prefix("/")


func _rel_path(root: Node, node: Node) -> String:
	if root == null or node == null:
		return ""
	if node == root:
		return "."
	var parts: Array = []
	var current: Node = node
	while current != null and current != root:
		parts.push_front(String(current.name))
		current = current.get_parent()
	if current != root:
		return str(node.get_path())
	return "/".join(parts)


## Resolve a node path relative to the edited scene root. Accepts ".", "",
## "/root/Scene/Child", "Scene/Child", "Child" and absolute node paths.
func _resolve_node(root: Node, path: String) -> Node:
	if root == null:
		return null
	var p: String = path.strip_edges()
	if p.is_empty() or p == "." or p == "/" or p == String(root.name) or p == "/root/" + String(root.name):
		return root
	var direct: Node = root.get_node_or_null(NodePath(p.trim_prefix("./")))
	if direct != null:
		return direct
	var rel: String = p
	if rel.begins_with("/root/"):
		rel = rel.substr(6)
		var head: String = rel
		var slash: int = rel.find("/")
		if slash >= 0:
			head = rel.substr(0, slash)
		if head == String(root.name):
			rel = rel.substr(head.length()).trim_prefix("/")
			if rel.is_empty():
				return root
			var sub: Node = root.get_node_or_null(NodePath(rel))
			if sub != null:
				return sub
	if root.get_tree() != null:
		var absolute: Node = root.get_tree().root.get_node_or_null(NodePath(p))
		if absolute != null and (absolute == root or root.is_ancestor_of(absolute)):
			return absolute
	if not p.contains("/"):
		return root.find_child(p, true, false)
	return null


func _instantiate_node(type_name: String) -> Node:
	if ClassDB.class_exists(type_name):
		var obj: Variant = ClassDB.instantiate(type_name)
		if obj is Node:
			return obj
		if obj != null and obj is Object:
			obj.free()
	var script_path: String = _normalize_res_path(type_name)
	if ResourceLoader.exists(script_path):
		var res: Resource = load(script_path)
		if res is Script:
			var made: Variant = (res as Script).new()
			if made is Node:
				return made
	return null


func _unique_child_name(parent: Node, desired: String) -> String:
	var name: String = desired
	if parent.has_node(NodePath(name)):
		var i: int = 2
		while parent.has_node(NodePath("%s%d" % [desired, i])):
			i += 1
		name = "%s%d" % [desired, i]
	return name


func _has_property(node: Object, prop: String) -> bool:
	for p in node.get_property_list():
		if String(p.get("name", "")) == prop:
			return true
	return false


func _script_path(node: Node) -> String:
	var s: Variant = node.get_script()
	if s is Script:
		return String((s as Script).resource_path)
	return ""


func _child_summaries(root: Node, node: Node) -> Array:
	var out: Array = []
	for child in node.get_children():
		out.append({
			"name": String(child.name),
			"type": child.get_class(),
			"path": _rel_path(root, child),
			"owner_is_scene_root": child.owner == root,
		})
	return out


func _count_nodes(node: Node) -> int:
	var n: int = 1
	for child in node.get_children():
		n += _count_nodes(child)
	return n


func _build_tree(node: Node, rel: String, depth: int, max_depth: int, with_properties: bool) -> Dictionary:
	var info: Dictionary = {
		"name": String(node.name),
		"type": node.get_class(),
		"path": rel,
		"child_count": node.get_child_count(),
	}
	var script_path: String = _script_path(node)
	if not script_path.is_empty():
		info["script"] = script_path
	if with_properties:
		info["properties"] = _editor_properties(node)
	if depth >= max_depth:
		if node.get_child_count() > 0:
			info["truncated"] = true
		return info
	var children: Array = []
	for child in node.get_children():
		var child_rel: String = String(child.name) if rel == "." else "%s/%s" % [rel, child.name]
		children.append(_build_tree(child, child_rel, depth + 1, max_depth, with_properties))
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


func _indent(source: String) -> String:
	var out: String = ""
	for line in source.split("\n"):
		out += "\t" + line + "\n"
	return out


## Start `instance._run()` (or read `mcp_result`) without blocking, recording
## [finished, value] into `state` (an Array is shared by reference).
func _launch_execute(state: Array, instance: Variant) -> void:
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


func _await_until(predicate: Callable, timeout_ms: int) -> bool:
	var deadline: int = Time.get_ticks_msec() + maxi(timeout_ms, 1)
	while true:
		if bool(predicate.call()):
			return true
		if Time.get_ticks_msec() > deadline:
			return false
		await get_tree().process_frame
	return true


func _log_file_candidates() -> Array:
	var out: Array = []
	# 1) an explicit --log-file on the command line. Note: the Godot *editor*
	#    consumes its own arguments, so OS.get_cmdline_args() only reports
	#    ["--editor"] there — pass log_file explicitly in that case.
	var args: PackedStringArray = OS.get_cmdline_args()
	args.append_array(OS.get_cmdline_user_args())
	for i in args.size():
		if String(args[i]) == "--log-file" and i + 1 < args.size():
			var requested: String = String(args[i + 1])
			out.append({
				"path": requested if requested.is_absolute_path() else ProjectSettings.globalize_path("res://").path_join(requested),
				"source": "cli_log_file",
			})
	# 2) the project's configured log path (file logging is off by default, but
	#    a game played from the editor writes here)
	var configured: String = String(ProjectSettings.get_setting("debug/file_logging/log_path", "user://logs/godot.log"))
	if not configured.is_empty():
		out.append({"path": ProjectSettings.globalize_path(configured), "source": "project_log_file"})
	# 3) the usual default locations
	out.append({"path": OS.get_user_data_dir().path_join("logs/godot.log"), "source": "project_log_file"})
	out.append({"path": OS.get_data_dir().path_join("logs/godot.log"), "source": "engine_data_log_file"})
	return out


func _tail_lines(path: String, limit: int) -> Array:
	var f: FileAccess = FileAccess.open(path, FileAccess.READ)
	if f == null:
		return []
	var size: int = int(f.get_length())
	var chunk: int = mini(size, 262144)
	if chunk <= 0:
		f.close()
		return []
	f.seek(size - chunk)
	var text: String = f.get_buffer(chunk).get_string_from_utf8()
	f.close()
	var lines: PackedStringArray = text.split("\n")
	var out: Array = []
	for i in range(maxi(0, lines.size() - limit), lines.size()):
		var line: String = String(lines[i]).strip_edges()
		if not line.is_empty():
			out.append(line)
	return out


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
	if value is Projection:
		return {"x": _variant_to_json(value.x, depth + 1), "y": _variant_to_json(value.y, depth + 1), "z": _variant_to_json(value.z, depth + 1), "w": _variant_to_json(value.w, depth + 1)}
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
