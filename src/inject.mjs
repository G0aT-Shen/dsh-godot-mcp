// 零足迹运行时桥注入。
//
// 问题：原来的 L3 运行时桥是「复制进项目 + 写进 project.godot 的 [autoload]」——
// 用一次工具就得往用户仓库里提交一个依赖，还得自己记得清理。
//
// 方案（实测验证过的两个 Godot 行为）：
//   1. `override.cfg` 里的 `[autoload]` 会被引擎读取并真的注册 autoload，
//      而 **project.godot 一个字都不用改**。所以注入 = 多一个 override.cfg。
//   2. autoload 脚本可以放在 `res://.godot/` 下面（Godot 自己的目录，约定已被
//      .gitignore 忽略），所以连脚本也不进版本库。
//
// 于是「零足迹」= 临时多出两个文件，退出时删掉；万一进程被杀，下次注入前会
// 从 override.cfg.mcp-backup 把用户原有的 override.cfg 还原回去。
//
// 为什么不用「改写 project.godot 再还原」：那要覆盖用户正在编辑的文件，任何一次
// 崩溃或强杀都可能留下一个被改坏的项目配置。override.cfg 永远不会碰已有内容。
//
// 状态记录在 ~/.local/share/godot-mcp/transient.json，这样 MCP 自己被重启后
// 仍然知道「哪些项目还有我留下的注入」。

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PACKAGE_ROOT } from './godot.mjs';
import { RUNTIME_AUTOLOAD_NAME, RUNTIME_SCRIPT_RES, upsertIniSetting } from './install.mjs';

/** 注入脚本落在项目的这个子目录（.godot 已被 Godot 生成的 .gitignore 覆盖）。 */
export const TRANSIENT_DIR_RELATIVE = path.join('.godot', 'mcp_bridge');
export const TRANSIENT_SCRIPT_RELATIVE = path.join(TRANSIENT_DIR_RELATIVE, 'godot_mcp_runtime.gd');
export const TRANSIENT_SCRIPT_RES = 'res://.godot/mcp_bridge/godot_mcp_runtime.gd';
export const OVERRIDE_NAME = 'override.cfg';
export const OVERRIDE_BACKUP_NAME = 'override.cfg.mcp-backup';

const RUNTIME_SOURCE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'godot', 'runtime', 'godot_mcp_runtime.gd'),
  path.join(PACKAGE_ROOT, 'godot', 'addon', 'godot_mcp_bridge', 'runtime', 'godot_mcp_runtime.gd'),
];

/** 状态目录可用环境变量覆盖，测试才能不污染真实 home。 */
function stateDir() {
  return process.env.GODOT_MCP_STATE_DIR || path.join(os.homedir(), '.local', 'share', 'godot-mcp');
}
function stateFile() {
  return path.join(stateDir(), 'transient.json');
}

/**
 * 给清理步骤加诊断上下文（step + code），行为不变：失败照样抛出。
 *
 * 抛出（而不是吞掉/返回）是刻意的：`restoreTransientBridge` 抛出时不会执行
 * `forgetProject`，状态条目因此保留、后续 `cleanup` 仍能重试；
 * 备份也绝不会被误删（复制失败会在删备份之前抛出）。
 */
async function cleanupStep(step, action) {
  try {
    return await action();
  } catch (error) {
    const code = error?.code ?? 'CLEANUP_STEP_FAILED';
    const wrapped = new Error(`cleanup step '${step}' failed: ${String(error?.message ?? error)} (code=${code})`);
    wrapped.code = code;
    wrapped.step = step;
    wrapped.cause = error;
    throw wrapped;
  }
}

export class InjectionError extends Error {
  constructor(message, code = 'INJECTION_FAILED') {
    super(message);
    this.name = 'InjectionError';
    this.code = code;
  }
}

