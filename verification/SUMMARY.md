# 验证总表（Lead 汇总）

本文件是**验收口径**：把三层各自的真机证据、我作为 Lead 的独立端到端验证、以及全部已知限制汇总到一处。
分项原始证据见 `ops-gd.md`（L1）与 `bridge.md`（L2/L3）。

引擎：Godot **4.7.2-stable**（official, commit `ed1daf0bf`），macOS 26.5.2 / Apple M1。
所有数字均来自真实进程调用，不是静态检查。

## 1. 自动化测试

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `node --test test/unit.test.mjs` | **45/45 通过** | 协议解析、项目解析、工具契约、批量、cleanJson、INI 幂等、桥安装、手写 WebSocket 客户端（握手/掩码/64 位长度/超时）、桥超时预算与可操作报错、零足迹注入的备份/还原/陈旧回收、**构建指纹与「跑的是旧代码」检测** |
| `node --test test/plugin.test.mjs` | **12/12 通过** | DSH 插件入口（已停用的形态）：工具注册形状、缺服务降级、卸载清理 |
| `node --test test/setup.test.mjs` | **12/12 通过** | **安装器与 profile 补丁**：条目块字段、插进已有 `insert` 子数组且逐字节不碰别人的条目、就地替换旧条目、幂等、坏缩进/缺字段必须被拒、真实 YAML 解析器交叉验证、无解析器时的兜底读取、新建文件时注释位置、临时目录 round-trip |
| `node scripts/verify-wiring.mjs` | **15/15 通过** | **DSH 接线**：接线条目的每个字段、`toolCallTimeoutMs`、插件形态未激活、**按配置真起一次 server**（5 工具 + `serverInfo.build` + 无 stderr 噪音）；没有 DSH profile 的机器明确跳过 |
| `node scripts/verify-mcp.mjs` | **17/17 通过** | **协议层**：initialize（含 `serverInfo.build` 指纹）/ tools/list / tools/call / 错误码，且在**洗过的干净环境**下仍能找到 Godot |
| `node scripts/verify-e2e.mjs` | **19/19 通过** | 环境自检 → 建项目 → 场景/节点 → 脚本 → 设置 → 运行 → 逃生舱 → 装桥 |
| `node scripts/verify-diagnostics.mjs` | **25/25 通过** | **诊断质量**：级联错误归属与归并、新项目类缓存自愈、`run_project` 显示模式回报、**嵌套助手脚本目录**（user:// 不可写时自动回退；显式目录不可写时必须报错，而不是假报「0 个错误」） |
| `node scripts/verify-l2.mjs` | **13/13 通过** | 用本项目 Node WebSocket 客户端连真实编辑器插件 |
| `node scripts/verify-l3.mjs --headless` | **59/59 通过** | 用本项目 Node TCP 客户端控制真实运行中的游戏（零足迹注入与清理、freeze/step/step-until/digest、errors、act/ui、attach/detach），全程无窗口 |
| `node scripts/verify-l3.mjs` | **66/66 通过** | 同上，另含截图相关断言（需要真实帧缓冲）；窗口化点击断言曾偶发失败一次，见 §11.4 |
| `node scripts/verify-export.mjs` | **9/9 通过** | release 导出门控：成品 9091 不监听 + opt-in 后能连 |

合计 **226 项真机断言**（发布前最后一次全量：45 + 12 + 12 + 15 + 17 + 19 + 25 + 13 + 59 + 9）。
README 的「209」口径不含 `verify-mcp`；把 L3 换成带窗口版（66 项）则为 **233 项**。
`verify-l3` 的两种模式是同一套断言的两种运行方式，不计两次（带窗口版比无头版多 7 项截图断言）。

> **为什么需要 `verify-wiring.mjs`（一条教训）**：上面所有业务测试全绿时，插件仍可能**在 DSH 里完全不出现**。
> 因为「DSH 如何发现并加载插件」是独立于业务代码的一条链：
> profile 的 `dependencies` → `dsh.profile.bundles` → 包的 `dsh.bundle.patch`
> → patch 里的 `insert` 条目 → 从 profile 的 node_modules 按包名 import。
> 我一度误以为 profile 里的 bundle patch 冗余而删掉它，结果**重启后 5 个工具全部变成 "unknown tool"**。
> DSH 源码（`dsh-app-boot`）写明：配置树是「按 bundles 顺序，把每个 bundle 的 patch 列表施加到**空条目表**上」
> ——bundle 不声明 patch，就等于贡献零个条目。这个脚本专门守这一环。

## 2. 三层能力实测

### L1 无头操作层（`godot` / `godot_batch`）

27 个契约 op 全部实现并真机验证（ops-engine 报告：65 条成功路径 + 32 条失败路径）。
Lead 侧独立复验的 19 项见 `verify-e2e.mjs`，其中关键几项：

```
create_project   → {"created":true,"renderer":"forward_plus"}                    905ms
create_scene     → {"root_name":"Main","root_type":"Node2D"}                     401ms
add_node×4       → Main/Player, Main/Player/Body, Main/Score, Main/Tick         1547ms
write_settings   → run/main_scene="res://main.tscn"（String 形式，项目可加载）    367ms
run_project      → stdout 含脚本 print，exit 0，timed_out=false
gdscript         → {"result":{"engine":"4.7.2-stable (official)","sum":2}}
```

