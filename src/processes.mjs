// 长驻进程管理：编辑器会话、运行中的游戏实例。
//
// L1（无头 op）是一次性进程，跑完即退；但「打开编辑器」「运行游戏」需要长驻，
// 而且要能在后续工具调用里查询它的日志、再把它停掉。
//
// 关键实现点（都是踩过的坑）：
//   1. detached 起独立进程组，停止时对 -pid 发信号，否则 Godot 的子进程会变孤儿。
//   2. 先 SIGTERM 给宽限期（让 Godot 正常落盘 + 清理 .godot/editor 锁），再 SIGKILL。
//      Godot 默认会拦截 SIGTERM 并正常退出；因为 detached 脱离控制终端，所以不会卡住。
//   3. 输出环形缓冲，避免长跑游戏把内存吃光。
//   4. macOS 上用 caffeinate 包住长驻会话（见 keepAwakeCommand）：这台机器在窗口
//      失焦后会进 App Nap / 系统空闲休眠，定时器整段停摆 —— 进程还活着、端口还在
//      听，但脚本一步都不往前走，表现为「工具调用莫名其妙超时」。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { godotPath, resolveProject } from './godot.mjs';
import { hasInstalledBridge, injectTransientBridge, restoreTransientBridge, sweepStaleInjections } from './inject.mjs';

/** 防止长驻会话被系统休眠/节流冻结；不存在就安静降级。 */
const CAFFEINATE = '/usr/bin/caffeinate';

/**
 * @returns {{command: string, args: string[], keepAwake: boolean}}
 */
function keepAwakeCommand(binary, args, enabled) {
  const plain = { command: binary, args, keepAwake: false };
  if (!enabled || process.platform !== 'darwin' || !existsSync(CAFFEINATE)) return plain;
  return { command: CAFFEINATE, args: ['-dimsu', binary, ...args], keepAwake: true };
}

/** 单个受管进程。 */
class ManagedProcess extends EventEmitter {
  constructor({ id, kind, command, args, cwd, projectPath, keepAwake = false }) {
    super();
    this.id = id;
    this.kind = kind; // 'editor' | 'game'
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.projectPath = projectPath;
    this.keepAwake = keepAwake;
    this.startedAt = Date.now();
    this.endedAt = undefined;
    this.exitCode = undefined;
    this.signal = undefined;
    this.stdout = '';
    this.stderr = '';
    this.truncated = false;
    this.maxBytes = 512 * 1024;
    this.child = undefined;
    this.stopping = false;
  }

  start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env },
    });
    const append = (key, chunk) => {
      this[key] += chunk;
      if (this[key].length > this.maxBytes) {
        this[key] = this[key].slice(-this.maxBytes);
        this.truncated = true;
      }
      this.emit('output', { stream: key, chunk });
    };
    this.child.stdout.on('data', chunk => append('stdout', String(chunk)));
    this.child.stderr.on('data', chunk => append('stderr', String(chunk)));
    this.child.on('error', error => {
      append('stderr', `\n[spawn error] ${error.message}\n`);
    });
    this.child.on('close', (code, signal) => {
      this.exitCode = code;
      this.signal = signal;
      this.endedAt = Date.now();
      this.emit('exit', { code, signal });
    });
    return this;
  }

  get running() {
    return this.child !== undefined && this.endedAt === undefined;
  }

  /** 优雅停止：SIGTERM → 宽限期 → SIGKILL（整个进程组）。 */
  async stop({ graceMs = 5000 } = {}) {
    if (!this.running) return { stopped: false, reason: 'not-running', exitCode: this.exitCode };
    this.stopping = true;
    const pid = this.child.pid;
    const signalGroup = name => {
      if (pid === undefined) return;
      try {
        if (process.platform === 'win32') this.child.kill(name);
        else process.kill(-pid, name);
      } catch {
        try {
          this.child.kill(name);
        } catch {
          /* 已退出 */
        }
      }
    };

    const exited = new Promise(resolve => {
      if (!this.running) resolve(true);
      else this.once('exit', () => resolve(true));
    });

    signalGroup('SIGTERM');
    const timer = setTimeout(() => signalGroup('SIGKILL'), graceMs);
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, graceMs + 2000))]);
    clearTimeout(timer);
    if (this.running) signalGroup('SIGKILL');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);

    return {
      stopped: !this.running,
      forced: this.running || this.signal === 'SIGKILL',
      exitCode: this.exitCode,
      signal: this.signal,
    };
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      pid: this.child?.pid,
      running: this.running,
      projectPath: this.projectPath,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: this.endedAt ? new Date(this.endedAt).toISOString() : undefined,
      uptimeMs: (this.endedAt ?? Date.now()) - this.startedAt,
      exitCode: this.exitCode,
      signal: this.signal,
      keepAwake: this.keepAwake,
      // 桥的形态对调用方是重要信息：installed=项目里提交过桥，transient=这次零足迹注入
      ...(this.bridge ? { bridge: this.bridge } : {}),
      stdoutBytes: this.stdout.length,
      stderrBytes: this.stderr.length,
      truncated: this.truncated,
    };
  }
}

