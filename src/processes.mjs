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

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { DEFAULT_RUNTIME_PORT, godotPath, resolveProject } from './godot.mjs';
import { terminateTree } from './proc-tree.mjs';
import {
  hasInstalledBridge,
  injectTransientBridge,
  restoreTransientBridge,
  pendingInjections,
  pidAlive,
} from './inject.mjs';

/** 防止长驻会话被系统休眠/节流冻结；不存在就安静降级。 */
const CAFFEINATE = '/usr/bin/caffeinate';

/**
 * 决定要不要用 caffeinate 包住长驻会话。
 *
 * 注意它带来一个身份问题：包住之后 `child.pid` 是 **caffeinate 的 pid**，不是 Godot 的。
 * 所以调用方必须区分「直接子进程 pid」与「真实引擎 pid」（见 ManagedProcess.pidSource）。
 * Windows 上没有 caffeinate（也没有等价 wrapper），`child.pid` 就是 Godot 本身，
 * PID 校验必须是严格的。
 *
 * @param {string} binary
 * @param {string[]} args
 * @param {boolean} enabled
 * @param {NodeJS.Platform} [platform]
 * @returns {{command: string, args: string[], keepAwake: boolean}}
 */
export function keepAwakeCommand(binary, args, enabled, platform = process.platform) {
  const plain = { command: binary, args, keepAwake: false };
  if (!enabled || platform !== 'darwin' || !existsSync(CAFFEINATE)) return plain;
  return { command: CAFFEINATE, args: ['-dimsu', binary, ...args], keepAwake: true };
}

/** 单个受管进程。 */
class ManagedProcess extends EventEmitter {
  constructor({ id, kind, command, args, cwd, projectPath, keepAwake = false, env, runtimePort }) {
    super();
    /** 这次会话期望的运行时端口（用于「同一个项目多会话」时按端口选目标）。 */
    this.runtimePort = runtimePort;
    /**
     * pid 语义：
     *   'direct'             —— spawn 出来的进程就是引擎本身（Windows / 未包 wrapper）
     *   'wrapper-resolved'   —— 被 caffeinate 包住，已解析出真实引擎 pid
     *   'unresolved-wrapper' —— 被包住但解析失败：**不要**拿 wrapper pid 冒充引擎 pid
     */
    this.pidSource = 'direct';
    this.enginePid = undefined;
    // 额外环境变量（例如 GODOT_MCP_RUNTIME_PORT）：显式传给被管理的进程。
    // 运行时端口的**双保险**：port.cfg 给「项目 + 端口」的持久绑定，env 给「这一次启动」，
    // 少任何一个都会出现「设了自定义端口但仍监听 9091」这类问题。
    this.env = env;
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
      env: { ...process.env, ...(this.env ?? {}) },
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
    if (this.keepAwake) {
      // wrapper 形态：异步解析真实引擎 pid（失败就保持 undefined，绝不冒充）
      this.pidSource = 'unresolved-wrapper';
      void this.#resolveWrappedEnginePid();
    } else {
      this.pidSource = 'direct';
      this.enginePid = this.child.pid;
    }
    return this;
  }