### L2 编辑器实时层（`godot_connect(target="editor")`，WebSocket 9089）

```
editor.info        → project_path 正确
editor.scene_tree  → 能看到已有节点
editor.add_node    → {"node_path":"McpCam","undoable":true}
editor.set_property→ {"previous":{"x":0,"y":0},"value":{"x":12,"y":34},"undoable":true}
editor.execute     → {"mcp_result":{"engine":"4.7.2-stable (official)"},"returned":true}
editor.save_scene  → {"saved":true,"scene_path":"res://main.tscn"}
未知 op            → ok:false "unknown op: 'editor.no_such_op'"
```

**可撤销性是硬要求且已独立验证**（bridge-layer 用 undo/redo 实测：`undo()` 后节点真的从场景树消失，`redo()` 后回来）。

### L3 运行中游戏层（`godot_connect(target="runtime")`，TCP 9091）

```
rt.call_method bump(7)   → result:7        （有游戏内副作用）
rt.get_property counter  → value:7         （副作用可观测）
rt.set_property  42      → previous:7
rt.input key SPACE       → 注入后 last_key="Space"（游戏内可观测）
rt.eval                  → 42
rt.screenshot            → 640×360 PNG，见 verification/l3-screenshot.png
rt.quit                  → exit_code:0
```

截图内容为 `counter=7`，正是前一步 `rt.call_method bump(7)` 的结果 —— 证明「写入 → 渲染 → 帧缓冲 → base64」全链路真实。

![L3 截图](l3-screenshot.png)

## 3. DSH 集成

插件已作为 `@<scope>/godot-mcp` 装入 desktop profile，并通过 `dsh.profile.bundles` 激活：

```
dependencies: "@<scope>/godot-mcp": "link:$REPO"
dsh.profile.bundles: [..., "@<scope>/godot-mcp"]
```

**会话内实测通过**：`godot_status` 与 `godot_batch` 已在本会话中作为原生工具成功调用，
返回 Godot 4.7.2 版本、ops 引擎就绪、桥端口与会话列表。

> 注意：插件的 JS 模块被 DSH 进程缓存，**修改插件源码后需重启 DSH** 才会生效。
> 若某个工具报 `value is not lossless JSON` 之类的老错误，先重启再重试。

## 4. 修掉的真机 bug（全部由真机测试暴露，非静态审查）

| # | 现象 | 根因 | 修在哪 |
|---|---|---|---|
| 1 | `write_settings` 崩溃并被安全网兜成假成功 | GDScript `and` 两侧都会求值，跨类型 `==` 抛 `Invalid operands` | ops.gd |
| 2 | `write_settings` 写出 `Resource("res://…")` → **整个项目无法加载** | 类型缺失时猜测构造表达式 | ops.gd |
| 3 | `write_file ../../x` 可写出项目外 | 未校验 `..` | ops.gd |
| 4 | `parse_check` 漏报语法错误 | `--check-only` 对语法错误仍 exit 0 | ops.gd |
| 5 | `run_project`/`gdscript` 挂死 2 分钟 | Godot 的 `OS.execute` 多包一层 `sh -c`，看门狗 `$!` 被吃 | ops.gd |
| 6 | `.tscn` 出现重复 `[connection]` | 载入的连接带 `CONNECT_PERSIST`，pack 已写又手工追加 | ops.gd |
| 7 | `create_scene` 根节点名被忽略 + `set_owner` 报错 | 对根节点调用 `set_owner(self)` | ops.gd |
| 8 | 显式指定的错误 Godot 路径会**静默回退**到另一个 Godot 版本 | 路径解析链无严格语义 | src/godot.mjs |
| 9 | `godot_session` 报 `value is not lossless JSON` | 会话对象含 `undefined`（未结束进程无 exitCode） | src/server.mjs `cleanJson` |
| 10 | CLI `install-addon` 与 `godot_session setup` 行为不一致 | CLI 里重复实现了旧路径逻辑 | bin/godot-mcp.mjs |
| 11 | **重启 DSH 后 5 个工具全部消失（unknown tool）** | 我误以为 bundle patch 冗余而删掉它 → bundle 贡献零个条目 | 恢复 `cordis.patch.yml` + `dsh.bundle.patch`，并加 `verify-wiring.mjs` |
| 12 | **release 导出的成品会带一个无鉴权控制端口（rt.eval = 任意代码执行）** | 运行时桥 `_ready()` 无条件监听，无 `is_debug_build()`/`has_feature("editor")` 门控 | godot/runtime/godot_mcp_runtime.gd（见第 6 节） |
| 13 | macOS 导出成功却报「produced no output」 | `FileAccess.file_exists()` 对**目录**（`.app` bundle）返回 false | godot/ops.gd（**已修**） |
| 14 | **就算修好了桥，旧项目里那份桥副本仍是带后门的旧版** | `setup` 只「装/没装」，不比较内容是否过时；项目内副本不会被自动更新 | src/install.mjs（加内容指纹 + stale 告警） |
| 15 | **DSH 里 5 个工具全部不出现（unknown tool），但接线检查全绿** | 用 `ctx.get('tools')` 拿服务、且把它包在 `ctx.effect` 里，拿不到时只 warn 一句就返回 —— 把「注册彻底失败」变成了看不见的软失败 | boot.js：改为 `inject=['tools']` + `ctx.tools.register`（对照可用的 codex-shared），并让失败**抛错**、写诊断文件 |
| 16 | 可选 HTTP 状态路由「注册了但从未生效」 | handler shape 写错：应为 Node 风格 `{kind, path, handler(req,res)}`，实际写成了 `{method, path, handler: async () => ({status,headers,body})}` | 直接移除该可选路由（`godot_status` 工具已覆盖同样需求） |