/** 进程注册表。DSH 插件进程内的单例；工具调用之间共享。 */
export class ProcessRegistry {
  constructor() {
    this.processes = new Map();
    /** attach 模式：只注入桥、不持有进程。 */
    this.attached = new Map();
  }

  /**
   * 启动编辑器会话。
   * @param {{project?: string, cwd?: string, godot?: string, headless?: boolean, defaultProject?: string, extraArgs?: string[]}} options
   */
  async startEditor(options = {}) {
    const projectPath = await resolveProject({
      project: options.project,
      cwd: options.cwd,
      defaultProject: options.defaultProject,
    });
    const binary = requireGodot(options.godot);
    const args = [];
    if (options.headless) args.push('--headless');
    args.push('--editor', '--path', projectPath, ...(options.extraArgs ?? []));
    return this.#spawn('editor', binary, args, projectPath, options.keepAwake);
  }

  /**
   * 运行游戏。
   *
   * 桥的形态由 options.bridge 决定：
   *   'auto'（默认）—— 项目里已装提交式桥就用它，否则零足迹注入
   *   'transient'   —— 强制零足迹注入（validate 失败会报错）
   *   'installed'   —— 要求项目里已装桥，没装就报错
   *   'none'        —— 不注入，纯跑
   *
   * @param {{project?: string, cwd?: string, godot?: string, scene?: string, headless?: boolean,
   *          keepAwake?: boolean, bridge?: string, runtimePort?: number,
   *          defaultProject?: string, extraArgs?: string[]}} options
   */
  async startGame(options = {}) {
    const projectPath = await resolveProject({
      project: options.project,
      cwd: options.cwd,
      defaultProject: options.defaultProject,
    });
    const binary = requireGodot(options.godot);
    const bridge = await prepareBridge(projectPath, options);
    const args = [];
    if (options.headless) args.push('--headless');
    args.push('--path', projectPath);
    if (options.scene) args.push(options.scene);
    args.push(...(options.extraArgs ?? []));
    const process_ = this.#spawn('game', binary, args, projectPath, options.keepAwake);
    process_.bridge = bridge;
    return process_;
  }

  /**
   * attach 模式：只注入桥、不启动游戏。适用于游戏由别的东西启动
   * （CI、手动 `godot --path .`、外部调试器）但你仍然想用运行时工具的场景。
   */
  async attach(projectPath, options = {}) {
    const bridge = await prepareBridge(projectPath, { ...options, bridge: options.bridge ?? 'transient' });
    const id = `attached-${randomUUID().slice(0, 8)}`;
    this.attached.set(id, {
      id,
      kind: 'attached',
      projectPath,
      bridge,
      startedAt: Date.now(),
    });
    return { id, bridge, projectPath };
  }

  /** 撤销 attach（等价于对它做 stop）。 */
  async detach(id, projectPath) {
    const entry = id ? this.attached.get(id) : undefined;
    if (entry) {
      this.attached.delete(entry.id);
      return { id: entry.id, projectPath: entry.projectPath, ...(await restoreTransientBridge(entry.projectPath)) };
    }
    if (projectPath) return { projectPath, ...(await restoreTransientBridge(projectPath)) };
    return undefined;
  }

  /** 回收「记录里还有、但已无活跃会话」的注入（MCP 被杀之后留下的残留）。 */
  async sweepInjections() {
    const liveProjects = new Set(
      [...this.processes.values()].filter(process_ => process_.running).map(process_ => process_.projectPath),
    );
    for (const entry of this.attached.values()) liveProjects.add(entry.projectPath);
    return sweepStaleInjections({ isActive: project => liveProjects.has(project) });
  }