function runtimeSourcePath() {
  for (const candidate of RUNTIME_SOURCE_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new InjectionError(
    `找不到运行时桥源码，找过：${RUNTIME_SOURCE_CANDIDATES.join(', ')}`,
    'RUNTIME_SOURCE_MISSING',
  );
}

/** 项目里是否已经装了「提交式」的桥（project.godot 里写了 autoload）。 */
export async function hasInstalledBridge(projectPath) {
  const projectFile = path.join(projectPath, 'project.godot');
  if (!existsSync(projectFile)) return false;
  const text = await fsp.readFile(projectFile, 'utf8');
  const inAutoload = /\[autoload\][\s\S]*?(?=\n\[|$)/.exec(text)?.[0] ?? '';
  return inAutoload.includes(`${RUNTIME_AUTOLOAD_NAME}=`);
}

/** 注入是否还在（override.cfg 里带我们的 autoload 且脚本还在）。 */
export async function transientState(projectPath) {
  const overridePath = path.join(projectPath, OVERRIDE_NAME);
  const backupPath = path.join(projectPath, OVERRIDE_BACKUP_NAME);
  const scriptPath = path.join(projectPath, TRANSIENT_SCRIPT_RELATIVE);
  let overrideHasAutoload = false;
  if (existsSync(overridePath)) {
    const text = await fsp.readFile(overridePath, 'utf8');
    overrideHasAutoload = text.includes(`${RUNTIME_AUTOLOAD_NAME}=`);
  }
  return {
    active: overrideHasAutoload && existsSync(scriptPath),
    overrideHasAutoload,
    overrideExists: existsSync(overridePath),
    backupExists: existsSync(backupPath),
    scriptExists: existsSync(scriptPath),
    overridePath,
    backupPath,
    scriptPath,
  };
}

// ------------------------------------------------------------------ 状态文件

async function readState(file = stateFile()) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { projects: {} };
  } catch {
    return { projects: {} };
  }
}

async function writeState(file, state) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

// 不同项目可同时结束；必须把整次 read/modify/write 排队，不能互相覆盖条目。
let stateWrites = Promise.resolve();
function updateState(change) {
  const file = stateFile();
  const task = stateWrites.then(async () => {
    const state = await readState(file);
    change(state);
    await writeState(file, state);
  });
  stateWrites = task.catch(() => {});
  return task;
}

function rememberProject(projectPath, entry) {
  return updateState(state => {
    state.projects = state.projects ?? {};
    state.projects[projectPath] = { ...entry, at: new Date().toISOString() };
  });
}

function forgetProject(projectPath) {
  return updateState(state => { delete state.projects?.[projectPath]; });
}

/** 列出「状态文件里还记着」的项目——用于 MCP 重启后回收上一次的残留。 */
export async function pendingInjections() {
  await stateWrites;
  const state = await readState();
  return Object.entries(state.projects ?? {}).map(([project, entry]) => ({ project, ...entry }));
}

// ------------------------------------------------------------------ 注入

/**
 * 把运行时桥零足迹注入项目。
 * 只新增 override.cfg（必要时先备份用户原有的）与 .godot/mcp_bridge/ 下的脚本。
 *
 * @param {string} projectPath
 * @param {{port?: number, force?: boolean}} [options]
 */
export async function injectTransientBridge(projectPath, options = {}) {
  const projectFile = path.join(projectPath, 'project.godot');
  if (!existsSync(projectFile)) {
    throw new InjectionError(`不是 Godot 项目（缺少 project.godot）：${projectPath}`, 'NOT_A_PROJECT');
  }

  const state = await transientState(projectPath);
  const recovered = { restored: false, removedStaleScript: false };

  // 上一次可能没清理干净：先把用户原有的 override.cfg 还回去，再重新注入。
  // 「备份文件存在」就是上次没跑完的证据 —— 这也是不用额外 marker 文件的原因。
  if (state.backupExists) {
    await fsp.copyFile(state.backupPath, state.overridePath);
    // 这份原始备份必须保留到最终清理。重复注入不是一次清理。
    recovered.restored = true;
  } else if (state.overrideExists && !state.overrideHasAutoload) {
    // 用户自己的 override.cfg，先留一份原样备份
    await fsp.copyFile(state.overridePath, state.backupPath);
  }
  if (state.scriptExists) {
    // 删不掉就抛出（保持原行为：绝不无视旧目录继续覆盖）
    await cleanupStep('remove-stale-script-dir', () =>
      fsp.rm(path.join(projectPath, TRANSIENT_DIR_RELATIVE), { recursive: true, force: true }));
    recovered.removedStaleScript = true;
  }

  const source = runtimeSourcePath();
  const scriptPath = path.join(projectPath, TRANSIENT_SCRIPT_RELATIVE);
  await fsp.mkdir(path.dirname(scriptPath), { recursive: true });
  await fsp.copyFile(source, scriptPath);

  const overridePath = path.join(projectPath, OVERRIDE_NAME);
  let text = existsSync(overridePath) ? await fsp.readFile(overridePath, 'utf8') : '';
  text = upsertIniSetting(text, 'autoload', RUNTIME_AUTOLOAD_NAME, `"*${TRANSIENT_SCRIPT_RES}"`);
  await fsp.writeFile(overridePath, text, 'utf8');

  if (options.port !== undefined) {
    await fsp.writeFile(
      path.join(projectPath, TRANSIENT_DIR_RELATIVE, 'port.cfg'),
      `[mcp]\n\nport=${Number(options.port)}\n`,
      'utf8',
    );
  }

  await rememberProject(projectPath, {
    overridePath,
    backupPath: path.join(projectPath, OVERRIDE_BACKUP_NAME),
    scriptDir: path.join(projectPath, TRANSIENT_DIR_RELATIVE),
    hadOwnOverride: state.backupExists || (state.overrideExists && !state.overrideHasAutoload),
    // 记录**是谁注入的**：回收时只允许「注入者已经不在」的条目，见 sweepStaleInjections。
    // override.cfg 是项目级（global）配置：另一个还活着的 server / 还跑着的游戏
    // 可能正靠它工作，贸然还原会把人家正在跑的东西弄坏。
    owner: { pid: process.pid, host: os.hostname(), at: new Date().toISOString() },
  });

  return {
    injected: true,
    mode: 'transient',
    script: TRANSIENT_SCRIPT_RES,
    overridePath,
    recovered,
    projectFileUntouched: true,
  };
}

