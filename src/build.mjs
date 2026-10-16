// 构建指纹：让「跑着的其实是旧代码」这件事变得可见。
//
// 背景（真机踩到的）：DSH 的 mcp-client 把 MCP server 当长驻子进程托管，
// 进程一旦起来就把 ESM 模块缓存在内存里 —— 之后改 `src/*.mjs` 不会生效，
// 除非那个进程被重启。实测就出现过：磁盘上的代码已经修好了零足迹注入，
// 而活体 server 还是 68 分钟前的构建，表现成「工具行为跟仓库对不上」，
// 而 `godot_status` 当时**没有任何字段**能说明这一点。
//
// 做法：进程启动时把「自己真正加载的那些源码」算成一个短 hash（LOADED_BUILD）；
// 自检时再从磁盘算一次，两者不一致就报 `stale: true` 并给出修复动作。
//
// 注意指纹只覆盖 Node 侧运行时源码。`godot/ops.gd` 与桥的 GDScript 不参与：
// 它们每次调用都从磁盘读（ops.gd 由 `--script` 现读，桥是复制进项目的），
// 不存在「进程内缓存旧版本」的问题。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');

/** 参与指纹的文件（相对包根）。加了新的运行时模块就要加进这里。 */
export const BUILD_INPUTS = [
  'bin/godot-mcp.mjs',
  'src/build.mjs',
  'src/mcp-stdio.mjs',
  'src/server.mjs',
  'src/godot.mjs',
  'src/operations.mjs',
  'src/processes.mjs',
  'src/bridge.mjs',
  'src/install.mjs',
  'src/inject.mjs',
  'src/tools.mjs',
  'src/diagnose.mjs',
  // 跨平台进程树回收 + 嵌套执行助手：两者都参与运行时行为，
  // 漏掉它们会让「磁盘代码已修、活体 server 还是旧行为」这类事故重新变得不可见。
  'src/proc-tree.mjs',
  'src/nested-helper.mjs',
];

/**
 * 算一份构建指纹。同一份源码永远得到同一个 id；任一参与文件的内容变化都会改变它。
 * @param {string} [root] 包根，默认本包
 * @param {string[]} [inputs] 参与文件，默认 {@link BUILD_INPUTS}
 * @returns {{id: string, files: number, missing: string[]}}
 */
export function computeBuildId(root = PACKAGE_ROOT, inputs = BUILD_INPUTS) {
  const hash = createHash('sha256');
  const missing = [];
  for (const relative of inputs) {
    let content;
    try {
      content = fs.readFileSync(path.join(root, relative));
    } catch {
      content = Buffer.from('');
      missing.push(relative);
    }
    hash.update(relative).update('\0').update(content).update('\0');
  }
  return { id: hash.digest('hex').slice(0, 12), files: inputs.length, missing };
}

/** 进程启动时加载的那份源码的指纹（模块被缓存，之后不会再变）。 */
export const LOADED_BUILD = computeBuildId();

/** 重启 server 进程即可加载新代码；mcp-client 的监管器会自动把它拉起来。 */
export const STALE_HINT =
  '磁盘上的源码与当前进程加载的不一致：改完 `src/*.mjs` 后必须重启这个 server 进程才生效。' +
  'Windows：重启 DSH 桌面客户端（或让 MCP 客户端重连）；macOS/Linux：`kill -TERM <pid>`，' +
  'DSH 的 mcp-client 监管器会在数秒内自动拉起并加载新代码。';

/**
 * 对比「进程加载的」与「磁盘上的」源码。
 * @param {string} [root] 包根，默认本包
 * @returns {{loaded: string, onDisk: string, stale: boolean, files: number, checkedAt: string, missing?: string[], note?: string}}
 */
export function buildStatus(root = PACKAGE_ROOT) {
  const disk = computeBuildId(root);
  const stale = disk.id !== LOADED_BUILD.id;
  return {
    loaded: LOADED_BUILD.id,
    onDisk: disk.id,
    stale,
    files: disk.files,
    checkedAt: new Date().toISOString(),
    ...(disk.missing.length ? { missing: disk.missing } : {}),
    ...(stale ? { note: STALE_HINT } : {}),
  };
}