> #11 和 #12 都是「只有在真实验收路径上才会暴露」的问题：#11 需要真的重启 DSH，#12 需要真的导出成品。
> 两者都说明：**单元/集成测试全绿 ≠ 交付物可用**。

### 4.1 「插件不出现」这道题的完整排查链（可复用）

第 15 条现象是**症状与原因完全分离**的典型：接线全绿、工具却一个不见。
逐层定位用到的证据（都不需要看应用日志）：

1. **组合层**：`cordis_inspect_list` → host/`Config` → `listConfigs`（翻页）→ 确认 `include:godot-mcp`
   这一行**存在**。存在即说明 profile `dependencies` → `bundles` → `dsh.bundle.patch` → `insert` 这四环都通，
   问题不在接线。
2. **注册层**：`cordis_inspect_list` → host/`Tool` → `listTools` → 90 个可调用工具里**没有**任何 godot 工具。
   于是排除「组合失败」，锁定「激活/注册失败」。
3. **对照实验**：`@<scope>/codex-shared` 是同样「bundle-only + 无 Config 导出 + status: absent」的插件，
   但它的 `codex_shared_memory` 工具**在**可调用列表里 —— 说明这套组合方式本身没问题，
   差异只在插件自己的代码。读它的 `boot.js` 即可看到正确写法：`inject = ['tools']` + `ctx.tools.register`。
4. **诊断旁路**：应用是 GUI，看不到插件 console。于是在 `boot.js` 里加了
   `~/.local/share/godot-mcp/boot-status.json`（记录 moduleLoaded / applyCalled / registered / errors），
   一次重启就能区分「模块没被 import」「apply 没被调用」「注册被拒」三种情况。
   注意：这个文件必须校验 `pid` 是不是 DSH 的 pid —— 我自己的测试也会写它，曾经差点把测试写的当成 DSH 写的。

> 教训：**可选依赖要用 inject 声明并让失败显式化**。防御性的 `try/catch + warn + return` 在
> 「服务拿不到」这种场景下会把硬失败伪装成正常工作，而单元测试（用的是假 ctx）永远发现不了。

## 5. 已知限制（如实记录，未伪装通过）

1. **`resave_resources` 在非编辑器 headless 下不生成 `.uid` 旁文件**；需要 UID 请用 `import_assets`。
2. **`rt.screenshot` 在 `--headless` 下不可用**：dummy 渲染器没有帧缓冲，返回明确错误；
   带窗口已验证可用（本文件第 2 节截图）。
3. **`editor.console_log` 读不到编辑器 Output 面板内存**：Godot 4.7 未向脚本暴露 EditorLog，
   只能读日志文件或桥自身的环形缓冲，响应里用 `source`/`note` 标明来源。
4. **`editor.select` 的非 headless `edit_node()` 聚焦分支未验证**（选择状态本身已验证）。
5. **桥不做鉴权且只绑 127.0.0.1**：本机任意进程都能连。这是本地开发工具定位；
   release 导出门控（第 6 节）保证成品默认不开端口。
6. **桥是单客户端模型**（短连接）：并发工具调用可能排队。
7. **仅 macOS 验证**。`run_project` 的输出分离依赖 `/bin/sh`，Windows 需替换实现。
8. **强制 `SIGKILL`（如 `pkill -9`）会让 macOS 上 Godot 产生崩溃报告**（EXC_BAD_ACCESS/SIGABRT）。
   实测：走正常 `stop`（SIGTERM + 宽限期）**不会**产生崩溃报告，已验证两次。
9. **未实现**：目录删除、文件重命名/移动、导出模板安装、`export_presets.cfg` 结构化写入
   （可用 `write_file` 直接写）。

## 6. release 导出门控（安全缺陷 → 修复 → 独立复验）

### 6.1 缺陷（已实际利用，不是理论推断）

L3 运行时桥原来在 `_ready()` 里**无条件**监听 `127.0.0.1:9091`，而 `rt.eval` 等于任意 GDScript 执行。
于是用 `godot_session(action="setup")` 装过桥的项目一旦 release 导出，**成品游戏自带一个无鉴权的本地 RCE 端口**。

利用证据（在修复前的代码上，用真实 release 导出成品复现）：

```
$ dist/ExportGate.app/Contents/MacOS/ExportGate --headless &
[2s] >>> 9091 LISTENING                     # 真实 TCP 探测

# 从另一个进程连上去（模拟任意本地程序）
请求  {"id":"v","op":"rt.eval","params":{"source":"return 6*7
"}}
响应  {"data":{"finished":true,"mcp_result":42,"result":42,...},"ok":true,"op":"rt.eval"}
```