/**
 * 撤掉零足迹注入：有备份就还原，没有就删掉我们写的 override.cfg。
 * @returns {{restored: boolean, removedOverride: boolean, removedScript: boolean, backupPath?: string}}
 */
export async function restoreTransientBridge(projectPath) {
  const state = await transientState(projectPath);
  const result = { restored: false, removedOverride: false, removedScript: false };

  if (state.backupExists) {
    // 顺序即安全边界：复制失败会在删备份**之前**抛出，用户唯一备份因此不会丢
    await cleanupStep('restore-override', () => fsp.copyFile(state.backupPath, state.overridePath));
    await cleanupStep('remove-backup', () => fsp.rm(state.backupPath, { force: true }));
    result.restored = true;
  } else if (state.overrideHasAutoload) {
    // 没有备份 = override.cfg 本来不存在，整份删掉
    await cleanupStep('remove-override', () => fsp.rm(state.overridePath, { force: true }));
    result.removedOverride = true;
  }

  if (state.scriptExists) {
    await cleanupStep('remove-script-dir', () =>
      fsp.rm(path.join(projectPath, TRANSIENT_DIR_RELATIVE), { recursive: true, force: true }));
    result.removedScript = true;
  }

  await forgetProject(projectPath);
  return result;
}

/**
 * 判断某个 pid 是否还活着（用于 owner-aware 回收）。
 * EPERM 说明进程存在但没有权限发信号 —— 也算活着。
 * @param {number} pid
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 回收「状态文件里记着、但已经没有活跃会话」的注入。
 *
 * 场景：MCP 进程被 kill（游戏随之消失），override.cfg 留在项目里。
 *
 * **这不是自动启动清理**：没有任何「server 一起来就扫一遍」的隐式行为。
 * 只有显式调用（godot_session(action="cleanup")）或本函数被显式调用时才会执行，
 * 因为 override.cfg 是**项目级**配置，误还原会破坏别人正在跑的东西。
 *
 * 三条安全线（缺一不可）：
 *   1. 记录里的 owner pid 还活着 → 跳过（那是另一个 server 的注入，不是残留）；
 *   2. 该项目仍有活跃会话（游戏/attach）→ 跳过；
 *   3. 否则还原，并把「跳过原因」如实带出去。
 *
 * @param {{isActive?: (project: string) => boolean, ownerAlive?: (pid: number) => boolean}} [options]
 */
export async function sweepStaleInjections({ isActive = () => false, ownerAlive = pidAlive, onSkip } = {}) {
  const pending = await pendingInjections();
  const swept = [];
  for (const entry of pending) {
    // 返回值只包含「真的清理了」的条目（保持原有契约）；跳过原因通过 onSkip 汇报，
    // 调用方（例如 godot_session cleanup 的 JSON 输出）可以把它带给用户。
    if (isActive(entry.project)) {
      onSkip?.({ project: entry.project, cleaned: false, skipped: 'project-active', note: '该项目仍有活跃会话，不还原' });
      continue;
    }
    const owner = entry.owner;
    if (owner?.pid && owner.pid !== process.pid && ownerAlive(owner.pid)) {
      onSkip?.({
        project: entry.project,
        cleaned: false,
        skipped: 'owner-alive',
        owner,
        note: `注入者进程 ${owner.pid} 还活着（可能是另一个 server），不做还原以免破坏它正在用的注入`,
      });
      continue;
    }
    const state = await transientState(entry.project);
    if (!state.backupExists && !state.overrideHasAutoload && !state.scriptExists) {
      await forgetProject(entry.project);
      swept.push({ project: entry.project, cleaned: false, note: 'nothing to clean' });
      continue;
    }
    const result = await restoreTransientBridge(entry.project);
    swept.push({ project: entry.project, cleaned: true, ...result });
  }
  return swept;
}

export { stateFile as TRANSIENT_STATE_FILE, RUNTIME_SCRIPT_RES };
