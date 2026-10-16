// 跨平台进程树回收。
//
// 为什么单独成模块：Windows 没有 POSIX 进程组，`child.kill()` 只会结束**根**进程，
// Godot 的后代（嵌套 helper、helper 再拉起的 Godot）会变成孤儿继续跑、继续占端口、
// 继续持有项目文件。原来 win32 分支就是一句 `child.kill()`，等于「静默泄漏」。
//
// 关键顺序约束（踩过才写下来的）：**必须在 root 还活着的时候杀树**。
// `taskkill /T` 是靠「父进程 → 子进程」关系现场枚举后代的；一旦先 TerminateProcess
// 掉根进程，系统里再没有能定位后代的依据，`taskkill /PID <dead> /T` 只会报
// "process not found"，后代全部逃逸。所以调用方必须先杀树、再等 close，
// 绝不能先 child.kill() 再补救。
//
// POSIX 在终止前快照全部后代，同时尝试进程组终止。Godot 的 OS.create_process
// 会创建独立进程组，不能仅依赖外层进程组覆盖 helper 与嵌套 Godot。

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

/** Windows 上 taskkill 的绝对路径（不依赖 PATH 的搜索顺序）。 */
export function taskkillPath(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return undefined;
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'taskkill.exe');
}

/** `taskkill` 参数（纯函数，便于断言顺序与 /T 的存在）。 */
export function taskkillArgs(pid, { force = true, tree = true } = {}) {
  const args = ['/PID', String(pid)];
  if (tree) args.push('/T');
  if (force) args.push('/F');
  return args;
}

/**
 * POSIX：列出某个 pid 的全部后代（不含它自己），**从深到浅**排序。
 *
 * 为什么需要它：进程组只覆盖「组长及其组内成员」。嵌套 helper 拉起的 Godot
 * 刻意 `detached:false`（不能逃出外层进程组），因此它**不是组长** —— 对它的 pid
 * 做 `kill(-pid)` 会 ESRCH，退化成只杀它自己，它再拉起的子孙就漏掉了。
 * 实测过：不走出这一步，超时/取消后孙进程会活下来（见 test/nested-exec.test.mjs）。
 *
 * 用 `ps -A -o pid=,ppid=`（macOS/BSD 与 GNU 都支持）；容器里没有 ps 就返回空数组，
 * 此时退化为「只杀目标 pid」——由调用方的进程组路径兜底。
 *
 * @param {number} pid
 * @param {{psImpl?: () => string}} [options]
 * @returns {number[]} 后代 pid，深到浅（先杀子孙，再杀子）
 */
export function listDescendants(pid, options = {}) {
  const { psImpl } = options;
  let output;
  try {
    output = psImpl
      ? psImpl()
      : spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 10_000 }).stdout ?? '';
  } catch {
    return [];
  }
  const childrenOf = new Map();
  for (const line of String(output).split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(child);
  }
  const ordered = [];
  const walk = current => {
    for (const child of childrenOf.get(current) ?? []) {
      walk(child);
      ordered.push(child); // 后序：深的先进列表
    }
  };
  walk(pid);
  return ordered;
}

/**
 * 结束一棵进程树。
 *
 * @param {number} pid 根进程 pid（**必须仍然存活**，否则 Windows 上无法定位后代）
 * @param {{force?: boolean, platform?: NodeJS.Platform, env?: Record<string,string|undefined>,
 *          timeoutMs?: number, spawnImpl?: typeof spawn, psImpl?: () => string}} [options]
 * @returns {Promise<{ok: boolean, method: 'process-group'|'process'|'taskkill', force: boolean,
 *          code?: number|null, stderr?: string, error?: string}>}
 */
