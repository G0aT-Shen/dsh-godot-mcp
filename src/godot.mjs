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
import { StringDecoder } from 'node:string_decoder';
import { killTree, listDescendantsDetailed } from './proc-tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');

/** 钉定的官方 Godot 版本。setup.mjs、CI 与定位逻辑共用同一个来源。 */
export const PINNED_GODOT_VERSION = '4.7.2-stable';

/** 嵌套执行助手（被 godot/ops.gd 用 OS.create_process 直接启动，不经 shell）。 */
export const NESTED_HELPER = path.join(PACKAGE_ROOT, 'src', 'nested-helper.mjs');

/**
 * 每次 L1 调用传给 Godot 的环境变量：把 **Node 绝对路径**与 helper 路径钉死。
 * 固定当前 Node 与 helper 的位置，避免嵌套执行时选中 PATH 中的另一个 Node；
 * 而 ops.gd 自己要靠 Node 才能跑嵌套 op（导入/导出/run_project/deep parse_check），
 * 所以必须在启动 Godot 时把这两项显式传下去。
 */
export function engineHelperEnv() {
  return { GODOT_MCP_NODE: process.execPath, GODOT_MCP_HELPER: NESTED_HELPER };
}

/** 默认端口：编辑器桥 / 运行时桥。与 DESIGN.md §2.2、§2.3 一致。 */
export const DEFAULT_EDITOR_PORT = 9089;
export const DEFAULT_RUNTIME_PORT = 9091;

let cachedGodot;

/**
 * 读环境变量：Windows 上环境变量名**大小写不敏感**（真实父环境常见的是 `Path`，
 * Node 也可能同时给出 `Path` 与 `PATH`）。只写 `env.PATH` 会在 Windows 上「看起来没设 PATH」，
 * 于是我们又塞一个假的 fallback 进去，真实的搜索路径反而丢了。
 * @param {Record<string,string|undefined>} env
 * @param {string} name
 * @param {NodeJS.Platform} [platform]
 */
