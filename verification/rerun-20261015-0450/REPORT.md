# Godot MCP 全量重跑报告（2026-10-15 04:50–05:05）

结论先行：**代码主体是可信的（正常环境下 203 项断言全绿，双模式合计 269 项），但交付链路上有 3 个真问题**：
① DSH 里跑着的 MCP server 是 68 分钟前的旧构建（静默陈旧）；② 嵌套执行不可用时 `parse_check{deep}` 会**假报「无错误」**；
③ 零足迹注入在游戏**自己退出**时不清理。另有窗口化点击偶发失败、文档数字漂移、打包卫生等次要问题。

## 1. 重跑结果（全部为本机真机执行，日志在同目录）

| 套件 | 断言 | 结果 | 日志 |
|---|---|---|---|
| `node --test test/unit.test.mjs test/plugin.test.mjs` | 52 | ✅ 52/52 | `full-unit.log` |
| `scripts/verify-wiring.mjs` | 14 | ✅ 14/14 | `full-wiring.log` |
| `scripts/verify-mcp.mjs` | 17 | ✅ 17/17 | `full-mcp.log` |
| `scripts/verify-e2e.mjs` | 19 | ✅ 19/19 | `full-e2e.log` |
| `scripts/verify-diagnostics.mjs` | 20 | ✅ 20/20 | `full-diagnostics.log` |
| `scripts/verify-l3.mjs --headless` | 59 | ✅ 59/59 | `full-l3-headless.log` |
| `scripts/verify-l2.mjs` | 13 | ✅ 13/13 | `full-l2.log` |
| `scripts/verify-l3.mjs`（带窗口） | 66 | ⚠️ 65/66 → 重跑 66/66 | `full-l3-windowed.log` / `-rerun.log` |
| `scripts/verify-export.mjs` | 9 | ✅ 9/9 | `full-export.log` |

- 按 README 口径（不含 verify-mcp）合计 **186 项**，与 README 一致；把 verify-mcp 计入口径为 **203 项**（无头 L3），两种 L3 模式都算为 **269 项**。
- **第一次（workspace-write 沙箱内）跑出 163 pass / 18 fail，全部是环境假失败**：写入 `~/Library/Application Support/Godot/app_userdata/**/mcp_tmp/`（嵌套进程助手脚本）与 `~/.local/share/godot-mcp/transient.json` 被沙箱判为 `EPERM`。原始日志：`verify-*.log`（同一目录），可对照。
- 交付路径（DSH → mcp-client → node → godot）不受该沙箱影响：用活体 MCP 工具 `gdscript`/`run_project` 均返回 `exit_code: 0`。

## 2. 活体 MCP 端到端（不经过仓库脚本，直接用 `mcp__godot__*` 工具）

在 `/tmp/godot-mcp-livecheck` 上完成：`create_project` → `godot_batch`（建场景/加节点/写脚本/挂脚本/写主场景）→ `run_project`（stdout 含 `LIVE_READY clicks=0`，`display=dummy`）→ `godot_session(game)`（零足迹注入）→ `rt.ui`（列出 `StartBtn`）→ `rt.act`（命中按钮，`clicks 0 → 1`，逐步回报）→ `rt.digest` → `rt.freeze`/`rt.step`（`frames:30`，`errors_new:0`）→ `rt.resume` → `rt.errors`（`recorder:true, total:0`）→ `rt.quit`（`exit_code:0`）→ `godot_session(cleanup)`（`swept:1, cleaned:true`）。

其中 `rt.screenshot` 在无头下如实报错：`rt.screenshot needs a real display driver; the headless dummy renderer has no framebuffer (run the game without --headless)` —— 属于「不假装成功」的正例。

## 3. 发现（按严重度）

### F1（高）DSH 里的 MCP server 静默跑旧代码，且没有任何版本指纹可发现
- 活体进程 PID 27798 启动于 **03:47:24**，而 `src/processes.mjs`(04:33)、`src/inject.mjs`(04:35)、`src/server.mjs`(04:43)、`godot/runtime/godot_mcp_runtime.gd`(04:43) 都在其后被修改。
- 现象：活体 `godot_session(action="game")` 返回的 session **没有 `bridge` 字段、不注入 override.cfg**，随后 `godot_connect(runtime)` 报 `ECONNREFUSED`。
- 对照：新起进程（当前代码）同一调用返回 `bridge.mode=transient, injected=true, projectFileUntouched=true`。
- 修复验证：`kill -TERM 27798` → mcp-client 的连接监管器在数秒内重启（新 PID 36100），同一调用立刻返回 `bridge.mode=transient`，工具未中断。
- 文档不符：README §7.2 写 MCP 形态「改代码生效 = 重新连接即可」，但**从客户端重连不会重载 node 进程**，必须让 server 进程重启。`godot_status` 也没有 build/version 指纹，调用方无法察觉自己在跑旧代码。

