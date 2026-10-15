@tool
extends EditorPlugin
## Godot MCP Bridge — EditorPlugin entry point (L2 layer).
##
## Enabling this plugin in a Godot project starts a WebSocket server on
## 127.0.0.1:9089 inside the running editor, so an MCP server (or any client)
## can read and mutate the *live* editor scene tree without restarting Godot.
##
## Contract: godot-mcp DESIGN.md §2.2 (frozen).
##   request  {"id": "...", "op": "editor.info", "params": {...}}
##   response {"id": "...", "ok": true,  "data": {...}}
##            {"id": "...", "ok": false, "error": "..."}
##
## The bridge node is a child of this plugin, so it is torn down automatically
## when the plugin is disabled. Port override: GODOT_MCP_BRIDGE_PORT.

const BRIDGE_SCRIPT: String = "res://addons/godot_mcp_bridge/mcp_bridge.gd"

var _bridge: Node = null


func _enter_tree() -> void:
	var bridge_script: Script = load(BRIDGE_SCRIPT)
	if bridge_script == null:
		push_error("Godot MCP Bridge: cannot load %s" % BRIDGE_SCRIPT)
		return
	_bridge = bridge_script.new()
	_bridge.name = "McpBridge"
	add_child(_bridge)
	print("[Godot MCP Bridge] plugin enabled (L2 editor layer)")


func _exit_tree() -> void:
	if is_instance_valid(_bridge):
		if _bridge.has_method("shutdown"):
			# .call() keeps GDScript's static analyser happy (Node has no shutdown()).
			_bridge.call("shutdown")
		_bridge.queue_free()
	_bridge = null
	print("[Godot MCP Bridge] plugin disabled")