export function envValue(env, name, platform = process.platform) {
  if (!env) return undefined;
  if (Object.hasOwn(env, name)) return env[name];
  if (platform !== 'win32') return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Windows 的可执行扩展名（来自 PATHEXT，缺省和 cmd 的默认值一致）。 */
export function executableExtensions(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return [''];
  const raw = envValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD';
  const parsed = raw.split(';').map(item => item.trim()).filter(Boolean);
  return parsed.length ? parsed : ['.EXE'];
}

/**
 * 可执行判定。
 * Windows 上 `access(X_OK)` 恒真，真正决定「能不能直接起」的是扩展名 ——
 * 但候选名是我们自己按 PATHEXT 展开的，所以这里只确认「是文件」。
 * @param {string} target
 * @param {{platform?: NodeJS.Platform, stat?: typeof fs.statSync, access?: typeof fs.accessSync}} [options]
 */
export function isExecutableFile(target, options = {}) {
  const { platform = process.platform, stat = fs.statSync, access = fs.accessSync } = options;
  try {
    if (!stat(target).isFile()) return false;
  } catch {
    return false;
  }
  if (platform === 'win32') return true;
  try {
    access(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 列目录（拿不到就返回空数组：探测不能因为某个候选目录不存在就炸）。 */
function listNames(dir, listDir) {
  try {
    return listDir(dir);
  } catch {
    return [];
  }
}

/**
 * 汇总 Godot 候选路径（纯函数 + 可注入的 listDir，便于在 macOS 上断言 Windows 布局）。
 *
 * Windows 布局覆盖：官方 zip 解包出的版本化文件名
 * （`Godot_v4.7.2-stable_win64.exe`）、安装版 `Godot.exe`、
 * `%ProgramFiles%\Godot`、`%LOCALAPPDATA%\Programs\Godot`、scoop、chocolatey，
 * 以及 PATH + PATHEXT 展开。
 *
 * @param {{platform?: NodeJS.Platform, env?: Record<string,string|undefined>, homedir?: string,
 *          packageRoot?: string, listDir?: (dir: string) => string[]}} [options]
 * @returns {{bundled: string[], system: string[], pathNames: string[], notes: string[]}}
 */
export function enumerateGodotCandidates(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    homedir = os.homedir(),
    packageRoot = PACKAGE_ROOT,
    listDir = dir => fs.readdirSync(dir),
  } = options;
  // Windows 上必须用 win32 分隔符：这些字符串既写进错误诊断，也被测试断言。
  const join = platform === 'win32' ? path.win32.join : path.join;
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const tools = join(packageRoot, 'tools');
  const bundled = [];
  const system = [];
  const notes = [];

  const pushFromDir = (target, pattern) => {
    for (const name of listNames(target, listDir)) {
      if (pattern.test(name)) system.push(join(target, name));
    }
  };

  if (platform === 'win32') {
    // 1) 随包自带：tools/ 下解包出来的官方版本化 exe（可能在 tools/ 或 tools/godot/）
    bundled.push(
      join(tools, `Godot_v${PINNED_GODOT_VERSION}_win64.exe`),
      join(tools, 'godot', `Godot_v${PINNED_GODOT_VERSION}_win64.exe`),
      join(tools, 'Godot.exe'),
      join(tools, 'godot', 'Godot.exe'),
    );
    for (const dir of [tools, join(tools, 'godot')]) {
      for (const name of listNames(dir, listDir)) {
        if (/^Godot.*\.exe$/i.test(name)) bundled.push(join(dir, name));
      }
    }
    // 2) 系统安装位置（官方安装器 / scoop / chocolatey / winget 默认落点）
    const programFiles = [envValue(env, 'ProgramFiles', platform), envValue(env, 'ProgramFiles(x86)', platform), envValue(env, 'ProgramW6432', platform)].filter(Boolean);
    // scrubbed env 里可能没有 ProgramFiles：官方安装器的默认落点仍然要覆盖，
    // 否则「装好了却报找不到」会被误判成没装。
    if (programFiles.length === 0) programFiles.push(path.win32.join(`${env.SystemDrive ?? 'C:'}\\`, 'Program Files'));
    const roots = [
      ...programFiles.map(base => join(base, 'Godot')),
      ...programFiles.map(base => join(base, 'Godot Engine')),
      envValue(env, 'LOCALAPPDATA', platform) ? join(envValue(env, 'LOCALAPPDATA', platform), 'Programs', 'Godot') : undefined,
      envValue(env, 'LOCALAPPDATA', platform) ? join(envValue(env, 'LOCALAPPDATA', platform), 'Microsoft', 'WinGet', 'Links') : undefined,
      envValue(env, 'USERPROFILE', platform) ? join(envValue(env, 'USERPROFILE', platform), 'scoop', 'apps', 'godot', 'current') : undefined,
      // scrubbed env 可能没有 USERPROFILE/LOCALAPPDATA：用 homedir 兜底，别把已装好的 Godot 漏掉
      join(envValue(env, 'USERPROFILE', platform) ?? homedir, 'scoop', 'apps', 'godot', 'current'),
      join(envValue(env, 'USERPROFILE', platform) ?? homedir, 'AppData', 'Local', 'Programs', 'Godot'),
      envValue(env, 'ProgramData', platform) ? join(envValue(env, 'ProgramData', platform), 'chocolatey', 'bin') : join(`${env.SystemDrive ?? 'C:'}\\`, 'ProgramData', 'chocolatey', 'bin'),
      homedir ? join(homedir, 'Godot') : undefined,
    ].filter(Boolean);
    for (const root of roots) {
      system.push(join(root, 'Godot.exe'), join(root, `Godot_v${PINNED_GODOT_VERSION}_win64.exe`));
      pushFromDir(root, /^Godot.*\.exe$/i);
    }
    notes.push(`PATHEXT=${envValue(env, 'PATHEXT', platform) ?? '(未设置，按 .COM;.EXE;.BAT;.CMD)'}`);
  } else if (platform === 'darwin') {
    bundled.push(
      join(tools, 'Godot.app', 'Contents', 'MacOS', 'Godot'),
      join(tools, `Godot_v${PINNED_GODOT_VERSION}_macos.universal`, 'Godot.app', 'Contents', 'MacOS', 'Godot'),
    );
    for (const dir of [tools, join(tools, 'godot')]) {
      for (const name of listNames(dir, listDir)) {
        if (/^Godot.*\.app$/i.test(name)) bundled.push(join(dir, name, 'Contents', 'MacOS', 'Godot'));
        if (/^Godot$/i.test(name)) bundled.push(join(dir, name));
      }
    }
    system.push(
      '/Applications/Godot.app/Contents/MacOS/Godot',
      '/Applications/Godot_mono.app/Contents/MacOS/Godot',
      join(homedir, 'Applications', 'Godot.app', 'Contents', 'MacOS', 'Godot'),
      '/opt/homebrew/bin/godot',
      '/usr/local/bin/godot',
    );
  } else {
    bundled.push(join(tools, 'godot'), join(tools, 'godot', 'godot'));
    system.push(
      '/usr/local/bin/godot4',
      '/usr/local/bin/godot',
      '/usr/bin/godot4',
      '/usr/bin/godot',
      '/snap/bin/godot4',
      '/snap/bin/godot',
    );
  }

  // PATH 搜索名 + PATHEXT 展开（Windows 上 `godot` 实际是 `godot.exe`）
  const baseNames = ['godot4', 'godot', 'Godot'];
  const extensions = executableExtensions(platform, env);
  const pathNames = [];
  for (const base of baseNames) {
    for (const extension of extensions) {
      pathNames.push(`${base}${extension}`);
      if (platform === 'win32') pathNames.push(`${base}${extension.toLowerCase()}`);
    }
  }
  return { bundled: [...new Set(bundled)], system: [...new Set(system)], pathNames: [...new Set(pathNames)], notes };
}

/**
 * 把 hint 归一化成可执行文件路径（允许传 .app 目录或解包目录）。
 * @param {string} value
 * @param {{platform?: NodeJS.Platform, listDir?: (dir: string) => string[]}} [options]
 * @returns {string}
 */
export function normalizeGodotPath(value, options = {}) {
  const { platform = process.platform, listDir = dir => fs.readdirSync(dir) } = options;
  const join = platform === 'win32' ? path.win32.join : path.join;
  let target = String(value).trim();
  // 用户在 PowerShell 里复制路径时经常带上引号
  if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
    target = target.slice(1, -1);
  }
  if (target.endsWith('.app') || target.endsWith('.app/')) {
    target = join(target.replace(/\/$/, ''), 'Contents', 'MacOS', 'Godot');
  }
  // 传的是「解包出来的目录」时，进去找版本化 exe / Godot.app
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') {
    const names = listNames(target, listDir);
    if (platform === 'win32' && names.length) {
      const exe = names.find(name => /^Godot.*\.exe$/i.test(name));
      if (exe) return join(target, exe);
    }
    if (platform === 'darwin') {
      const app = names.find(name => /^Godot.*\.app$/i.test(name));
      if (app) return join(target, app, 'Contents', 'MacOS', 'Godot');
    }
  }
  return target;
}

/**
 * 解析 Godot 可执行文件路径。
 *
 * 语义要点：**显式指定的路径是严格的**。如果调用方（或 GODOT_PATH 等环境变量）
 * 给了路径却不可执行，直接返回 undefined，而不是悄悄回退到另一个 Godot 版本
 * —— 否则「用 4.7 生成的项目被 4.5 打开」这类事故不会有任何提示。
 * 只有没有任何显式指定时，才去探测随包自带、系统安装位置与 PATH。
 *
 * @param {string} [hint] 调用方直接指定的路径（可以是 .app 目录、解包目录或可执行文件）
 * @param {{platform?: NodeJS.Platform, env?: Record<string,string|undefined>}} [options]
 * @returns {string|undefined}
 */
export function resolveGodot(hint, options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    // 允许注入存在性判定：Windows 的 PATH/PATHEXT 分支只有这样才能在非 Windows 上被断言。
    isExecutable = target => isExecutableFile(target, { platform }),
  } = options;

  // 1. 显式指定：严格校验，不回退。
  const explicit = [
    hint,
    envValue(env, 'GODOT_MCP_GODOT', platform),
    envValue(env, 'GODOT_PATH', platform),
    envValue(env, 'GODOT4', platform),
    envValue(env, 'GODOT', platform),
  ].filter(value => typeof value === 'string' && value.length > 0);

  if (explicit.length > 0) {
    const target = normalizeGodotPath(explicit[0], { platform });
    return isExecutable(target) ? target : undefined;
  }

  // 2. 无显式指定：探测随包自带与系统安装位置。
  const candidates = enumerateGodotCandidates({ ...options, platform, env });
  for (const candidate of [...candidates.bundled, ...candidates.system]) {
    if (isExecutable(candidate)) return candidate;
  }

  // 3. 最后查 PATH（Windows 上按 PATHEXT 展开；分隔符也不同）。
  const join = platform === 'win32' ? path.win32.join : path.join;
  const pathEntries = (envValue(env, 'PATH', platform) ?? '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean);
  for (const name of candidates.pathNames) {
    for (const entry of pathEntries) {
      const candidate = join(entry, name);
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

/** Godot 是否可用。返回 {ok, path?, version?, error?, checked?}，供启动自检与错误诊断。 */
export async function godotStatus(hint) {
  const binary = godotPath(hint);
  if (!binary) {
    // 诊断要能回答「你到底找过哪些地方」——Windows 上装完官方 zip 却没被认出来时，
    // 只有这份清单能说明是候选没覆盖还是路径写错。
    const candidates = enumerateGodotCandidates();
    return {
      ok: false,
      error: 'GODOT_NOT_FOUND',
      checked: {
        bundled: candidates.bundled,
        system: candidates.system,
        pathNames: candidates.pathNames,
        notes: candidates.notes,
        envHints: ['GODOT_MCP_GODOT', 'GODOT_PATH', 'GODOT4', 'GODOT'].filter(key => process.env[key]),
      },
    };
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

  // **前置取消**：signal 已经 aborted 时连进程都不创建 —— 旧实现先 spawn 再检查，
  // 于是「已取消的请求」仍然会真起一个 Godot（有副作用：写文件、占端口、跑脚本）。
  if (signal?.aborted) {
    const error = new Error(`操作已取消（signal 在启动前已经 aborted）：${command}`);
    error.code = 'ABORTED';
    error.kill = { ok: true, note: 'pre-aborted; no process spawned' };
    return Promise.reject(error);
  }

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
    let closed = false;
    let timer;
    let termination; // 'abort' | 'timeout'：已经在走「杀树 → 等进程真的结束」流程

    // 输出按**字节**计数 + StringDecoder 流式解码：`String(chunk)` 会在多字节 UTF-8
    // 字符被 chunk 边界切开时产生替换字符（中文日志尤其明显）。
    // 用 Node 的 StringDecoder（而不是 TextDecoder）：它原生跨 chunk 缓冲半个字符。
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const byteCounts = { stdout: 0, stderr: 0 };
    // 已经调用过 end() 的流：StringDecoder.end() 不保证幂等，重复调用会把挂着的
    // 半个字符再吐一次（实测 64 字节上限被写成 66 字节），所以这里显式记账。
    const decoderEnded = { stdout: false, stderr: false };
    // 被 maxBytes 截断过的流：flush 时 end() 返回的半个字符属于「我们砍掉的那部分」，丢弃；
    // 没被截断的流照常 flush，正常收尾。
    const truncatedStreams = { stdout: false, stderr: false };
    const append = (key, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      const already = byteCounts[key];
      if (already >= maxBytes) {
        // 已经写满：后续数据全部丢弃。这里**也必须**把这条流标记为「截断」——
        // 否则解码器里挂着的半个字符会在 flush 时变成 U+FFFD 被追加进输出
        // （实测间歇性把 64 字节上限写成 66 字节，取决于最后一块是否正好落在上限上）。
        truncated = true;
        truncatedStreams[key] = true;
        return;
      }
      // **按剩余字节严格截断**：旧实现只要当前已写字节没超上限就整块写入，
      // 于是最后一块会把输出顶到远超 maxBytes（4MiB 上限能写成 8MiB）。
      const remaining = maxBytes - already;
      const slicing = buffer.length > remaining;
      const slice = slicing ? buffer.subarray(0, remaining) : buffer;
      byteCounts[key] = already + slice.length;
      // 顺序很重要：**先 write 再决定残字节怎么处理**。
      // 反过来的话（先 end() 再 write）会把上一 chunk 遗留的半个字符直接判成无效，
      // 即使它本来能被这一块补全 —— 输出里就多一个 U+FFFD，还丢字符。
      const text = decoders[key].write(slice);
      if (key === 'stdout') stdout += text;
      else stderr += text;
      if (slicing) {
        truncated = true;
        truncatedStreams[key] = true; // flush 时丢弃这条流挂着的半个字符
      }
    };

    const flushDecoders = () => {
      for (const key of ['stdout', 'stderr']) {
        if (decoderEnded[key]) continue;
        decoderEnded[key] = true;
        const rest = decoders[key].end();
        if (truncatedStreams[key]) continue; // 截断流的残字节是砍掉的半个字符，不属于真实输出
        if (key === 'stdout') stdout += rest;
        else stderr += rest;
      }
    };

    // 必须真的挂上数据流：漏掉这两行会让 stdout/stderr 永远是空串，
    // 表现为「op 没有返回协议结果（exit=0）」—— 退出码还是对的，极难排查。
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));

    const closedPromise = new Promise(resolve => child.once('close', resolve));
    const pendingTimers = new Set();
    /**
     * 有界等待：计时器在 race 结束后**必须清掉**。
     * `Promise.race([p, delay(5000)])` 的写法会在取消后留下一个 5 秒的 timer ——
     * 事件循环被拖住、进程迟迟不退出，测试也会莫名其妙地慢/挂。
     */
    const raceWithTimeout = async (promise, ms) => {
      let timer;
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve('__timeout__'), ms);
        pendingTimers.add(timer);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer) {
          clearTimeout(timer);
          pendingTimers.delete(timer);
        }
      }
    };
    /**
     * 真正等待 ms 毫秒（macrotask）。
     * 轮询**不能**写 `raceWithTimeout(Promise.resolve(), 50)`：Promise.resolve() 永远立刻赢，
     * 于是循环变成微任务忙转 —— 事件循环拿不到 I/O 回调，'close' 永远不派发，
     * 已死的子进程仍以僵尸身份被 `process.kill(pid, 0)` 判为「活着」。
     */
    const sleep = ms => new Promise(resolve => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        resolve();
      }, ms);
      pendingTimers.add(timer);
    });
    const clearPendingTimers = () => {
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
    };

    /**
     * 有界地回收整棵进程树，**在返回前确认后代真的死了**。
     *
     * 旧实现是 fire-and-forget：`killTree(...)` 还没跑完就 reject，于是调用方
     * 紧接着的下一步（例如清理项目文件、重新写 override.cfg）可能和仍在运行的
     * 后代进程撞车 —— Windows 上表现为「文件被占用」，POSIX 上是残留进程继续写。
     */
    const terminateTree = async () => {
      const pid = child.pid;
      if (pid === undefined) {
        // 没有 pid 时，`closed` 只能来自真实的 'close' 事件；`exited` 用 exitCode/signalCode，
        // 且必须写 `!= null`（未 spawn 成功时它们是 undefined，而 undefined !== null 为真，
        // 会冒充「已经退出」）。
        return {
          ok: true,
          note: 'no-pid',
          closed,
          exited: child.exitCode != null || child.signalCode != null,
          survivors: [],
        };
      }
      // **杀前快照**：一旦开始杀，父子关系就被破坏（reparent），事后再枚举既可能漏人、
      // 也不能作为「已经回收」的证据。所以要杀的对象必须在杀之前就确定下来。
      // Windows 上也必须快照：taskkill /T 只覆盖「当时还在关系树里」的后代，
      // 而且没有快照就无法逐个确认它们真的退出了（之前 win32 直接跳过 → 漏孙进程）。
      // 快照来源与是否可信**如实回传**（CIM 查询失败/空输出时为 ok:false，不许静默当成空树）。
      const snapshotInfo = listDescendantsDetailed(pid);
      const targets = [pid, ...snapshotInfo.descendants];
      const kill = await killTree(pid, { force: true });
      // 有界等待「快照里的每一个 pid」都消失，而不是看进程组或事后枚举
      const deadline = Date.now() + 8000;
      const alive = new Set(targets);
      while (Date.now() < deadline) {
        for (const target of [...alive]) {
          let running = false;
          try {
            process.kill(target, 0);
            running = true;
          } catch (error) {
            running = error?.code === 'EPERM';
          }
          if (!running) alive.delete(target);
        }
        if (alive.size === 0) break;
        await sleep(50);
      }
      // 仍然活着的：按已知 pid 补杀一轮（不能用重新枚举的结果）
      for (const target of alive) {
        try { process.kill(target, process.platform === 'win32' ? 'SIGKILL' : 'SIGKILL'); } catch { /* 已退出 */ }
      }
      if (alive.size > 0) await sleep(200);
      const survivors = [];
      for (const target of alive) {
        let running = false;
        try {
          process.kill(target, 0);
          running = true;
        } catch (error) {
          running = error?.code === 'EPERM';
        }
        if (running) survivors.push(target);
      }
      // **close 事件才是「进程真的结束了」的证据**：pid 从 process.kill(pid,0) 上消失
      // 不等于 Node 已经派发过 'close'。Windows 上 taskkill 干掉进程后 pid 立刻查不到，
      // 而 'close' 要等下一个事件循环回合 —— 若此时直接返回，就会报 closed:false 的假信息
      // （CI 实测：取消/超时两条路径都因此失败）。这里再有界等一次 close。
      let observedClosed = closed;
      if (!observedClosed) {
        observedClosed = (await raceWithTimeout(closedPromise.then(() => true), 3000)) === true;
      }
      const exited = child.exitCode != null || child.signalCode != null;
      clearPendingTimers();
      return {
        ...kill,
        pid,
        snapshot: targets.length,
        // 快照可信度：调用方据此判断「回收干净」这个结论有多硬
        snapshotOk: snapshotInfo.ok,
        snapshotSource: snapshotInfo.source,
        snapshotMs: snapshotInfo.elapsedMs,
        ...(snapshotInfo.error ? { snapshotError: snapshotInfo.error } : {}),
        closed: observedClosed,
        exited,
        survivors,
      };
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clearPendingTimers();
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };

    const cancelOrTimeout = async (kind) => {
      if (termination) return;
      termination = kind;
      if (timer) clearTimeout(timer);
      let kill;
      try {
        kill = await terminateTree();
      } catch (error) {
        kill = { ok: false, error: String(error?.message ?? error) };
      }
      const detail = kill ? `；进程树回收：${JSON.stringify(kill)}` : '';
      if (kind === 'abort') {
        const error = new Error(`操作已取消：${command}${detail}`);
        error.code = 'ABORTED';
        error.kill = kill;
        finish(reject, error);
        return;
      }
      flushDecoders();
      const error = new Error(
        `Godot 操作超时（${timeoutMs}ms）：${command} ${args.join(' ')}\n` +
          `--- stdout ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr.slice(-2000)}${detail}`,
      );
      error.code = 'TIMEOUT';
      error.kill = kill;
      finish(reject, error);
    };

    const onAbort = () => { void cancelOrTimeout('abort'); };

    // **先注册 error/close**：任何「提前 return」的取消路径都必须建立在监听已挂好的前提上，
    // 否则子进程随后抛出的 'error' 没有处理器，会变成 unhandled 'error' 直接把进程打挂。
    child.on('error', error => {
      if (termination) return; // 终止流程自己收尾，别把 spawn 之后的噪音当成结果
      finish(reject, error);
    });
    child.on('close', (code, signalName) => {
      closed = true;
      // 取消/超时进行中：这里只记录状态，由 cancelOrTimeout 在整棵树回收后统一 reject。
      if (termination) return;
      flushDecoders();
      finish(resolve, {
        stdout,
        stderr,
        exitCode: code,
        signal: signalName,
        durationMs: Date.now() - started,
        truncated,
      });
    });

    if (signal) {
      // spawn 与这里之间不会让出事件循环，所以「刚 spawn 完就 aborted」只能由外部同步置位；
      // 真出现时走同一条异步终止流程（监听已就绪，不存在漏 error 的窗口）。
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => { void cancelOrTimeout('timeout'); }, timeoutMs);
    }
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
