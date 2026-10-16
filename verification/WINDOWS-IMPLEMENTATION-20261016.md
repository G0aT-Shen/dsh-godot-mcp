# Windows DSH 独立使用：实施与验收

日期：2026-10-16。实现前基线：`fc58235e3f4a4d7aad4e2491ab7b4165b208afb3`。
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
| 完整单元、配置与真实进程生命周期 | 最终构建 `4f6074a57ba4`：`npm test` 139/139，失败 0、跳过 0、退出码 0 |
| DSH profile / MCP / L1 / L3 | 隔离安装两次字节幂等；wiring 15/15、MCP 17/17、操作 19/19、诊断 29/29、L3 63/63，全部退出码 0 |
| 本机桌面 DSH 最终冒烟 | 同一 job/session 第 4 轮；构建 `4f6074a57ba4`、`stale:false`，五工具真实调用、自定义端口 19091、`rt.eval=42`；stop 后端口关闭、无运行中游戏、override SHA256 前后相同 |
| GitHub Windows Node 20 / 24 | 待推送后实际运行，不能把 workflow 已创建当成通过 |
| Windows 桌面 DSH 交互 | 未验收：当前没有 Windows 桌面宿主 |

独立执行日志：`/tmp/godot-mcp-primary-verification-20261016/`（本次验收宿主）；上述命令均直接记录退出码，未通过管道掩盖失败。macOS 导出检查也在最终构建上重新执行，10/10、退出码 0。

## 使用边界与迁移验收

Windows CI 能验证原生 headless 路径；Windows 桌面 DSH 的实际 MCP 客户端版本、重连、编辑器窗口、截图、输入、锁屏唤醒仍需目标设备验收。Windows ARM64 与 Linux 不在本轮验收范围。UNC 网络共享路径不作为已验收的项目位置；先使用本机磁盘上的绝对路径。

正常 stop、MCP 取消、stdin EOF 和正常退出可以进行清理。操作系统强杀、断电或用户 GDScript 自行启动并脱离进程树的程序，不能承诺完全回收；Windows 未实现 Job Object 崩溃兜底。强杀也不能保证未保存的 Godot 数据落盘，取消不撤销已经执行的场景改动。

异常退出后先确认相关 Godot/MCP 进程均停止，备份项目及 `override.cfg.mcp-backup`，再执行 `godot_session(action="cleanup")` 并检查恢复结果。自动启动时只报告待恢复注入，避免误删其他活跃会话的文件。

Windows 桌面验收至少覆盖：五工具出现、构建 `stale:false`、建项目/导入/深检查/运行/导出、编辑器读写与 UndoRedo、L3 属性/方法/输入/截图、取消与超时后的进程和端口释放、用户 override 逐字节恢复、升级后重新加载和回退。