export function killTree(pid, options = {}) {
  const {
    force = true,
    platform = process.platform,
    env = process.env,
    timeoutMs = 15_000,
    spawnImpl = spawn,
    psImpl,
  } = options;

  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ ok: false, method: platform === 'win32' ? 'taskkill' : 'process', force, error: 'invalid pid' });
  }

  if (platform !== 'win32') {
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    // **先快照，再杀**：父进程一死，子进程会被 reparent 到 init，`ps` 的父子关系就断了，
    // 之后再也枚举不出后代。真实 Godot 的 OS.create_process 会给子进程**新建进程组**
    // （helper 是组长，嵌套 Godot 又是另一个组长），所以「按组杀外层」覆盖不到它们 ——
    // 逐个后代 kill 才是主路径，组杀只是快路径。
    const descendants = listDescendants(pid, { psImpl });
    let groupOk = false;
    try {
      process.kill(-pid, signal); // pid 自己是组长时一次覆盖整组
      groupOk = true;
    } catch { /* 不是组长：继续走后代枚举 */ }
    let killedAny = false;
    for (const descendant of descendants) {
      try {
        process.kill(descendant, signal);
        killedAny = true;
      } catch { /* 已经退出 */ }
    }
    let selfOk = false;
    try {
      process.kill(pid, signal);
      selfOk = true;
    } catch (error) {
      // ESRCH = 已经退出，这不算失败；其它错误如实上报。
      if (error?.code !== 'ESRCH') {
        return Promise.resolve({ ok: false, method: 'process', force, error: String(error?.code ?? error?.message ?? error) });
      }
    }
    const detail = { descendants: descendants.length, group: groupOk, self: selfOk };
    if (groupOk) return Promise.resolve({ ok: true, method: 'process-group', force, ...detail });
    if (selfOk || killedAny) return Promise.resolve({ ok: true, method: 'process', force, ...detail });
    return Promise.resolve({ ok: true, method: 'process', force, note: 'already-exited', ...detail });
  }

  const exe = taskkillPath(env, platform);
  const args = taskkillArgs(pid, { force });
  return new Promise(resolve => {
    let stderr = '';
    let settled = false;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawnImpl(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (error) {
      finish({ ok: false, method: 'taskkill', force, error: String(error?.message ?? error) });
      return;
    }
    // 必须在 finish 之前初始化：spawn 抛错时 finish 会先跑，此时 timer 还在 TDZ，
    // `clearTimeout(timer)` 会抛 ReferenceError 把真实错误盖掉。
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ ok: false, method: 'taskkill', force, error: `taskkill 超时（${timeoutMs}ms）`, stderr });
    }, timeoutMs);
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => finish({ ok: false, method: 'taskkill', force, error: String(error?.message ?? error), stderr }));
    child.on('close', code => {
      // taskkill 对「已经退出的进程」返回 128；对「不能优雅结束」返回 1 并带
      // "can only be terminated forcefully" —— 都交给调用方判断，不在这里吞掉。
      finish({ ok: code === 0, method: 'taskkill', force, code, stderr: stderr.trim() || undefined });
    });
  });
}

/**
 * 尽力优雅结束 + 超时强杀的组合。
 *
 * POSIX：先用 SIGTERM 让 Godot 正常落盘，宽限期后 SIGKILL 整组。
 * Windows：`taskkill /T`（不带 /F）**通常**无法结束 headless 控制台进程，
 * 这时会返回非零并提示只能强杀 —— 我们如实记录原因，再 `/T /F`。
 * 不承诺 Windows 上一定落盘：强杀就是会丢未写盘的数据。
 *
 * @param {number} pid
 * @param {{graceMs?: number, platform?: NodeJS.Platform, env?: Record<string,string|undefined>,
 *          isAlive?: () => boolean, delay?: (ms: number) => Promise<void>}} [options]
 */
export async function terminateTree(pid, options = {}) {
  const {
    graceMs = 5000,
    platform = process.platform,
    env = process.env,
    isAlive = () => true,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = options;

  const graceful = await killTree(pid, { force: false, platform, env });
  if (platform === 'win32') {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && isAlive()) await delay(50);
    if (!isAlive() && graceful.ok) return { ...graceful, escalated: false };
    const forced = await killTree(pid, { force: true, platform, env });
    return { ...forced, escalated: true, gracefulError: graceful.ok ? undefined : graceful.stderr ?? graceful.error };
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isAlive()) await delay(50);
  if (!isAlive()) return { ...graceful, escalated: false };
  const forced = await killTree(pid, { force: true, platform, env });
  return { ...forced, escalated: true };
}