  #spawn(kind, binary, args, projectPath, keepAwake) {
    const id = `${kind}-${randomUUID().slice(0, 8)}`;
    // keepAwake 默认开（除非显式 false）：长驻会话在这台机器上会被 App Nap 冻结，
    // 而且症状极难自查 —— 进程活着、端口在听、脚本不动。
    const wrapped = keepAwakeCommand(binary, args, keepAwake !== false);
    const process_ = new ManagedProcess({
      id,
      kind,
      command: wrapped.command,
      args: wrapped.args,
      cwd: projectPath,
      projectPath,
      keepAwake: wrapped.keepAwake,
    }).start();
    this.processes.set(id, process_);
    process_.on('exit', () => {
      // 保留记录以便查询退出码与日志；上限 50 条防止无限增长。
      if (this.processes.size > 50) {
        for (const [key, value] of this.processes) {
          if (!value.running && key !== id) {
            this.processes.delete(key);
            break;
          }
        }
      }
    });
    return process_;
  }

  get(id) {
    return this.processes.get(id);
  }

  list() {
    const attached = [...this.attached.values()].map(entry => ({
      id: entry.id,
      kind: 'attached',
      running: false,
      attached: true,
      projectPath: entry.projectPath,
      startedAt: new Date(entry.startedAt).toISOString(),
      bridge: entry.bridge,
      note: '已注入运行时桥，等外部启动的游戏连上来；detach 可撤销',
    }));
    return [...this.processes.values()].map(process_ => process_.toJSON()).concat(attached);
  }

  findRunning(kind) {
    return [...this.processes.values()].filter(process_ => process_.running && (!kind || process_.kind === kind));
  }

  /** 读取某个进程的日志（支持按字节游标增量读）。 */
  readOutput(id, { cursor = 0, limit = 200_000, stream = 'both' } = {}) {
    const process_ = this.processes.get(id);
    if (!process_) return undefined;
    const combined =
      stream === 'stdout' ? process_.stdout : stream === 'stderr' ? process_.stderr : process_.stdout + process_.stderr;
    const start = Math.max(0, Math.min(Number(cursor) || 0, combined.length));
    const end = Math.min(combined.length, start + Math.max(1, Number(limit) || 200_000));
    return {
      id,
      cursor: end,
      totalBytes: combined.length,
      truncated: process_.truncated,
      running: process_.running,
      exitCode: process_.exitCode,
      text: combined.slice(start, end),
    };
  }

  async stop(id, options) {
    const process_ = this.processes.get(id);
    if (!process_) {
      // 也许是 attach 条目：对它 stop 就等于 detach
      if (this.attached.has(id)) return this.detach(id);
      return undefined;
    }
    const result = await process_.stop(options);
    const cleanup = await cleanupBridge(process_);
    return cleanup ? { ...result, bridgeCleanup: cleanup } : result;
  }

  async stopAll() {
    const attachedIds = [...this.attached.keys()];
    const results = await Promise.all([
      ...[...this.processes.values()].map(async process_ => {
        const result = await process_.stop();
        const cleanup = await cleanupBridge(process_);
        return { id: process_.id, ...result, ...(cleanup ? { bridgeCleanup: cleanup } : {}) };
      }),
      ...attachedIds.map(async id => ({ id, ...(await this.detach(id)) })),
    ]);
    return results;
  }
}

/**
 * 决定这次运行要不要注入桥，以及用哪种形态。见 startGame 的注释。
 * @returns {Promise<{mode: 'installed'|'transient'|'none', transientProject?: string, [k: string]: unknown}>}
 */
async function prepareBridge(projectPath, options = {}) {
  const requested = options.bridge ?? 'auto';
  if (requested === 'none') return { mode: 'none' };
  if (await hasInstalledBridge(projectPath)) return { mode: 'installed' };
  if (requested === 'installed') {
    const error = new Error(
      `项目里没有安装运行时桥（project.godot 的 [autoload] 里没有 McpRuntime），而 bridge="installed" 要求它必须存在。` +
        `先跑 godot_session(action="setup")，或改用默认的 bridge="auto"（会自动零足迹注入）。`,
    );
    error.code = 'BRIDGE_NOT_INSTALLED';
    throw error;
  }
  const report = await injectTransientBridge(projectPath, { port: options.runtimePort });
  return { mode: 'transient', transientProject: projectPath, ...report };
}

/** 会话结束后把零足迹注入撤掉。只有注入过的会话才需要。 */
async function cleanupBridge(process_) {
  if (process_?.bridge?.mode !== 'transient' || !process_.bridge.transientProject) return undefined;
  try {
    const result = await restoreTransientBridge(process_.bridge.transientProject);
    // 清一次就不再重复清，避免 stopAll 之类重复路径留下误导性的第二次结果
    process_.bridge.transientProject = undefined;
    return result;
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

function requireGodot(hint) {
  const binary = godotPath(hint);
  if (!binary) {
    const error = new Error(
      '找不到 Godot 可执行文件。设置 GODOT_MCP_GODOT / GODOT_PATH，或在 DSH 插件 config 里填 godotPath。',
    );
    error.code = 'GODOT_NOT_FOUND';
    throw error;
  }
  return binary;
}
