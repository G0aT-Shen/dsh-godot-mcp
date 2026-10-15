// 插件启动诊断：把「模块是否被 import / apply 是否被调用 / 工具是否注册成功」写到磁盘。
//
// 为什么需要这个（真实教训）：
//   DSH 是图形应用，插件的 console 输出我拿不到。当工具没出现在工具列表里时，
//   有三种完全不同的可能，而现象一模一样：
//     A. 模块根本没被 import（加载链断了）
//     B. 模块被 import 了，但 apply() 没被调用（激活条件不满足）
//     C. apply() 被调用了，但 tools 服务拿不到 / register 被拒（0 个工具）
//   我上一版代码把 C 写成了「warn 一句就返回」，于是这三种情况在外部看来完全一样，
//   只能靠反复重启去猜。写一个状态文件就能一次区分清楚。
//
// 只做 best-effort：任何 IO 失败都被吞掉，绝不影响插件本身的加载。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 状态文件位置：放在用户数据目录，而不是插件仓库内（证明是「运行时」写的）。 */
export const STATUS_PATH = path.join(os.homedir(), '.local', 'share', 'godot-mcp', 'boot-status.json');

/**
 * 合并写入一条启动状态。读-改-写，保留之前写入的字段（import 先写、apply 后补充）。
 * @param {Record<string, unknown>} patch
 */
export function reportBootStatus(patch) {
  try {
    const dir = path.dirname(STATUS_PATH);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let previous = {};
    try {
      previous = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
    } catch {
      previous = {};
    }
    const next = {
      ...previous,
      ...patch,
      pid: process.pid,
      // 记录「本次进程唯一一次 import」的时间；重复 apply 会刷新 appliedAt。
      importedAt: previous.importedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      node: process.version,
      cwd: process.cwd(),
    };
    // 原子写：先写临时文件再 rename，避免读到半截 JSON。
    const tmp = `${STATUS_PATH}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, STATUS_PATH);
  } catch {
    /* 诊断失败绝不影响插件 */
  }
}