### F2（高，正确性）嵌套检查跑不起来时，`parse_check{deep:true}` 假报「无错误」
- 复现：把 `~/Library/Application Support/Godot/app_userdata/PC Probe/mcp_tmp` 置为 `dr-x------`（不可写）。
- 基线（可写）：同一组 fixture（`base.gd` 有类型错误、`dep.gd` 依赖它）→ `unique_errors: 4, suspect: 2`。
- 不可写：`{"ok": true, "checked": 2, "deep": true, "errors": [], "unique_errors": 0}` —— **同一个项目、同一批文件，报告「全清白」**。
- 代码位置：`godot/ops.gd:1834-1837` 只用 `sh_capture()` 的 stderr/stdout 文本判定，助手脚本创建失败时既不报错也不计入结果。
- 这正是本会话第一次（沙箱内）重跑 diagnostics 时看到的现象：`unique=0 cascade=0 errors=[]`。
- 影响场景真实存在：沙箱化 agent、CI 容器、只读 HOME/XDG、Godot user 目录权限异常。

### F3（中）助手脚本不可写时的报错不可行动
`run_project` / `gdscript` 返回 `{"exit_code": -1, "duration_ms": 0, "stderr": "cannot create helper script <很长路径>"}`，既不说明原因也不给补救办法（对比 `rt.screenshot` 的报错质量）。

### F4（中）游戏自己退出时，零足迹注入不清理
`rt.quit`（或窗口关闭/崩溃）后 `override.cfg` 与状态文件条目仍留在项目里；只有显式 `stop` 才清理。缓解手段存在且实测有效：`godot_session(action="cleanup")` 返回 `{cleaned:true, removedOverride:true, removedScript:true}`，下次会话注入前也会自愈。

### F5（中）带窗口的 `rt.act` 点击偶发失败
同一条断言两次带窗口运行 65/66（失败：`clicks 0 → 0`）与 66/66；无头模式稳定 59/59。命中判定（`hit`）两次都正确，说明不是命中测试问题，更像 `DisplayServer.warp_mouse` 依赖真实光标/窗口焦点。文档称「要测真实 UI 交互必须带窗口」，与实际偶发相反。

### F6（低）文档数字漂移
`verification/SUMMARY.md` §1 仍写「合计 174 项」及旧的分项（单元 40+12、L3 47），与当前脚本（52、59/66）不符；README 的 186 与实测一致。SUMMARY §10.4 已如实标注当轮未跑部分套件（诊断/L2/导出）。

### F7（低）MCP 协议细节
- `initialize` 直接回显客户端给的 `protocolVersion`，未校验是否支持（`src/mcp-stdio.mjs:31`）。
- 进度通知 `progress: Date.now() % 1e9` 非单调，与规范「should increase」不符。
- `notifications/cancelled` 是空实现；handler 的 `exec.signal` 管线存在但 stdio 侧从未传入。

### F8（低，打包卫生）
无 `.git`、无 `LICENSE`（只有 `NOTICE`）、无 `.gitignore`、无 CI；仓库 554MB（`tools/` 505MB，其中 `godot.zip` 170MB 与已解包的 `Godot.app` 重复；`reference/` 48MB 上游 clone）。作为本地工具尚可，作为可分发包不合格。

### F9（提示，非缺陷）
- `godot_session` 未知 action 的提示只列 `list/editor/game/stop/logs`，漏了 `attach/detach/cleanup`。
- `rt.step` 回传的 `frame` 是引擎全局帧计数，暂停期间照样增长（实测 1011 → 1270，30 帧的 step；`resume` 时 2762），确定性的量是 `frames`；套件断言测的是游戏自己的帧计数，与文档一致。

## 4. 站得住的部分（同样有证据）

- **零运行时依赖**（纯 Node 标准库），无供应链与 lockfile 负担。
- **防自欺的验收设计**：导出探针先自检「端口真开着时必须判定失败」、`project.godot` 逐字节比对、两张截图必须不同帧、「不信工具自述，以磁盘事实为准」。
- **安全**：release 成品默认不开 9091，`GODOT_MCP_RUNTIME_FORCE=1` 才开（`verify-export` 9/9 独立复验）；旧桥副本按 sha256 检出并告警；`write_file` 的 `..` 穿越已修。
- **错误诚实度**：无头截图、`run_project` 的 `display/note`、`parse_check` 的 deep 取舍均写在返回里；`cleanJson` 保证 DSH 的 lossless JSON 约束。
- **文档深度**：README 225 行含真实踩坑表，DESIGN.md 冻结接口契约，SUMMARY.md 446 行含「已知限制」与「仍未实现」。

