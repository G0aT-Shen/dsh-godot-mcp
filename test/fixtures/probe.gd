# 事实基线脚本：由 lead 用来在自己的测试夹具上验证 Godot 行为（不属于交付物）。
extends SceneTree

func _init() -> void:
	var args := OS.get_cmdline_args()
	var marker := "--probe"
	var index := args.find(marker)
	var payload := "{}"
	if index != -1 and args.size() > index + 1:
		payload = args[index + 1]
	var data: Variant = JSON.parse_string(payload)
	var out := {
		"ok": true,
		"data": {
			"version": Engine.get_version_info()["string"],
			"cwd_project": ProjectSettings.globalize_path("res://"),
			"project_name": ProjectSettings.get_setting("application/config/name", ""),
			"argc": OS.get_cmdline_args().size(),
			"echo": data,
		},
	}
	print("@@PROBE@@" + JSON.stringify(out))
	quit(0)
