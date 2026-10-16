# Windows DSH 独立使用：实施与验收

日期：2026-10-16。当前运行时构建：`5d5ee6f7fb7c`（14 个输入，缺失 0）。实现前基线：`fc58235e3f4a4d7aad4e2491ab7b4165b208afb3`。
目标是 Windows x64 上的桌面 DSH + Node ≥20 + Godot 4.7.2-stable，运行不依赖 Mac、Codex、协作桥、WSL 或 Git Bash。

## 本轮改动

- 用 Node 嵌套执行助手取代 `/bin/sh` 看门狗；Godot 通过 `OS.create_process` 传递 JSON 请求文件，助手用 `spawn(..., shell:false)` 启动真实引擎。stdout/stderr 分开保留，结构化报告退出、超时、取消和清理结果。
- Windows 在根进程还存活时使用 `%SystemRoot%/System32/taskkill.exe /PID ... /T /F` 清理进程树；POSIX 在终止前快照后代。macOS 实测 `OS.create_process` 会创建新的进程组，因此仅杀外层进程组不能覆盖完整链路。
- 所有安装路径使用带转义的 YAML 标量，支持 Windows 盘符、中文、空格和 `#`；用真实 YAML 解析器与安装器解析结果交叉验证。探针按 DSH 的规则过滤凭据变量与 `DSH_*`，保留 PATH、SystemRoot、临时目录和代理。
- 定位官方版本化 Windows exe；解包支持 tar → pwsh → powershell，解包后实际执行 `--version`，再把绝对路径写入 profile。
- 自定义运行时端口、就绪重试与项目身份校验；生命周期清理恢复用户的 `override.cfg`，报告待恢复注入而不在启动时盲目删除。
- 增加原生 Windows CI（Node 20/24）、官方引擎与导出模板、隔离 DSH profile、真实进程生命周期、MCP 协议、Godot 操作、L3 与 Windows release 导出检查。
- [README](../README.md) 提供 PowerShell 安装、正常重启、升级与回退步骤；[详细 Windows 指南](../docs/WINDOWS.md) 列出故障诊断与桌面验收清单。

## 独立验证

DSH 原任务在充值前因供应商 HTTP 402 中断；充值后沿用原 job/session 恢复。DSH 执行与 Codex 独立验收分开记录。中间测试结果不算最终版本通过。