  /** caffeinate 的直接子进程就是真正的 Godot；解析不到就如实标 unresolved。 */
  async #resolveWrappedEnginePid() {
    const wrapperPid = this.child?.pid;
    if (wrapperPid === undefined) return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.endedAt !== undefined) return;
      try {
        const output = execFileSync('pgrep', ['-P', String(wrapperPid)], { encoding: 'utf8', timeout: 3000 });
        const pids = output.split('\n').map(Number).filter(Number.isInteger);
        if (pids.length === 1) {
          this.enginePid = pids[0];
          this.pidSource = 'wrapper-resolved';
          return;
        }
        if (pids.length > 1) return; // 多个子进程：无法判定，保持 unresolved
      } catch { /* pgrep 不可用或还没有子进程 */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  get running() {
    return this.child !== undefined && this.endedAt === undefined;
  }

  /** 优雅停止：POSIX 先 SIGTERM 整组 → 宽限 → SIGKILL 整组；Windows 用 taskkill /T → /T /F。 */
  async stop({ graceMs = 5000 } = {}) {
    if (!this.running) return { stopped: false, reason: 'not-running', exitCode: this.exitCode };
    this.stopping = true;
    const pid = this.child.pid;

    const exited = new Promise(resolve => {
      if (!this.running) resolve(true);
      else this.once('exit', () => resolve(true));
    });

    let tree;
    if (process.platform === 'win32' && pid !== undefined) {
      // 关键：必须在根进程还活着时按 pid 枚举后代。/T 不带 /F 是「尽力优雅」，
      // headless 控制台进程通常拒绝优雅退出，此时如实记录原因再 /T /F。
      tree = await terminateTree(pid, { graceMs, isAlive: () => this.running });
    } else {
      const signalGroup = name => {
        if (pid === undefined) return;
        try {
          process.kill(-pid, name);
        } catch {
          try {
            this.child.kill(name);
          } catch {
            /* 已退出 */
          }
        }
      };
      signalGroup('SIGTERM');
      const timer = setTimeout(() => signalGroup('SIGKILL'), graceMs);
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, graceMs + 2000))]);
      clearTimeout(timer);
      if (this.running) signalGroup('SIGKILL');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    }

    return {
      stopped: !this.running,
      forced: this.running || this.signal === 'SIGKILL' || Boolean(tree?.escalated) || tree?.force === true,
      exitCode: this.exitCode,
      signal: this.signal,
      ...(tree
        ? {
            treeKill: {
              method: tree.method,
              ok: tree.ok !== false,
              escalated: Boolean(tree.escalated),
              ...(tree.gracefulError ? { gracefulError: tree.gracefulError } : {}),
            },
          }
        : {}),
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
      runtimePort: this.runtimePort,
      // pid 是 wrapper（caffeinate）还是引擎本身，调用方必须能分辨
      pidSource: this.pidSource,
      enginePid: this.enginePid,
      // 桥的形态对调用方是重要信息：installed=项目里提交过桥，transient=这次零足迹注入
      ...(this.bridge ? { bridge: this.bridge } : {}),
      stdoutBytes: this.stdout.length,
      stderrBytes: this.stderr.length,
      truncated: this.truncated,
      ...(this.cleanupError ? { cleanupError: this.cleanupError } : {}),
    };
  }
}

/**
 * 取「可信的引擎 pid」。
 *
 * macOS 上 keepAwake 会用 caffeinate 包住 Godot，此时 `child.pid` 是 **caffeinate 的 pid**，
 * 拿它去做 PID 校验必然误报 PID_MISMATCH。所以：
 *   · direct / wrapper-resolved → 返回真实引擎 pid；
 *   · unresolved-wrapper → 返回 undefined（宁可只校验项目，也不用假 pid 制造误报）。
 * Windows 没有 wrapper，永远是 direct。
 *
 * @param {{pidSource?: string, enginePid?: number, child?: {pid?: number}}} process_
 * @returns {number|undefined}
 */
export function trustedEnginePid(process_) {
  if (!process_) return undefined;
  if (process_.pidSource === 'unresolved-wrapper') return undefined;
  return process_.enginePid ?? process_.child?.pid;
}

/** 进程注册表。DSH 插件进程内的单例；工具调用之间共享。 */
export class ProcessRegistry {
  constructor() {
    this.processes = new Map();
    /** attach 模式：只注入桥、不持有进程。 */
    this.attached = new Map();
    this.transientBridges = new Map();
    this.projectTasks = new Map();
  }