## 5. 成熟度判定

**工程成熟度高、产品化不足。** 三层能力真实可用、验证密度罕见（203–269 项真机断言，且多数是「反过来证明自己没撒谎」的设计），
但按「成熟项目」的三条硬标准还差：交付链路可自证（F1，缺版本指纹/陈旧检测）、
降级路径不产生错误结论（F2，假「全清白」）、以及可分发的最小工程面（F8，LICENSE/.gitignore/CI）。
把 F1、F2 修掉（各约十行量级：加 build 指纹 + 助手失败时如实报错），这个项目就从「很能打的个人工具」进入「可依赖的工具链」。

---

## 6. 修复记录（同日 05:00–05:06，全部带回归守卫）

| 问题 | 修法 | 守卫 | 复验证据 |
|---|---|---|---|
| **F1** 活体 server 跑旧构建、且没有任何字段能发现 | 新增 `src/build.mjs`：进程启动时把**自己实际加载的**源码算成 12 位短 hash；`godot_status` 回报 `server.pid` + `build.loaded/onDisk/stale`（stale 时直接给出 `kill -TERM <pid>`）；`initialize` 的 `serverInfo.build` 同样暴露 | `unit.test.mjs` 5 项 | **活体实测**：给 `src/tools.mjs` 追加一行 → `stale: true`（`onDisk f0404f200c55` ≠ `loaded 97b940b3be53`，`note` 给出修法）→ 还原（sha 一致）→ `stale: false` |
| **F2** `user://` 不可写时 deep `parse_check` 假报「0 个错误」 | ① 助手脚本目录改为 `user://` → 系统临时目录**逐个尝试**；② 新增 `GODOT_MCP_HELPER_DIR`（严格语义：设了只用它）；③ 五个嵌套调用点（run_project / gdscript / import_assets / export_project / deep parse_check）在 `spawn_error` 时**一律 `finish_error`** | `verify-diagnostics.mjs` 5 项（含 2 个前置探针，防断言空转） | 手工复核：`user://` chmod 500 → 仍报出 4 个错误（回退生效）；显式坏目录 → `ok:false` + `GODOT_MCP_HELPER_DIR` 指引 |
| **F3** 助手脚本不可写的报错不可行动 | `spawn_error_message()`：统一输出「试过哪些目录 + 底层 error + 怎么修」 | 同上（run_project 那条要求错误文本含可操作指引） | 见 F2 |
| **F6** 文档数字漂移 | SUMMARY §1 全表重写（213 项）、§6.2 的 `10/10` → `9/9`、§7.2「改代码生效」更正、新增 §11；README 验证段与踩坑表同步；DESIGN §2.1/§2.4 补契约 | — | 每个数字都能对上 `fix-*.log` |

### 6.1 修完后的全量验收（同一批套件，全部真机）

| 套件 | 断言 | 结果 | 日志 |
|---|---|---|---|
| unit + plugin | 57 | ✅ 57/57 | `fix-final-unit.log` |
| wiring | 14 | ✅ 14/14 | `fix-wiring.log` |
| mcp | 17 | ✅ 17/17 | `fix-final-mcp.log` |
| e2e | 19 | ✅ 19/19 | `fix-e2e.log` |
| diagnostics | 25 | ✅ 25/25 | `fix-diagnostics.log` |
| l3 --headless | 59 | ✅ 59/59 | `fix-l3-headless.log` |
| l2 | 13 | ✅ 13/13 | `fix-l2.log` |
| l3（带窗口） | 66 | ✅ 66/66 | `fix-l3-windowed.log` |
| export | 9 | ✅ 9/9 | `fix-export.log` |

**279 项断言全部通过**（57+14+17+19+25+59+13+66+9；L3 两种模式各算一次）。

### 6.2 本轮**未**修（如实列出，未伪装通过）

- 窗口化 `rt.act` 点击偶发失败（未定位到可复现的最小条件；无头稳定）。
- 零足迹注入在游戏**自行退出**时不清理（`cleanup` 与下次注入的自愈是兜底，实测有效）。
- `parse_check` 成功时不汇报「用了哪个助手目录」（只在失败信息里给出候选与原因）。
