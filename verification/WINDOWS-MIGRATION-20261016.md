# Windows DSH 独立使用：兼容性检查与迁移方案

> 本文是实施前的历史评估，问题和测试数量对应下述检查基线。后续已实施适配并执行原生 Windows CI；当前实现、验证结果与剩余桌面验收项见 [实施与验收报告](WINDOWS-IMPLEMENTATION-20261016.md)。

日期：2026-10-16。检查基线：`698790cc929ad036610ca813bdc21369781a07e5`，Node 运行时代码指纹 `3e3aa064b2a1`。

## 结论与范围

当前版本不能按“原生 Windows 桌面 DSH 可完整使用”交付。标准 stdio MCP 和本地 TCP 桥的架构可以沿用，但安装配置、Godot 定位、嵌套进程执行及进程树清理需要适配。

用户目前没有 Windows 验收环境。本轮完成源码检查、可在当前机器复现的配置问题，以及迁移设计；不把 macOS 的成功记录当作 Windows 通过，也未实施 Windows 功能改造。当前桌面 DSH 更新和实际工具调用的证据另见 [DSH 更新报告](DSH-UPDATE-20261016.md)。

最终运行目标：一台 Windows 电脑上的桌面 DSH，通过其自带 `@deepseek-ai/dsh-mcp-client` 启动本地 Node MCP server，控制同机 Godot。交付不依赖这台 Mac、Codex、Codex–DSH 协作桥、WSL、Git Bash 或远程代理。协作桥只是本轮派工工具。

## 已确认的问题

| 优先级 | 位置（基线行号） | 证据与影响 | 迁移要求 |
| --- | --- | --- | --- |
| P0 | `godot/ops.gd:525`、`:589` | `sh_capture` 写 POSIX 脚本，并硬编码 `OS.execute("/bin/sh", …)`；脚本还调用 `sleep`、`kill`、`pkill`。原生 Windows 无法按此执行。影响资源导入、导出、L1 `run_project`、深度 `parse_check` 和 `gdscript`。 | 使用原生、无 shell 的进程执行方案，保留参数边界、stdout/stderr、退出码、超时与取消语义。 |
| P0 | `scripts/lib/profile-patch.mjs:118` | `validatePatchText` 的 command 正则要求以 `/` 开头，`C:\…\node.exe` 会被判缺失。`scripts/setup.mjs:252` 在写配置前使用它，因此正常盘符路径也会阻止自动接线。 | 校验 Windows 盘符绝对路径和 UNC 路径；与 YAML 解码后的真实字段一致。 |
| P1 | `scripts/lib/profile-patch.mjs:38` | 路径直接拼成 YAML 普通标量。已复现 `C:\DSH #1\…` 被真实 YAML 解析器截为 `C:\DSH`；兜底解析器却返回完整字符串，造成自检与实际加载不一致。普通空格、中文、反斜杠路径本身不必然失败。 | 规范引用所有路径标量，同时修正 `parseEntryLoose` 的反转义和列表/env 解码，验证真实解析结果。 |
| P1 | `src/godot.mjs:20`、`:99` | bundled/system 候选集中在 macOS；PATH 只找 `godot4/godot/Godot`，没有 `.exe`/PATHEXT。可显式配置真实 exe 绕过定位问题，但不能绕过其他阻碍。 | 支持 Windows 官方版本文件名、exe/PATHEXT；首次安装将选中的 Godot 绝对路径钉入 profile。 |
| P1 | `scripts/setup.mjs:137`、`:189` | 虽然能选择 Windows zip，但解包后未调用 `locateGodotBinary`，重新走上述 resolver，官方版本化 exe 可能仍找不到。 | 下载/离线解包后解析并验证实际 exe，固定其路径。现代 Windows 的 `tar` 可能解 zip，不能仅因没有 unzip 就断言一定解包失败；仍需明确可用回退。 |
| P1 | `scripts/lib/probe-mcp.mjs:25` | 探针把环境固定为 `HOME`、`PATH=/usr/bin:/bin`、`LANG` 和显式 env，未保留 Windows 的 SystemRoot、临时目录等基础变量。它不能证明 Windows DSH 的真实启动行为。 | 按平台保留必要系统变量，核对 Windows DSH 的实际清理环境，再做真实子进程探针。 |
| P1 | `src/godot.mjs:238`、`src/processes.mjs:99` | win32 分支只调用 `child.kill`，不保证后代 Godot/helper 进程被终止。 | 使用可验证的 Windows 进程树生命周期管理，验收 stop、取消、超时和服务退出后的后代进程状态。 |
| P1 | `test/lifecycle.test.mjs:53`、`:64`、`:80` | 自然退出、按 kind 停止、同项目共享注入三项测试在 win32 被跳过，假引擎依赖 POSIX shebang。 | Windows 使用原生可启动的夹具，关键生命周期用例不得静默跳过。 |