### 6.2 修复后的独立复验（Lead 侧，`scripts/verify-export.mjs`）

```
✔ 探针自检：端口确实开着时，「不监听」判定必须失败（否则验收是空转）
✔ 探针自检：端口开着时，「监听」判定成功
✔ 导出模板已安装 — 4.7.2.stable
✔ 启用 ETC2 ASTC（macOS universal 导出的前置条件）
✔ 导出产物真的存在于磁盘上 — dist/ExportGate.app/Contents/MacOS/ExportGate
✔ A. release 成品长驻运行 20s，端口始终未监听
✔ B. GODOT_MCP_RUNTIME_FORCE=1 → 端口监听
✔ B2. 连上去发 rt.eval → {"result":42,"ok":true}
=== 通过 9/9 ===
```

### 6.3 这道验收里三个「防自欺」设计（都来自踩过的坑）

1. **探针自检**：先起一个真实监听，确认「不监听」判定在端口**真的开着**时会返回失败。
   我第一版把 `wantOpen=false` 写成「观测到关闭即返回成功」，于是进程还没起完就满足条件 → **永远假通过**。
2. **必须长驻探测**：不要用 `--quit-after 600` 限制运行时间。无头模式帧率不受限，600 帧不到 1 秒就跑完退出，
   之后再探测只会得到「没监听」的**假阴性**（我因此误以为没有漏洞）。
3. **不信工具自述**：`export_project` 对 macOS `.app` 目录产物会误报失败（见第 4 节 #13），
   所以验收以**磁盘事实**为准，工具返回值只当附带信息。

### 6.3b 更新路径（修好之后才发现的第二层问题）

修好仓库里的桥**并不等于修好已存在的项目**：运行时桥是被 `setup` **复制进项目**的，
所以在此之前用 `setup` 装过桥的项目，其项目内副本仍是旧版 —— 直接导出依然带后门。
我自己就踩到了：`demo-game` 的副本停留在修复前（`grep bridge_gate_reason` = 0），
重新导出后 release 成品**照样监听 9091**。

处置：`installBridge` 现在对新旧副本做 sha256 比对，并如实回报
`bridge.existedBefore / replacedStale / previousSha256 / installedSha256`；
内容过时时额外给一条可行动警告（提示「用旧桥导出过的成品需重新导出」）。
处置后重新导出 `demo-game` 的实测：

```
A) release 成品长驻 20s 不传 --quit-after   → 全程未监听（门控生效）
B) 同一二进制 + GODOT_MCP_RUNTIME_FORCE=1   → 1s 即监听；rt.eval → {"result":42}
```

### 6.4 导出能力本身（新增验证）

- 导出模板已安装到 `~/Library/Application Support/Godot/export_templates/4.7.2.stable`（35 项，`testzip` 校验通过）。
  获取途径：本机 `github.com` release 下载超时，改走 GitHub API assets 端点
  `https://api.github.com/repos/godotengine/godot/releases/assets/519686380`（`Accept: application/octet-stream`）。
- 产物为有效 universal Mach-O（x86_64 + arm64，170MB）+ `.pck`，可直接运行。
- **实测前置条件**：macOS universal/arm64 导出要求启用 ETC2 ASTC
  （`rendering/textures/vram_compression/import_etc2_astc=true`），否则 Godot 以 `configuration errors` 拒绝导出。
- `export_project` 对 macOS `.app` 的误判已修（第 4 节 #13）：现在返回
  `{ok:true, kind:"directory", bytes:170275944, entries:6}`，与磁盘 `find`+`stat` 独立核对**完全一致**；
  并额外加了「退出码非 0 一律失败」的反误判保护，避免「路径上恰好有旧产物」被冒充成本次成功。
- 非 macOS 平台的产物形态（.apk/.exe/iOS .zip）本机无模板，**未验证**（走同一 `kind:"file"` 分支）。

## 7. 交付形态决策：为什么放弃 DSH 原生插件，改用标准 MCP

### 7.1 结论

对外提供能力的是 **标准 stdio MCP server**（`bin/godot-mcp.mjs` + `src/mcp-stdio.mjs`），
经由 DSH **自带**的 `@deepseek-ai/dsh-mcp-client` 接入，工具名形如 `mcp__godot__godot`。
自写 cordis 插件的源码（`boot.js` + `cordis.patch.yml`）保留但**不启用**
（已从 `dsh.profile.bundles` 移除）。

### 7.2 依据

| 维度 | 原生插件 | 标准 MCP（采用） |
|---|---|---|
| 激活风险 | 高：连续两轮未能在真实 DSH 里稳定激活 | 低：复用 DSH 已在跑的模块（`codex_lms` 就是这条路径） |
| 改代码生效 | 必须重启 DSH（模块被进程缓存） | **改 server 源码：重启该 server 进程即可**（`kill -TERM <pid>`，监管器数秒内自动拉起；客户端侧"重连"**不会**重载 ESM 模块）；改 profile 配置：mcp-client 热重连，无需重启 |
| 实测生效 | 需要重启 | **本机实测：改完 profile 后无需重启，工具当场出现** |
| 服务注入 | 需 `inject=['tools']` + `ctx.tools`；`ctx.get()` 拿不到 | 不涉及（进程外通信） |
| 崩溃影响 | 插件内异常会被 cordis 回滚条目 | 子进程崩溃不影响 DSH，mcp-client 自动重连 |
| 可移植 | 仅 DSH | Codex / Claude Code / Cursor 共用同一 server |
| 协议层验证 | — | `scripts/verify-mcp.mjs` **17/17**（含洗过的干净环境） |

