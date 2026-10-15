// Godot 定位与进程执行层。
//
// 职责：
//   1. 找到可用的 Godot 可执行文件（env → config → PATH → 常见安装位置 → 随包自带）；
//   2. 解析「当前 Godot 项目」目录（显式参数 → env → cwd 向上找 project.godot → config 默认）；
//   3. 以受控方式启动 Godot（超时、取消、输出上限、进程组清理）。
//
// 设计约束：本模块只管「怎么跑 Godot」，不含任何业务 op 语义。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');

/** 随包自带的 Godot（若用户把引擎放在 tools/ 下，安装时无需再配路径）。 */
const BUNDLED_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'tools', 'Godot.app', 'Contents', 'MacOS', 'Godot'),
  path.join(PACKAGE_ROOT, 'tools', 'godot'),
  path.join(PACKAGE_ROOT, 'tools', 'Godot_v4.7.2-stable_macos.universal', 'Godot.app', 'Contents', 'MacOS', 'Godot'),
];

const SYSTEM_CANDIDATES = [
  '/Applications/Godot.app/Contents/MacOS/Godot',
  '/Applications/Godot_mono.app/Contents/MacOS/Godot',
  path.join(os.homedir(), 'Applications', 'Godot.app', 'Contents', 'MacOS', 'Godot'),
];

/** 默认端口：编辑器桥 / 运行时桥。与 DESIGN.md §2.2、§2.3 一致。 */
export const DEFAULT_EDITOR_PORT = 9089;
export const DEFAULT_RUNTIME_PORT = 9091;

let cachedGodot;

const isExecutable = target => {
  try {
    return fs.statSync(target).isFile() && (fs.accessSync(target, fs.constants.X_OK), true);
  } catch {
    return false;
  }
};

/**
 * 把 hint 归一化成可执行文件路径（允许传 .app 目录）。
 * @param {string} value
 * @returns {string}
 */
export function normalizeGodotPath(value) {
  let target = value;
  if (target.endsWith('.app') || target.endsWith('.app/')) {
    target = path.join(target.replace(/\/$/, ''), 'Contents', 'MacOS', 'Godot');
  }
  return target;
}

/**
 * 解析 Godot 可执行文件路径。
 *
 * 语义要点：**显式指定的路径是严格的**。如果调用方（或 GODOT_PATH 等环境变量）
 * 给了路径却不可执行，直接返回 undefined，而不是悄悄回退到另一个 Godot 版本
 * —— 否则「用 4.7 生成的项目被 4.5 打开」这类事故不会有任何提示。
 * 只有没有任何显式指定时，才去探测随包自带与系统安装位置。
 *
 * @param {string} [hint] 调用方直接指定的路径（可以是 .app 目录或可执行文件）
 * @returns {string|undefined}
 */
