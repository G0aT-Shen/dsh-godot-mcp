#!/usr/bin/env node
// 嵌套进程助手：把 `ops.gd` 里原来的 `/bin/sh` 看门狗换成「无 shell 的 Node 子进程执行器」。
//
// 调用方（godot/ops.gd）用 OS.create_process 启动：
//   node <本文件> <request.json>
// 请求 JSON：
//   {exe, args, cwd?, timeoutMs, outPath, errPath, resultPath, statusPath, maxBytes?}
//
// 为什么必须换成它（实测依据，见 verification/WINDOWS-IMPLEMENTATION-20261016.md §1）：
//   * 旧实现写 `#!/bin/sh` 脚本再 `OS.execute("/bin/sh", …)`，原生 Windows 没有 /bin/sh，
//     脚本里的 `sleep`/`kill`/`pkill` 也都不存在 → 导入、导出、run_project、deep parse_check
//     在 Windows 上直接不可用；
//   * `OS.execute` 会把实参拼成命令行交给 shell（实测字面量 `$HOME` 被展开），
//     路径里的空格/引号/`$`/中文/`#` 都有被改写或截断的风险。这里改用 Node 的
//     `spawn(exe, args, {shell:false})`：逐参传递、不经过任何 shell。
//
// 生命周期约定（两侧都靠它成立）：
//   * Node 启动内层命令时不做 detached；Godot 启动 helper 仍会另建进程组，
//     所以取消依赖终止前的完整后代快照或 Windows taskkill /T。
//   * **子进程没死，helper 不退出**：正常路径等 close，超时/取消路径先杀树再写结果；
//   * 立刻把子进程 pid 写进 statusPath：外层若判定 helper 卡死，可以按 pid 精确杀树；
//   * 父进程（Godot）被强杀时，Windows 上 taskkill /T 覆盖不到「已经脱管的孤儿」，
//     所以这里每秒检查父进程存活，发现父进程消失就主动杀掉自己的子树。
//
// 结果文件（resultPath）原子写入：
//   {ok, exitCode, signal, timedOut, orphaned, killed, durationMs, truncated, stdoutBytes, stderrBytes, pid, exe, args}
// stdout / stderr **分开**落在 outPath / errPath，超时也保留已捕获的部分。

import fs from 'node:fs';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { killTree, listDescendants } from './proc-tree.mjs';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 单流上限，防止长跑游戏把磁盘写满
const KILL_WAIT_MS = 10_000;
const PARENT_POLL_MS = 1000;

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  fs.renameSync(temporary, file);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readRequest(requestPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (typeof parsed.exe !== 'string' || !parsed.exe) return undefined;
    if (!Array.isArray(parsed.args)) return undefined;
    for (const key of ['outPath', 'errPath', 'resultPath']) {
      if (typeof parsed[key] !== 'string' || !parsed[key]) return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 杀树模式（无 shell）：`node nested-helper.mjs --kill <request.json>`
 *
 * 为什么外层不能自己 `OS.kill(child)` 了事：Godot 给 `OS.create_process` 起的进程
 * **新建进程组**，而嵌套进程再拉起的孙进程只靠单 pid kill 是收不到的。
 * 这里先按 pid 快照整棵子树（杀之前），再逐个回收并在有界时间内确认。
 *
 * 请求：{roots: [pid...], timeoutMs, resultPath}
 * 结果：{ok, roots, snapshot, survivors, waitedMs}
 */
async function runKillMode(requestPath) {
  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`invalid kill request: ${error?.message ?? error}\n`);
    process.exitCode = 2;
    return;
  }
  const roots = (Array.isArray(request.roots) ? request.roots : [])
    .map(Number)
    .filter(pid => Number.isInteger(pid) && pid > 0);
  const timeoutMs = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 8000;
  const startedAt = Date.now();

  // **杀前快照**：父子关系一旦被破坏就再也枚举不出后代了
  const targets = new Set();
  for (const root of roots) {
    targets.add(root);
    for (const descendant of listDescendants(root)) targets.add(descendant);
  }
  const all = [...targets];
  const kills = [];
  for (const root of roots) kills.push(await killTree(root, { force: true }));
  for (const pid of all.slice().reverse()) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }

  const isAlive = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
  };
  const alive = new Set(all);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive.size > 0) {
    for (const pid of [...alive]) if (!isAlive(pid)) alive.delete(pid);
    if (alive.size) await new Promise(resolve => setTimeout(resolve, 50));
  }
  const survivors = [...alive].filter(isAlive);
  const result = {
    ok: survivors.length === 0,
    roots,
    snapshot: all.length,
    survivors,
    waitedMs: Date.now() - startedAt,
    kills: kills.map(kill => ({ method: kill.method, ok: kill.ok, descendants: kill.descendants })),
  };
  try {
    writeJsonAtomic(request.resultPath, result);
  } catch (error) {
    process.stderr.write(`cannot write kill result: ${error?.message ?? error}\n`);
    process.exitCode = 3;
    return;
  }
  try { fs.rmSync(requestPath, { force: true }); } catch { /* 临时文件 */ }
  process.exit(survivors.length ? 1 : 0);
}