### 7.3 排查这段用的方法（可复用）

现象：**接线全绿、工具一个不见**。分离症状与原因只用了两个活体探针 + 一个对照：

1. `cordis_inspect_list` → host/`Config` → `listConfigs`（翻页 217 条）→
   `include:godot-mcp` **在组合树里** ⇒ 接线四环（dependencies → bundles → bundle patch
   → insert）都通，问题不在接线。
2. host/`Tool` → `listTools` → 90 个可调用工具里**没有任何 godot 工具** ⇒ 问题在激活/注册。
3. 对照：`@<scope>/codex-shared` 是同样「bundle-only、不导出 Config、status=absent」
   的插件，但它的工具**在**列表里 ⇒ 这套组合方式本身没问题，差异只在插件代码。
4. 读可用实现即见正确写法：`inject=['tools']` + `ctx.tools.register`。

> 注意 `status: "absent"` 只表示**没有导出 Config schema**，**不代表没加载** ——
> 误读这一点会把方向带偏。

### 7.4 附带修掉的一个真实浪费

`rt.screenshot` 原来同时回 `base64` / `png_base64` / `data_uri` —— 同一份 PNG 编码三遍。
截图动辄几十上百 KB，等于每次截图浪费约 2/3 的 token。现在只回 `png_base64`
（需要 data URI 自行拼前缀），并在 `verify-l3.mjs` 加了回归断言（实际字段必须是 `["png_base64"]`）。

### 7.5 若要改回插件形态

把 `@<scope>/godot-mcp` 加回 `~/.dsh/profiles/desktop/package.json` 的
`dsh.profile.bundles`，重启 DSH，然后看诊断文件
`~/.local/share/godot-mcp/boot-status.json`（记录 moduleLoaded / applyCalled /
registered / errors；**校验 pid 是否为 DSH 进程** —— 本地测试也会写它）。
不要往 profile 的 `cordis.patch.yml` 里补条目 —— 那条路径按 id 打补丁，不会创建新条目。


## 8. 第二轮：一次真实游戏开发暴露的缺陷（全部已修 + 有回归守卫）

背景：用这套 MCP 从零写了一个 Godot 吃豆人（`$HOME/pacman`）。
游戏本身很早就能跑，**卡住时间的是工具自己的诊断质量** —— 六处改动全部来自那次实战，
每条都有对应的真机断言。

| # | 现象（当时的真实经过） | 根因 | 修法 | 守卫 |
|---|---|---|---|---|
| 1 | `parse_check` 查 5 个文件，5 个全部报 `board.gd:79` 同一条消息，看起来像 5 个 bug | 依赖方加载失败时复述被依赖方的诊断；且旧解析器用「任意 `(file:line)` 出现即更新」，依次被「编译依赖失败」包装帧（`dep1.gd:0`）和引擎自己的 `.cpp` 路径覆盖 | 只认 `Parse Error` 紧邻下一行的位置、且必须是项目内脚本路径；按 `(origin,line,message)` 归并，`cascade` 在归并后计算（与遍历顺序无关） | `verify-diagnostics.mjs` 10 项 |
| 2 | 同一批文件里，另外 3 个依赖脚本**根本没被检查** | 进程内初筛：某个全局类第一次解析失败后，同进程后续引用它的脚本 reload() 反而返回 OK（实测 4 个同结构脚本只有第 1 个被判可疑） | 新增 `parse_check{deep: true}`：跳过初筛，逐文件真跑 `--check-only` | 同上（deep 下 `affects` 必须记全 5 个） |
| 3 | 新建项目里第一次 `attach_script` 必失败：`Could not find type "Pacman"` | 项目从未被扫描，`.godot/global_script_class_cache.cfg` 不存在；而全局类列表只在引擎启动时载入，同进程内 reload 无效 | Node 层捕获该错误后补一次 `import_assets`，再换**新进程**重试；结果带 `retriedAfterImport` | `verify-diagnostics.mjs` 4 项 |
| 4 | 连拍两张截图**字节完全相同**；后来又出现「迷宫是新的、HUD 和 READY 是旧的」 | 只 `await get_tree().process_frame` 取到的是陈旧缓冲 | 改为 `await RenderingServer.frame_post_draw` | `verify-l3.mjs`：两次截图 `captured_frame` 必须不同 |
| 5 | `rt.screenshot` 传了 `path` 却**被静默忽略**，仍回一大坨 base64 | 参数没实现，且不认识的参数不报错 | 实现 `path`（落盘、默认不回 base64）与 `inline`；只在显式要求时编码 | `verify-l3.mjs` 4 项（落盘/不回 base64/尺寸/inline） |
| 6 | `rt.eval` 报「等待运行时响应超时」，完全不提怎么补救；长驻窗口失焦后定时器停摆 | 客户端硬编码 15s 且报错无指向；macOS App Nap/空闲休眠冻结进程 | 按 op 自适应预算 + 超时报错点名该调哪个参数与 `frame_post_draw` 这个经典挂起源；长驻会话用 `caffeinate` 包住（`keepAwake`，可关） | `unit.test.mjs` 2 项 + `pmset -g assertions` 实测（运行中 5 条断言、stop 后归零） |

