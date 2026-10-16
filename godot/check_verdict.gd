extends SceneTree
#
# `check_verdict.gd` —— deep parse_check 的「这次嵌套检查是否可信地跑完了」判定。
#
# 为什么单独成文件：这个判定出过一次真实事故（Windows CI 第二轮）：
#   · 旧实现把「退出码非 0」一律当成「检查没跑完」，而 Windows 的 `--check-only`
#     在脚本解析失败时**退出码就是 1**（macOS 是 0）→ 真语法错误被记成
#     check_failed/line 0，unique 虚高、affects 丢依赖链。
#   · 改成「字符串里出现 Parse Error/ERROR 就算跑完」又太宽：137（被强杀）或崩溃日志里
#     也可能残留旧文本。
# 所以规则必须是：**只看退出码形状 + 是否真的解析出带定位的诊断**：
#   incomplete（timeout / orphan / still_running / 杀树失败） → 不可信
#   exit == 0                                                  → 可信
#   exit == 1 且 has_located_diagnostic（line>0 且 origin 是脚本路径） → 可信
#   其它任何非零（137、崩溃码…）                                → 不可信
#
# 生产用法：ops.gd 用 `load(<ops.gd 同目录>/check_verdict.gd)` 后调用静态方法
# `check_completed(run, has_located_diagnostic)`。
# 测试用法：`godot --headless --script check_verdict.gd` 会跑下面的判定表并输出
# `@@CHECK_VERDICT@@{...}`，全部通过退出 0、任一条不符退出 1（跨平台，Windows CI 同样跑）。

const MARKER := "@@CHECK_VERDICT@@"

## 判定一次嵌套 `--check-only` 是否**可信地跑完**（不代表「没有错误」）。
## @param run run_capture 的返回字典
## @param has_located_diagnostic 是否解析出 line>0 且 origin 是脚本路径的诊断
## @returns {{completed: bool, incomplete: bool, kill_failed: bool, exit_code: int, reason: String}}
static func check_completed(run: Dictionary, has_located_diagnostic: bool) -> Dictionary:
	var kill_failed := false
	var tree_kill = run.get("tree_kill", null)
	if typeof(tree_kill) == TYPE_DICTIONARY and tree_kill.get("ok", true) == false:
		kill_failed = true
	var incomplete := bool(run.get("timed_out", false)) \
		or bool(run.get("orphaned", false)) \
		or bool(run.get("still_running", false)) \
		or kill_failed
	var exit_code := int(run.get("exit_code", -1))
	var completed := (not incomplete) and (exit_code == 0 or (exit_code == 1 and has_located_diagnostic))
	var reason := "ok"
	if incomplete:
		reason = "incomplete"
	elif not completed:
		reason = "unexplained_nonzero_exit"
	return {
		"completed": completed,
		"incomplete": incomplete,
		"kill_failed": kill_failed,
		"exit_code": exit_code,
		"reason": reason,
	}

## 判定表：[名称, run 字典, has_located_diagnostic, 期望 completed]
static func decision_table() -> Array:
	return [
		["exit0 无诊断（初筛假阳性由调用方处理）", {"exit_code": 0}, false, true],
		["exit0 带定位诊断", {"exit_code": 0}, true, true],
		["exit1 带定位诊断（Windows 解析失败的真实形态）", {"exit_code": 1}, true, true],
		["exit1 无定位诊断（普通 ERROR/无定位）→ 不可信", {"exit_code": 1}, false, false],
		["exit137 即使带 ParseError 文本 → 不可信", {"exit_code": 137}, true, false],
		["exit137 无诊断 → 不可信", {"exit_code": 137}, false, false],
		["timeout（即便 exit0 且带定位诊断）→ 不可信", {"exit_code": 0, "timed_out": true}, true, false],
		["orphaned → 不可信", {"exit_code": 0, "orphaned": true}, true, false],
		["still_running → 不可信", {"exit_code": 0, "still_running": true}, true, false],
		["杀树失败（tree_kill.ok=false）→ 不可信", {"exit_code": 0, "tree_kill": {"ok": false}}, true, false],
		["exit1 带定位诊断但 still_running → 不可信", {"exit_code": 1, "still_running": true}, true, false],
	]

## 自测入口：`--script check_verdict.gd`
func _init() -> void:
	var failures: Array = []
	var passed := 0
	for row in decision_table():
		var name := str(row[0])
		var run: Dictionary = row[1]
		var located: bool = row[2]
		var expected: bool = row[3]
		var actual: Dictionary = check_completed(run, located)
		if bool(actual["completed"]) == expected:
			passed += 1
		else:
			failures.append({
				"case": name, "expected": expected,
				"actual": actual["completed"], "reason": actual["reason"],
			})
	print(MARKER, JSON.stringify({"ok": failures.is_empty(), "passed": passed, "total": decision_table().size(), "failures": failures}))
	quit(0 if failures.is_empty() else 1)