function main() {
  if (process.argv[2] === '--kill') {
    void runKillMode(process.argv[3]);
    return;
  }
  const requestPath = process.argv[2];
  if (!requestPath) {
    process.stderr.write('usage: nested-helper.mjs <request.json> | --kill <request.json>\n');
    process.exitCode = 2;
    return;
  }
  const request = readRequest(requestPath);
  if (!request) {
    process.stderr.write(`invalid request: ${requestPath}\n`);
    process.exitCode = 2;
    return;
  }

  const {
    exe,
    args,
    cwd,
    timeoutMs = 0,
    outPath,
    errPath,
    resultPath,
    statusPath,
    maxBytes = DEFAULT_MAX_BYTES,
  } = request;

  const startedAt = Date.now();
  const parentPid = process.ppid;
  const counters = { stdout: 0, stderr: 0 };
  let truncated = false;
  const fds = {
    stdout: fs.openSync(outPath, 'w'),
    stderr: fs.openSync(errPath, 'w'),
  };
  // 直接写**原始字节**：`String(chunk)` 会按 chunk 边界解码，一个多字节 UTF-8 字符
  // 被拆到两个 chunk 时会变成替换字符（中文输出尤其明显）。计数也按字节。
  const append = (key, chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (counters[key] + buffer.length > maxBytes) {
      if (!truncated) {
        truncated = true;
        fs.writeSync(fds[key], Buffer.from(`\n[truncated: 超过 ${maxBytes} 字节上限]\n`, 'utf8'));
      }
      counters[key] += buffer.length;
      return;
    }
    counters[key] += buffer.length;
    fs.writeSync(fds[key], buffer);
  };

  let settled = false;
  let timedOut = false;
  let orphaned = false;
  let durationMs = 0;
  let killResult;
  let closed = false;
  let exitInfo;
  let terminating = false; // 已经在走「杀树 → 等 close」流程：期间不落结果、不退出
  let child;
  let timer;
  let parentWatch;
  const finish = (extra = {}) => {
    // terminating 期间**不能** exit：此刻 taskkill/后代终止可能还在进行，
    // 提前 process.exit 会把杀树中断掉，后代就漏了。
    if (settled || terminating) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(parentWatch);
    for (const fd of Object.values(fds)) {
      try { fs.closeSync(fd); } catch { /* 已关闭 */ }
    }
    durationMs = Date.now() - startedAt;
    const result = {
      ok: true,
      timedOut,
      orphaned,
      killed: Boolean(killResult),
      ...(killResult ? { killMethod: killResult.method, killOk: killResult.ok } : {}),
      durationMs,
      truncated,
      stdoutBytes: counters.stdout,
      stderrBytes: counters.stderr,
      pid: child?.pid,
      exe,
      args,
      ...extra,
    };
    try {
      writeJsonAtomic(resultPath, result);
    } catch (error) {
      process.stderr.write(`cannot write result: ${error?.message ?? error}\n`);
      process.exitCode = 3;
      return;
    }
    try { fs.rmSync(requestPath, { force: true }); } catch { /* 临时文件，删不掉不影响结果 */ }
    // 结果文件先落盘（外层轮询它），再退出 —— 顺序反了外层就可能读到半截/读不到。
    process.exit(0);
  };

  /**
   * 杀掉子树，并在有界时间内等它真的结束（子进程没死 helper 不退出）。
   * taskkill 是异步进程：killTree 只在它自己退出后才 resolve，所以这里的 await
   * 同时保证「不会在 taskkill 跑一半时 process.exit」。
   */
  const killAndWait = async (reason, extra = {}) => {
    if (terminating) return;
    terminating = true;
    clearTimeout(timer);
    let killError;
    try {
      if (!child?.pid) {
        finish({ ...extra, spawnError: true });
        return;
      }
      killResult = await killTree(child.pid, { force: true });
      const deadline = Date.now() + KILL_WAIT_MS;
      while (Date.now() < deadline && !closed) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const stillRunning = !closed;
      // 再确认一次：close 没到但进程其实已经没了（Windows 上 pid 复用/句柄延迟）
      if (stillRunning && !isAlive(child.pid)) closed = true;
    } catch (error) {
      // 杀树本身抛错也必须落结果：外层在等这个文件，异常退出会让它等到超时。
      killError = String(error?.message ?? error);
    } finally {
      terminating = false;
      finish({
        ...extra,
        ...(exitInfo ?? {}),
        ...(closed ? {} : { stillRunning: true }),
        killReason: reason,
        killOk: killResult?.ok !== false && killError === undefined,
        ...(killError ? { killError } : {}),
      });
    }
  };

  try {
    child = spawn(exe, args, {
      cwd,
      shell: false, // 关键：不经过任何 shell
      detached: false, // 不额外脱离 helper；外层仍需按完整进程树回收
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (error) {
    finish({ spawnError: true, error: String(error?.message ?? error) });
    return;
  }

  timer = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        killAndWait('timeout').catch(error => {
          finish({ timedOut: true, killError: String(error?.message ?? error) });
        });
      }, timeoutMs)
    : undefined;

  // 父进程（Godot）被强杀时的兜底：Windows 的 taskkill /T 只覆盖当时还在关系树里的后代，
  // 一旦外层是被 TerminateProcess 直接干掉的，我们就是孤儿 —— 自己收尾，不留残留进程。
  parentWatch = setInterval(() => {
    if (settled) return;
    const current = process.ppid;
    if (current !== parentPid || (parentPid > 0 && !isAlive(parentPid))) {
      orphaned = true;
      killAndWait('parent-gone').catch(error => {
        finish({ orphaned: true, killError: String(error?.message ?? error) });
      });
    }
  }, PARENT_POLL_MS);

  child.stdout?.on('data', chunk => append('stdout', chunk));
  child.stderr?.on('data', chunk => append('stderr', chunk));

  child.on('error', error => {
    // spawn 失败（ENOENT/EACCES）走这里：没有 pid，也没有 close 语义可依赖
    finish({ spawnError: true, error: String(error?.message ?? error) });
  });
  child.on('close', (code, signal) => {
    // close 只更新状态：终止流程（timeout/父进程消失）还在跑时，
    // 由 killAndWait 统一落结果，避免「杀树没做完就 exit」。
    closed = true;
    exitInfo = { exitCode: code, signal: signal ?? null };
    if (terminating) return;
    finish({ ...exitInfo, durationMs: Date.now() - startedAt });
  });

  // 立刻公布子进程 pid，外层超时时才有办法定位后代
  if (statusPath && child.pid) {
    try {
      writeJsonAtomic(statusPath, { pid: child.pid, startedAt: new Date(startedAt).toISOString(), exe, args, timeoutMs });
    } catch { /* status 只是诊断辅助，不阻断 */ }
  }
}

main();