### 配置问题的本机复现

调用仓库原有 `buildEntryBlock → patchPatchText → validatePatchText`，再用当前 DSH profile 内的真实 `yaml` 包解析生成的内容。未写入用户配置。

| 输入路径前缀 | 结构自检 | YAML 解析后 command | 结果 |
| --- | --- | --- | --- |
| `C:\DSH Tools\Godot 中文` | `ok:false`，报缺 command | `C:\DSH Tools\Godot 中文\node.exe` | 正常 Windows 路径被自检误拒绝 |
| `C:\DSH #1\Godot` | `ok:false`，报缺 command | `C:\DSH` | 路径被截断；兜底解析器仍误报原始完整路径 |

复现环境是 macOS 上的 JavaScript/YAML 字符串处理，并非 Windows 系统执行。两处根因分别是 POSIX 前缀正则和未引用 YAML 标量，均能直接从源码确认。

## 仍需实机确认的风险与使用限制

- `godot/ops.gd:213` 的路径归一化只换斜杠、去尾斜杠和处理 macOS 别名；`:205`、`:260` 对项目边界进行大小写敏感的字符串比较。需要在 Windows 验证盘符/目录大小写、UNC、junction、长路径与文件边界，不应简单把所有路径转小写掩盖越界问题。
- 自定义 runtime 端口存在跨平台的配置断点：`src/inject.mjs:197` 写 `port.cfg`，运行时脚本只读取 `GODOT_MCP_RUNTIME_PORT`，未读该文件；会影响改端口和多项目并行设计。迁移应统一端口来源并验证端口归属。
- 启动游戏后监听端口需要时间。客户端应使用有期限的就绪探测；首次连接被拒绝不能直接当作永久不兼容。
- 当前取消可以中断 Node 子进程/桥连接，但断开桥连接不保证撤销已在 Godot 中执行的脚本。Windows 版文档和工具返回需保留此限制，不承诺事务回滚。
- Windows 强制终止进程不能依靠 POSIX SIGTERM handler 完成清理。需要实测 DSH 断开 stdin、关闭客户端、退出应用和强制结束后的行为；EOF 清理与下次启动恢复各自覆盖什么场景要有明确证据。本轮 DSH 冒烟未验证用户取消入口，取消的独立证据来自仓库协议/生命周期测试。
- `scripts/verify-export.mjs` 使用 macOS 模板目录、macOS preset 和 `.app` 产物；诊断脚本的一部分非 macOS 会跳过，chmod 探针也不能替代 Windows ACL。已有测试总数不能直接作为 Windows 覆盖率。
- 无头环境不能验收真实窗口截图、聚焦、鼠标键盘输入或休眠恢复。GitHub Windows runner 可做协议/无头测试，最后仍需交互式 Windows 桌面。

## 实施顺序

### 第一阶段：能安装、能正确定位

1. 确定首个支持目标为 Windows 11 x64 原生桌面；Windows ARM64 和 Windows 10 是否支持另行确认，未测不宣称支持。
2. 将 profile 路径校验、YAML 序列化与读取一起修复，覆盖空格、中文、` #`、单引号、盘符及 UNC。
3. Godot 显式 exe 优先；支持官方 zip 解包后的版本化文件名，并校验退出码和实际版本。将 Node 与 Godot 的绝对路径写入独立 godot 条目。
4. 提供 PowerShell 安装步骤和 `--profile` 显式参数；备份配置，只替换该条目。保留原文件以便卸载/回退。
5. 对照 Windows DSH 实际启动环境做探针，验收 initialize、tools/list 和五个工具注册。