export function resolveGodot(hint) {
  // 1. 显式指定：严格校验，不回退。
  const explicit = [
    hint,
    process.env.GODOT_MCP_GODOT,
    process.env.GODOT_PATH,
    process.env.GODOT4,
    process.env.GODOT,
  ].filter(value => typeof value === 'string' && value.length > 0);

  if (explicit.length > 0) {
    const target = normalizeGodotPath(explicit[0]);
    return isExecutable(target) ? target : undefined;
  }

  // 2. 无显式指定：探测随包自带与系统安装位置。
  for (const candidate of [...BUNDLED_CANDIDATES, ...SYSTEM_CANDIDATES]) {
    if (isExecutable(candidate)) return candidate;
  }

  // 3. 最后查 PATH（macOS 上 Godot 极少在 PATH，但 linux/CI 常见）。
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of ['godot4', 'godot', 'Godot']) {
    for (const entry of pathEntries) {
      const candidate = path.join(entry, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * 带缓存的 resolveGodot；进程内只做一次磁盘探测（除非 hint 变化）。
 * @param {string} [hint]
 */
export function godotPath(hint) {
  if (hint) return resolveGodot(hint);
  if (!cachedGodot) cachedGodot = resolveGodot();
  return cachedGodot;
}

export function clearGodotCache() {
  cachedGodot = undefined;
}

/** Godot 是否可用。返回 {ok, path?, version?, error?}，供启动自检。 */
export async function godotStatus(hint) {
  const binary = godotPath(hint);
  if (!binary) {
    return { ok: false, error: 'GODOT_NOT_FOUND', checked: [...BUNDLED_CANDIDATES.slice(0, 1), ...SYSTEM_CANDIDATES] };
  }
  try {
    const result = await runProcess(binary, ['--version'], { timeoutMs: 20_000 });
    const version = `${result.stdout}${result.stderr}`.trim().split('\n').pop()?.trim() ?? '';
    return { ok: true, path: binary, version };
  } catch (error) {
    return { ok: false, path: binary, error: String(error?.message ?? error) };
  }
}

/**
 * 解析「当前项目」目录。
 * 顺序：显式 project → GODOT_MCP_PROJECT → cwd 向上找 project.godot → config.defaultProject。
 * @param {{project?: string, cwd?: string, defaultProject?: string}} options
 * @returns {Promise<string>}
 */
export async function resolveProject({ project, cwd, defaultProject } = {}) {
  const explicit = project || process.env.GODOT_MCP_PROJECT || defaultProject;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (await hasProjectFile(resolved)) return resolved;
    // 显式指定但目录里没有 project.godot：仍然接受（create_project 场景），
    // 但要保证是绝对路径且父目录存在，避免把相对路径当项目名。
    return resolved;
  }
  const start = path.resolve(cwd ?? process.cwd());
  const found = await findProjectRoot(start);
  if (found) return found;
  const error = new Error(
    `没有找到 Godot 项目：从 ${start} 向上没有 project.godot。` +
      '请显式传 project 参数、设置 GODOT_MCP_PROJECT，或先在目标目录 create_project。',
  );
  error.code = 'PROJECT_NOT_FOUND';
  throw error;
}

export async function hasProjectFile(dir) {
  try {
    const stat = await fsp.stat(path.join(dir, 'project.godot'));
    return stat.isFile();
  } catch {
    return false;
  }
}

/** 从 start 向上查找含 project.godot 的目录。 */
export async function findProjectRoot(start) {
  let current = path.resolve(start);
  for (;;) {
    if (await hasProjectFile(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * 运行一个进程并收集输出。
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, signal?: AbortSignal, env?: Record<string,string>, maxBytes?: number}} [options]
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, signal: string|null, durationMs: number, truncated: boolean}>}
 */
export function runProcess(command, args, options = {}) {
  const {
    cwd,
    timeoutMs = 120_000,
    signal,
    env,
    maxBytes = 4 * 1024 * 1024,
  } = options;

  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', // 独立进程组，便于整组回收
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let timer;

    const append = (current, chunk) => {
      if (current.length >= maxBytes) {
        truncated = true;
        return current;
      }
      const next = current + chunk;
      if (next.length > maxBytes) {
        truncated = true;
        return next.slice(0, maxBytes);
      }
      return next;
    };

    child.stdout.on('data', chunk => {
      stdout = append(stdout, String(chunk));
    });
    child.stderr.on('data', chunk => {
      stderr = append(stderr, String(chunk));
    });

    const killGroup = signalName => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill(signalName);
        else process.kill(-child.pid, signalName); // 负 pid = 整个进程组
      } catch {
        try {
          child.kill(signalName);
        } catch {
          /* 已经退出 */
        }
      }
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };

    const onAbort = () => {
      killGroup('SIGKILL');
      const error = new Error(`操作已取消：${command}`);
      error.code = 'ABORTED';
      finish(reject, error);
    };

    if (signal) {
      if (signal.aborted) {
        killGroup('SIGKILL');
        const error = new Error(`操作已取消：${command}`);
        error.code = 'ABORTED';
        finish(reject, error);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killGroup('SIGKILL');
        const error = new Error(
          `Godot 操作超时（${timeoutMs}ms）：${command} ${args.join(' ')}\n` +
            `--- stdout ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr.slice(-2000)}`,
        );
        error.code = 'TIMEOUT';
        finish(reject, error);
      }, timeoutMs);
    }

    child.on('error', error => finish(reject, error));
    child.on('close', (code, signalName) => {
      finish(resolve, {
        stdout,
        stderr,
        exitCode: code,
        signal: signalName,
        durationMs: Date.now() - started,
        truncated,
      });
    });
  });
}

/** 协议标记：ops.gd 用它把业务结果与 Godot 自身日志分开。与 DESIGN.md §2.1 一致。 */
export const RESULT_MARKER = '@@GODOT_MCP@@';

/**
 * 从 Godot 输出中提取协议结果行。多个时取最后一个（脚本重入/多 op 时以最终结果为准）。
 * @param {string} text
 * @returns {{ok: boolean, [key: string]: unknown}|undefined}
 */
export function extractResult(text) {
  let found;
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    const index = line.indexOf(RESULT_MARKER);
    if (index === -1) continue;
    const payload = line.slice(index + RESULT_MARKER.length);
    try {
      found = JSON.parse(payload);
    } catch {
      found = { ok: false, error: `无法解析协议结果：${payload.slice(0, 500)}` };
    }
  }
  return found;
}