`run_project` 同时补了 `display`（`dummy`/`window`）与 `note` 字段：它**默认 headless**，
没有帧缓冲，拿它去截图会收获一个永久挂起 —— 这种代价不该由调用方靠 180 秒超时去发现。

> 这一轮的教训写进代码注释了：**当异常现象只出现在我自己插桩的运行里时，先怀疑插桩**。
> 上面第 4 条我一度判定为「渲染撕裂」，真因是驱动节点时用了 `process_mode = DISABLED`，
> 它连子节点 HUD 的 `queue_redraw` 一起冻结了 —— 与渲染管线毫无关系。

## 9. 第三轮：对照开源生态补齐「验收闭环」（已实现 + 真机验证）

对照了社区横向对比（[Erodenn/godot-mcp-runtime 的 comparison.md](https://github.com/Erodenn/godot-mcp-runtime/blob/main/docs/comparison.md)，
它把被滥用的 "runtime" 拆成文件层 / 编辑器实时层 / 运行中游戏层）以及
[satelliteoflove/godot-mcp](https://github.com/satelliteoflove/godot-mcp)、
[hi-godot/godot-ai](https://github.com/hi-godot/godot-ai)、
[tugcantopaloglu/godot-mcp](https://github.com/tugcantopaloglu/godot-mcp) 的实际工具面之后，
补上了差距最大的一档：**让 agent 能确凿地验证自己的改动**。

### 9.1 零足迹注入（原来必须把桥 commit 进用户项目）

关键实验：**Godot 会读取项目根 `override.cfg` 里的 `[autoload]` 并真的注册 autoload**，
而 `project.godot` 一个字都不用改；且 autoload 脚本可以放在 `res://.godot/` 下
（Godot 自己的目录，约定已被忽略）。于是注入 = 临时多两个文件。

没有采用「改写 project.godot 再还原」：那要覆盖用户正在编辑的文件，任何一次崩溃或强杀
都可能留下被改坏的项目配置。`override.cfg` 方案永不触碰已有内容；用户自己已有的
`override.cfg` 会先备份再合并，退出时原样还原。

| 断言 | 实测 |
|---|---|
| auto 模式在未安装桥的项目上自动选 transient | `bridge.mode=transient` |
| `project.godot` 全程逐字节不变 | 与写入时比较一致 |
| 只多出 `override.cfg` + `.godot/mcp_bridge/` | 是 |
| 停止后两者都被清掉、目录恢复原状 | `{removedOverride:true, removedScript:true}` |
| 用户自己的 `override.cfg` 被保住并还原 | 单测覆盖 |
| 上次崩溃的残留会在下次注入前自愈 | 单测覆盖 |
| `attach`（游戏由外部启动）只注入不启动、可 `detach` | 外部启动的游戏确实被接上 |

### 9.2 确定性时间控制（原来只能「等真实时间然后祈祷」）

这一条直接来自第二轮踩的坑：窗口失焦被 App Nap 冻结、定时器停摆、截图拿到陈旧帧。
根因是**观察和推进在抢跑**。现在：

```
rt.freeze  → rt.digest → rt.step{frames:30} → rt.digest → rt.resume
```

- `freeze` 默认**硬冻结**：`get_tree().paused=true` **且** `Engine.time_scale=0`。
  只置 `time_scale` 是不够的 —— 实测 `_process` 仍会被每帧调用，只是 `delta=0`，
  于是按帧计数的逻辑照样在跑（`frames` 从 24 涨到 59）。硬冻结下帧计数真的不动。
- `step` 以**帧**为确定性单位；`ms` 模式报告实际推进量而非假装精确。
- `step{until}` 用 `Expression` 求值。**踩坑**：`Expression` 看不到 `Engine`/`Input`/
  `Performance` 这些全局单例（报 `Invalid named index 'Engine' for base type Object`），
  必须作为显式输入传入 —— 现在 `tree/node/self/Engine/Input/Performance/OS/Time/ProjectSettings` 都可用。
- `until` 条件永不成立时如实回 `satisfied=false`，不假装成功。
- 冻结超过 120 秒且无客户端连接会**自动解冻** —— 否则客户端一崩，用户拿到的是一个
  永远卡死、自己又没法解冻的游戏。

### 9.3 结构化状态 digest（原来只能截图）

`rt.digest{groups?,paths?,classes?,props?,limit?}` 直接把节点状态变成 JSON，
不用为看一个数字去花 vision token。选择器可以是 group / 路径 / 类名，
没给选择器时默认「当前场景根 + 直接子节点」（不默认扫全树，避免大项目把结果撑爆）。
不存在的 group 会出现在 `missing_groups` 里而不是静默返回空。

立刻就用上了：吃豆人项目的验证不再需要截图 ——
`rt.digest{paths:["/root/Main"],props:["score","lives","level","state"]}` 直接读出
`{"level":1,"lives":3,"score":0,"state":0}`。

### 9.4 顺带：吃豆人项目不再需要提交桥

`$HOME/pacman` 原来装了提交式桥（`addons/` + `project.godot` 的
`[autoload]`）。第三轮之后整个 `addons/` 已删除、`project.godot` 恢复干净，
运行时控制改走零足迹注入 —— 实测 `bridge.mode=transient`、`rt.info`/`rt.digest`/
`rt.freeze`+`rt.step` 全部可用，会话结束后项目目录无残留。

### 9.5 仍未实现（如实记录）

- **背景/离屏模式**（Erodenn：窗口移到 `(-9999,-9999)`、borderless、不可聚焦、鼠标穿透）
- **输入序列批处理 + 每步回报**（命中哪个 Control、触发哪些信号、屏幕变了什么）
- **UI 元素发现与按名字点击**
- **运行时错误捕获（带 backtrace）** —— 目前仍只有 stdout 环形缓冲
- **MCP Resources**、编辑器视口截图、原子批量回滚、分页、函数级 profiler

## 10. 第四轮：可观测性与「扮演玩家」（已实现 + 无头真机验证）

补的是第二档里最要紧的两个闭环：**agent 能不能自己发现改坏了**、**能不能真的操作游戏**。

### 10.1 `rt.errors` —— 运行时错误捕获（带 backtrace）

实现走 `OS.add_logger(Logger)`：引擎把每一条错误送进 `_log_error()`，并附带真实的
`ScriptBacktrace`。捕获脚本运行时错误、`push_error`、`push_warning`，环形缓冲 300 条，
支持 `since` 增量读、按类型过滤、`clear`。

**一个不查就一定会写错的细节**：`_log_error` 给的 `file`/`line` 对 `push_error` 来说
指向**引擎内部**（实测 `core/variant/variant_utility.cpp:1023`），真正属于用户脚本的位置
只在 backtrace 里。所以定位要取 backtrace 中第一个 `res://` 帧 —— 否则报出来的位置是
引擎源码，对排查毫无用处。

| 断言 | 实测 |
|---|---|
| 捕获真实脚本运行时错误 | `Out of bounds get index '2' (on base: 'Array')` |
| 定位到用户脚本而不是引擎 .cpp | `res://game.gd:47 in raise_error()` |
| 带调用链 | `[{game.gd:47 raise_error}, {godot_mcp_runtime.gd:1364 _act_step}]` |
| `push_warning` 归类为 warning | `L3VERIFY_WARNING` |
| `since` 增量读 / 按类型过滤 / `clear` | 均通过 |
| `rt.step` 汇报窗口内新增错误数 | 埋雷后 `errors_new=1`；不埋雷时 `errors_new=0`（如实） |

### 10.2 `rt.act` + `rt.ui` —— 输入序列与逐步回报

一次调用跑完整串操作（`wait/press/release/tap/move/click/text/call`），**每一步回报**
「点到了哪个 Control」与「这一步之后被观察节点的状态」。序列期间临时解冻
（`paused` 下输入根本不会被处理），跑完冻回去。

| 断言 | 实测 |
|---|---|
| 完整序列执行 | `executed=3/3 aborted=false` |
| 每步回报命中的 Control | `/root/Main/StartBtn [Button] "Start"` |
| 点击真的触发了按钮 | `clicks 0 → 1` |
| 每步回报被观察节点状态 | `initial.clicks=0 → step0.after.clicks=1` |
| 坏步骤如实报错并中止 | `executed=2/3`，失败步 `ok=false` |
| `continue_on_error=true` | `executed=2 aborted=false` |
| 未知步骤类型 | 明确拒绝，不静默忽略 |
| `rt.ui` 控件清单 | `count=2`，含 rect / text / disabled / mouse_filter |

### 10.3 本轮踩到并写进文档的一个真坑：headless 的根视口只有 64×64

`verify-l3` 的点击断言一开始在无头下失败（`clicks 0 → 0`）。定位过程：
写了一个最小复现，同一个按钮、同一段注入代码，只切换显示模式 ——

```
headless : RECT=[P:(20,20) S:(120,40)]  ws=[P:(0,0) S:(64,64)]   pressed=0  hovered=<null>
windowed : RECT=[P:(20,20) S:(120,40)]  ws=[P:(0,0) S:(320,180)] pressed=1  hovered=B:<Button>
```

**根视口尺寸不同**：无头是 dummy DisplayServer 给的 64×64，点击点 (80,40) 落在视口外，
GUI 根本不会派发。不是注入代码的问题。

处理方式：把测试按钮放进 64×64 内，让**同一套断言在两种模式下都成立**（而不是把断言删掉
或在无头下假装跳过）。这个限制已写进 DESIGN.md 与 README 的已知限制 —— 它对使用者的
实际含义是「无头模式下只能测视口左下 64×64 内的 UI 交互」。

### 10.4 本轮验收的执行方式（吸取上一轮教训）

上一轮为了排查一个问题反复起窗口，把用户桌面刷了一屏。本轮：

- 新增/修改的断言全部在 **`verify-l3.mjs --headless`** 下跑通，**全程零窗口**
- 无头可跑的套件一次性批量跑完：单元 52 + 接线 14 + 端到端 19 + L3 59 = **144 项全绿**
- `verify-diagnostics` / `verify-l2` / `verify-export` 需要真实显示（游戏窗口 / 编辑器窗口 / 成品窗口），
  **本轮未跑**，如实标注而不是当作通过

### 10.5 仍未实现

UI 按名字点击的模糊匹配、输入序列的时序断言（每步的墙钟抖动）、
运行时错误与 `rt.step` 的自动关联（现在只给计数，不给"是哪一步炸的"）、
背景/离屏模式、MCP Resources、编辑器视口截图、原子批量回滚、分页、函数级 profiler。

## 11. 第五轮：全量重跑暴露的三个缺陷（已修 + 有回归守卫）

背景：2026-10-15 把 README 列的套件**全部**重跑一遍（含上一轮标注「未跑」的
diagnostics / l2 / export），并额外用活体 MCP 工具（`mcp__godot__*`）做了一次
不经仓库脚本的端到端。本轮改动全部来自那次重跑，每条都有对应断言。

| # | 现象（当时的真实经过） | 根因 | 修法 | 守卫 |
|---|---|---|---|---|
| 1 | 活体 server 是 **68 分钟前的构建**：`godot_session(game)` 不注入桥、`godot_connect(runtime)` 直接 `ECONNREFUSED`，而仓库里的代码是对的 | mcp-client 把 server 当长驻子进程托管，ESM 模块进了内存就不再重读；**当时没有任何字段能说明「你在跑旧代码」** | 新增 `src/build.mjs`：进程启动时把**自己实际加载的**源码算成短 hash；`godot_status` 返回 `server.pid` + `build.loaded/onDisk/stale`，`stale` 时直接给出 `kill -TERM <pid>`；`initialize` 的 `serverInfo.build` 让客户端一连上就能看到 | `unit.test.mjs` 5 项（稳定性 / 对内容敏感 / 陈旧检测 / probe 字段 / initialize 字段） |
| 2 | `user://` 不可写时（沙箱化 agent、只读 HOME、CI 容器），deep `parse_check` **返回「0 个错误」** —— 把「一个文件都没检查过」报成「代码是干净的」 | 助手脚本只写 `user://mcp_tmp`，写不进去就只回一句文本；deep 分支只用 stderr/stdout 文本判定，于是静默跳过每一个文件 | ① 助手脚本目录改为「`user://` → 系统临时目录」依次尝试；② 新增 `GODOT_MCP_HELPER_DIR` 显式指定（**严格**语义：设了只用它）；③ 五个嵌套调用点（run_project / gdscript / import_assets / export_project / deep parse_check）在 `spawn_error` 时**一律 `finish_error`** | `verify-diagnostics.mjs` 5 项（含两个前置探针，防止断言空转） |
| 3 | 同上前提下 `run_project` / `gdscript` 只回 `cannot create helper script <很长路径>`，既不像失败也不说怎么修 | 错误信息里没有原因与补救 | 见 #2 ③：`spawn_error_message()` 统一给出「候选目录 + 底层 error + 用 `GODOT_MCP_HELPER_DIR` 怎么办」 | 同上（run_project 那条断言要求错误文本里出现可操作指引） |

### 11.1 为什么 #1 要用指纹，而不是靠人记得重启

「改完源码要重启进程」是长驻架构的固有性质，但**没有指纹时它无法被观测**：
本轮是靠 `ps -o lstart` 对比 `ls -lT` 才确认的，而这要求先怀疑到这一层。
现在 `godot_status` 一行 `stale: true` 就说明白了，`build.loaded` 也能直接和发布记录对照。

### 11.2 为什么 #2 算「正确性」而不是「可用性」

调用方拿到 `unique_errors: 0` 会直接下结论「代码没问题」—— 这是诊断工具最不能犯的错。
现在这条路径只有两种结果：回退成功 → 给出真实结论；两个目录都写不了 → 明确失败。
**不存在第三种。**

### 11.3 本轮重跑的环境坑（如实记录）

`workspace-write` 文件沙箱下，同一批套件会跑出 **163 pass / 18 fail**，全部是写入
`~/Library/Application Support/Godot/app_userdata/**/mcp_tmp/` 与 `~/.local/share/godot-mcp/transient.json`
被拒（`EPERM`）导致的环境假失败；换 `danger-full-access` 后同样的命令全绿。
也就是说 **#2 的触发条件在真实世界里并不罕见** —— 本会话第一次重跑就撞上了。

### 11.4 本轮**未**修的（如实记录，未伪装通过）

- **窗口化点击注入偶发失败**：同一条断言出现过 65/66（失败态 `clicks 0 → 0`）与 66/66 各一次；
  无头模式稳定 59/59；`hit` 命中判定两次都正确，怀疑与真实光标/窗口焦点有关
  （`DisplayServer.warp_mouse`）。没定位到可复现的最小条件，因此不改代码，只记录。
- **零足迹注入在游戏自行退出时不清理**（`rt.quit` / 关窗 / 崩溃）：只有显式 `stop` 才清。
  兜底是 `godot_session(action="cleanup")` 与下次注入前的自愈（两者都实测有效），本轮未改成自动清理。
- `parse_check` 成功时不汇报「用了哪个助手目录」，只在失败信息里给出候选与原因。