阶段出口：全新 Windows 账户不依赖 POSIX 工具即可安装，DSH 能实际调用 `godot_status`，构建指纹一致。

### 第二阶段：执行、取消与配置恢复

1. 优先将现有 shell watchdog 替换为 Node helper 的 `spawn(exe, args, {shell:false})`，通过 JSON 请求/响应传参数和结果；GDScript 只负责调用入口并读取结构化结果。实施前须验证 helper 启动、Node 绝对路径传递和输出文件的唯一性。
2. 统一外层与嵌套进程的超时/取消机制。短期可评估按 PID 的 `taskkill /T /F`，若要求服务崩溃时也自动回收子树，则需评估 Windows Job Objects；不能仅把 SIGTERM 改名就宣布完成。
3. 对嵌套进程、正常退出、自然退出、按 kind 停止、共享会话、重启恢复分别验证用户 `override.cfg` 逐字节恢复。等待进程真正结束后再清注入；遇到文件占用要有有限重试和明确错误。
4. 统一 runtime 端口配置、占用检测和就绪等待，避免接错项目；评估同机多项目是否纳入首版。

阶段出口：导入、深检查、运行和 Windows 导出可执行；取消/超时无残留后代进程，原配置保持原样。

### 第三阶段：Windows 自动化回归与交付

1. 增加 Windows CI：单元、配置路径、MCP 协议、无头 Godot 操作、生命周期和进程树取消；测试夹具可原生执行。
2. 将导出验证改为 Windows Desktop preset 与 `.exe` 产物，模板位置从 Windows 实际安装布局定位，区分“缺模板”“执行失败”和“导出成功”。
3. 生成固定版本的 Windows 交付包或可复现安装步骤，记录 Node/Godot/DSH 版本及 MCP commit；排除 Mac 绝对路径、协作桥状态与用户凭据。
4. 更新 README，以 Windows DSH 为主入口，标明支持范围、已知限制、升级重启和回退方法。先完成迁移验收，再决定是否删除其他平台代码。

### 第四阶段：有 Windows 机器后做 DSH 实机验收

| 场景 | 最低通过标准 |
| --- | --- |
| 安装/升级/重启 | 新账户可安装；五个工具真实可用；loaded=onDisk、stale=false；其他 DSH 工具正常 |
| 路径 | 普通目录、空格、中文、` #`、盘符大小写；UNC/junction 若不支持则明确拒绝且不写错项目 |
| L1 | 创建项目/场景、导入、深度脚本检查、运行、Windows 导出；失败有真实退出码与 stderr |
| L2 | 编辑器连接、读取/修改场景、UndoRedo、关闭重连；保存后的文件与界面一致 |
| L3 | 游戏连接、属性读写、方法调用、暂停/恢复、输入和截图；错误采集可用 |
| 生命周期 | 自然退出、按 id/kind 停止、共享项目最后一个会话退出；无残留 Godot/helper；用户 override 原样恢复 |
| 取消与异常 | 排队取消不执行；运行取消与超时回收子树；断连限制如实返回；服务重启后的注入恢复 |
| 日常使用 | 启动竞态、端口占用、失焦、锁屏/唤醒、DSH 重连与升级回退均有可复核证据 |

每次验收记录系统和工具版本、commit、DSH 实际工具返回、退出码、产物、残留进程及配置前后哈希。没有机器时保持“待验收”，不把跳过项记为成功。

## 本轮交付边界

Codex 在当前 macOS 独立复核：`npm test` 79/79（fail=0、skip=0）、`node scripts/verify-wiring.mjs` 15/15、`node scripts/verify-mcp.mjs` 17/17，三条命令均退出 0。另独立计算 Node 构建指纹为 `3e3aa064b2a1`，12 个输入文件均存在。这些证明当前机器的回归与接线状态，不证明 Windows 运行结果。

已对当前版本完成兼容性分析并给出迁移路线。Windows 原生适配、Windows CI 和交互式验收尚未完成。建议先投入第一、第二阶段；没有 Windows 环境时可编写与静态验证适配，但无法关闭 Windows 发布验收项。