  #withProject(projectPath, action) {
    const previous = this.projectTasks.get(projectPath) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    this.projectTasks.set(projectPath, task);
    const release = () => {
      if (this.projectTasks.get(projectPath) === task) this.projectTasks.delete(projectPath);
    };
    task.then(release, release);
    return task;
  }

  #projectActive(projectPath) {
    return [...this.processes.values()].some(p => p.kind === 'game' && p.running && p.projectPath === projectPath) ||
      [...this.attached.values()].some(entry => entry.projectPath === projectPath);
  }

  async #prepareBridge(projectPath, options) {
    const current = this.transientBridges.get(projectPath);
    if (current && !['none', 'installed'].includes(options.bridge)) {
      return { ...current, injected: false, shared: true };
    }
    const bridge = await prepareBridge(projectPath, options);
    if (bridge.mode === 'transient') this.transientBridges.set(projectPath, bridge);
    return bridge;
  }

  async #cleanupProject(projectPath, untracked = false) {
    if (!this.transientBridges.has(projectPath) && !untracked) return undefined;
    if (this.#projectActive(projectPath)) return { deferred: true, reason: 'project-in-use' };
    const result = await restoreTransientBridge(projectPath);
    this.transientBridges.delete(projectPath);
    return result;
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
    return this.#withProject(projectPath, async () => {
      const bridge = await this.#prepareBridge(projectPath, options);
      const args = [];
      if (options.headless) args.push('--headless');
      args.push('--path', projectPath);
      if (options.scene) args.push(options.scene);
      args.push(...(options.extraArgs ?? []));
      // 端口双保险之一：env 明确告诉运行时脚本监听哪个端口（另一个是注入写的 port.cfg）
      const runtimePort = options.runtimePort ?? DEFAULT_RUNTIME_PORT;
      const process_ = this.#spawn('game', binary, args, projectPath, options.keepAwake, {
        GODOT_MCP_RUNTIME_PORT: String(runtimePort),
      }, runtimePort);
      process_.bridge = bridge;
      return process_;
    });
  }

  /**
   * attach 模式：只注入桥、不启动游戏。适用于游戏由别的东西启动
   * （CI、手动 `godot --path .`、外部调试器）但你仍然想用运行时工具的场景。
   */
  async attach(projectPath, options = {}) {
    return this.#withProject(projectPath, async () => {
      const bridge = await this.#prepareBridge(projectPath, { ...options, bridge: options.bridge ?? 'transient' });
      const id = `attached-${randomUUID().slice(0, 8)}`;
      this.attached.set(id, { id, kind: 'attached', projectPath, bridge, startedAt: Date.now() });
      return { id, bridge, projectPath };
    });
  }

  /** 撤销 attach（等价于对它做 stop）。 */
  async detach(id, projectPath) {
    const entry = id ? this.attached.get(id) : undefined;
    const project = entry?.projectPath ?? projectPath;
    if (!project) return undefined;
    return this.#withProject(project, async () => {
      if (entry) this.attached.delete(entry.id);
      else for (const [key, value] of this.attached) {
        if (value.projectPath === project) this.attached.delete(key);
      }
      return { ...(entry ? { id: entry.id } : {}), projectPath: project, ...(await this.#cleanupProject(project, true)) };
    });
  }

  /**
   * 回收「记录里还有、但已无活跃会话」的注入（MCP 被杀之后留下的残留）。
   *
   * 语义边界（重要）：这是**显式**清理（godot_session(action="cleanup")），
   * 不存在「server 启动时自动扫一遍」的行为。而且：
   *   · 本项目仍有活跃会话 → 跳过；
   *   · 记录里的 owner 进程还活着（另一个 server 在用）→ 跳过。
   * 只有确实无主的残留才会被还原，避免把别人正在使用的项目级 override 改掉。
   */
  async sweepInjections() {
    const reports = [];
    for (const entry of await pendingInjections()) {
      await this.#withProject(entry.project, async () => {
        if (this.#projectActive(entry.project)) {
          reports.push({ project: entry.project, cleaned: false, skipped: 'project-active', note: '该项目仍有活跃会话，不还原' });
          return;
        }
        const owner = entry.owner;
        if (owner?.pid && owner.pid !== process.pid && pidAlive(owner.pid)) {
          reports.push({
            project: entry.project,
            cleaned: false,
            skipped: 'owner-alive',
            owner,
            note: `注入者进程 ${owner.pid} 还活着（可能是另一个 server），不做还原以免破坏它正在用的注入`,
          });
          return;
        }
        reports.push({ project: entry.project, cleaned: true, ...(await this.#cleanupProject(entry.project, true)) });
      });
    }
    return reports;
  }

  #spawn(kind, binary, args, projectPath, keepAwake, env, runtimePort) {
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
      env,
      runtimePort,
    }).start();
    this.processes.set(id, process_);
    process_.on('exit', () => {
      // 退出事件同步登记 Promise：stop(id/kind) 可等待同一份清理，不会重复恢复。
      if (kind === 'game') {
        process_.bridgeCleanup = this.#withProject(projectPath, () => this.#cleanupProject(projectPath));
        process_.bridgeCleanup.catch(error => { process_.cleanupError = String(error?.message ?? error); });
      }
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
    const cleanup = await process_.bridgeCleanup;
    return cleanup ? { ...result, bridgeCleanup: cleanup } : result;
  }

  async stopAll() {
    const attachedIds = [...this.attached.keys()];
    const results = await Promise.all([
      ...[...this.processes.values()].map(async process_ => {
        return { id: process_.id, ...(await this.stop(process_.id)) };
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