| 平台 / 检查 | 结果 |
|---|---|
| macOS 原生 release 导出与门控 | `node scripts/verify-export.mjs`：10/10，退出码 0；成品连续运行 10 秒默认未监听，显式 opt-in 后 `rt.eval` 返回 42，清理后端口关闭 |
| 完整单元、配置与真实进程生命周期 | 修复后构建 `5d5ee6f7fb7c`：`npm test` 145/145，失败 0、跳过 0、退出码 0 |
| DSH profile / MCP / L1 / L3 | 隔离安装两次字节幂等；wiring 15/15、MCP 17/17、操作 19/19、诊断 29/29、L3 63/63，全部退出码 0 |
| 本机桌面 DSH 最终冒烟（macOS） | 原 job/session 第 8 轮；精确重载 MCP 子进程后 `loaded=onDisk=5d5ee6f7fb7c`、`stale:false`；五工具真实调用，自定义端口 19091、严格项目/PID 校验、`rt.eval=42`；stop 后端口关闭、游戏 PID 退出、注入清空；CRLF override 与 project.godot 的 SHA256 前后相同 |
| GitHub Windows Node 20 / 24 | [第四轮](https://github.com/G0aT-Shen/dsh-godot-mcp/actions/runs/38872012852)全部通过；代码提交 `feaaca6fc4a691c44138ef291aa0b6a550e8cb60`，运行时构建 `5d5ee6f7fb7c` |
| Windows 桌面 DSH 交互 | 未验收：当前没有 Windows 桌面宿主 |

最终 DSH 原生工具的公开返回由主审单独读取并核验；主审还重新读取项目文件哈希、确认 PID 82199 退出、9091/19091 关闭且临时注入目录不存在。早期 `4f6074a57ba4` 的冒烟只作为历史记录，不作为当前构建证据。

独立执行日志：`/tmp/godot-mcp-primary-verification-20261016/`（本次验收宿主）；上述命令均直接记录退出码，未通过管道掩盖失败。macOS 导出检查也在最终构建上重新执行，10/10、退出码 0。

## Windows 实际运行与修复

- [首轮](https://github.com/G0aT-Shen/dsh-godot-mcp/actions/runs/38867867492)：官方引擎解包、版本运行、隔离 profile 和 wiring 全通过；Windows 生命周期断言失败。
- [第二轮](https://github.com/G0aT-Shen/dsh-godot-mcp/actions/runs/38869052381)：独立下游检查继续执行，MCP 17/17、操作 19/19、Windows release 导出 10/10；诊断 19/24、L3 59/63，仍失败。Windows 的 helper 只读目录权限测试未执行（平台布局不同），没有算成通过。
- 修复 Windows 杀树后等待 Node close/exit 的竞态；增加原生 CIM 后代快照；仅在退出码 1 且真实解析出带定位诊断时接受语法检查结果，137/超时/孤儿/残留或杀树失败仍记 incomplete。新增 `godot/check_verdict.gd` 需与 `ops.gd` 一起分发。
- [第三轮](https://github.com/G0aT-Shen/dsh-godot-mcp/actions/runs/38870743838)（`ec7babd`）：两套 Node 单元均为 144/145；安装/wiring、MCP 17/17、操作 19/19、诊断 24/24、L3 63/63、导出 10/10 均通过。唯一失败是“父进程强杀后 helper 写回结果”的测试夹具。
- 根因由诊断事件与 [Node v24.21.0 随附的 libuv 源码](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/win/process.c) 交叉确认：模拟父进程是 Node，Windows libuv 对非 detached 子进程使用 KILL_ON_JOB_CLOSE，父进程被杀会提前杀死 helper；生产父进程是原生 Godot。
- `feaaca6` 只调整测试夹具：Windows 上让模拟父进程派生的 helper detached，保留 orphaned/result/后代回收断言并增加 helper 自身退出校验；单一清理钩子先读本用例 PID 文件、精确回收，再删临时目录。没有修改生产 detached 策略、跳过 Windows 用例或缩短看门狗预算。主审独立 `npm test`：145/145、跳过 0、退出码 0。

### 最终 Windows CI

[运行 38872012852](https://github.com/G0aT-Shen/dsh-godot-mcp/actions/runs/38872012852) 对完整提交 `feaaca6fc4a691c44138ef291aa0b6a550e8cb60` 执行，两项作业均 `completed/success`。主审下载两份日志产物逐项核对，未以 workflow 启动或中间步骤成功代替最终结果。

| 检查 | Node 20 | Node 24 |
|---|---|---|
| 官方 win64 zip 解包、定位、真实 `--version` | 4.7.2.stable.official.ed1daf0bf | 同左 |
| 隔离 DSH profile 安装与重复安装 | 7 项通过、未就绪 0；配置幂等 | 同左 |
| YAML / 启动接线 | 15/15 | 15/15 |
| 单元与原生进程生命周期 | 145/145，失败 0、跳过 0 | 145/145，失败 0、跳过 0 |
| MCP 协议 | 17/17 | 17/17 |
| Godot 基础操作 | 19/19 | 19/19 |
| 诊断与深度脚本检查 | 24/24 | 24/24 |
| 运行时桥与配置清理 | 63/63 | 63/63 |
| Windows release 导出与门控 | 10/10 | 10/10 |

诊断脚本中的 macOS `user://` 只读权限探针在 Windows 不执行，未计入 24 项通过；这不等于验证 Windows ACL。导出测试实际生成并运行 `.exe`，默认连续运行 10 秒不开放运行时桥，显式 opt-in 后执行 `rt.eval=42`，结束后端口关闭。隔离配置、引擎解包目录和导出目录包含中文、空格及 `#`。

本轮运行在 GitHub Windows Server 2025 x64 runner；不把它等同于 Windows 11 桌面 DSH。后续文档提交不改运行时代码或测试，代码验收基准始终为上述 SHA。

## 使用边界与迁移验收

Windows CI 能验证原生 headless 路径；Windows 桌面 DSH 的实际 MCP 客户端版本、重连、编辑器窗口、截图、输入、锁屏唤醒仍需目标设备验收。Windows ARM64 与 Linux 不在本轮验收范围。UNC 网络共享路径不作为已验收的项目位置；先使用本机磁盘上的绝对路径。

正常 stop、MCP 取消、stdin EOF 和正常退出可以进行清理。操作系统强杀、断电或用户 GDScript 自行启动并脱离进程树的程序，不能承诺完全回收；本项目未建立覆盖完整 Godot 调用链的专用 Windows Job Object 崩溃兜底，Node/libuv 自身已有的局部 Job 管理不能保证原生 Godot 全链回收。强杀也不能保证未保存的 Godot 数据落盘，取消不撤销已经执行的场景改动。

异常退出后先确认相关 Godot/MCP 进程均停止，备份项目及 `override.cfg.mcp-backup`，再执行 `godot_session(action="cleanup")` 并检查恢复结果。自动启动时只报告待恢复注入，避免误删其他活跃会话的文件。

Windows 桌面验收至少覆盖：五工具出现、构建 `stale:false`、建项目/导入/深检查/运行/导出、编辑器读写与 UndoRedo、L3 属性/方法/输入/截图、取消与超时后的进程和端口释放、用户 override 逐字节恢复、升级后重新加载和回退。
