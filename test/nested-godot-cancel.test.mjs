// 真实 Godot → Node helper → 嵌套 Godot 的取消/超时回归。
//
// 为什么必须单独有这一条：实测（见 docs/WINDOWS-IMPLEMENTATION-STATUS.md §2.1）
// Godot 的 `OS.create_process` 会给子进程**新建进程组**：
//
//   $ ps -o pid=,ppid=,pgid= -p <godot-spawned-node>   →  68585 68582 68585
//                                                          ^pid  ^parent ^pgid=自己
//
// 也就是说「外层 Godot 的进程组」根本覆盖不到 helper 与嵌套 Godot ——
// 靠 `kill(-outerPid)` 回收整棵树的假设是**错的**，`detached:false` 也不构成保证。
// 唯一可靠的路径是：杀之前按 pid 快照后代，再逐个回收（Windows 用 taskkill /T /F）。
//
// 本用例用真实引擎跑完整链路：外层 Godot 执行 run_project（经 Node helper）拉起嵌套
// Godot，然后中途取消/让它超时，断言**所有快照到的 pid**（外层、helper、嵌套）都已退出，
// 并且调用返回时整棵树就已经回收完毕（不是「返回后再慢慢死」）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PACKAGE_ROOT, godotPath } from '../src/godot.mjs';
import { runOperation } from '../src/operations.mjs';

const ENGINE = godotPath();
const REQUIRE_GODOT = process.env.GODOT_MCP_REQUIRE_GODOT === '1';
const NO_ENGINE = ENGINE ? undefined : (REQUIRE_GODOT ? 'CI 要求真实 Godot，但没有找到可执行文件' : '没有可用的真实 Godot');
const OPS_SCRIPT = path.join(PACKAGE_ROOT, 'godot', 'ops.gd');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await delay(intervalMs);
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 列出系统进程（pid / ppid / command line）。
 *
 * POSIX 用 `ps -ax -o pid=,ppid=,command=`，Windows 用 CIM（`ParentProcessId`）。
 * 这是**测试专用**的跨平台枚举：生产的 `listDescendants` 只实现 POSIX（`ps`），
 * 在原生 Windows 上返回空数组 —— 若测试直接用它，Windows 的快照会只剩 outer + nested
 * （看着条数够，helper 其实从未被验证）。生产侧 Windows 走 taskkill /T，无需为此改动。
 */
function listProcesses() {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ], { encoding: 'utf8', timeout: 60_000 });
      const parsed = JSON.parse(output || '[]');
      return (Array.isArray(parsed) ? parsed : [parsed]).map(entry => ({
        pid: Number(entry?.ProcessId),
        ppid: Number(entry?.ParentProcessId),
        commandLine: String(entry?.CommandLine ?? ''),
      })).filter(entry => Number.isInteger(entry.pid) && entry.pid > 0);
    }
    const output = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 30_000 });
    return output.split('\n').map(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), commandLine: match[3] } : undefined;
    }).filter(Boolean);
  } catch {
    return undefined;
  }
}

/** 测试内构树：某个 pid 的全部后代（跨平台，不依赖生产的 POSIX-only 实现）。 */
function descendantsOf(rootPid) {
  const all = listProcesses();
  if (!all) return [];
  const childrenOf = new Map();
  for (const entry of all) {
    if (!childrenOf.has(entry.ppid)) childrenOf.set(entry.ppid, []);
    childrenOf.get(entry.ppid).push(entry.pid);
  }
  const out = [];
  const walk = pid => {
    for (const child of childrenOf.get(pid) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(rootPid);
  return out;
}

/** 命令行同时包含全部关键字的进程 pid。 */
function pidsMatchingAll(keywords) {
  const all = listProcesses();
  if (!all) return [];
  return all
    .filter(entry => keywords.every(keyword => entry.commandLine.includes(keyword)))
    .map(entry => entry.pid);
}

/**
 * 快照这次调用涉及的全部 pid：**外层 Godot 及其整棵后代树**（外层 / helper / 嵌套 Godot）。
 *
 * 两个踩过的坑：
 *   · 不能全系统匹配 `nested-helper.mjs`：`node --test` 并行跑多个测试文件，别的文件也在起
 *     helper —— 全系统匹配会把别人的进程算进来（误报「仍有 helper 残留」，而 t.after 的
 *     兜底清理还会误杀别人的进程）；
 *   · 不能直接用生产的 `listDescendants`：它只实现 POSIX，原生 Windows 返回空，
 *     于是快照漏掉 helper，而 `>= 2` 的断言恰好掩盖了这一点。
 */
function snapshotPids(project, pidFile) {
  const nestedRaw = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
  const nestedPid = Number(nestedRaw);
  const outerPids = pidsMatchingAll([project, OPS_SCRIPT]);
  const pids = new Set();
  for (const outer of outerPids) {
    pids.add(outer);
    for (const descendant of descendantsOf(outer)) pids.add(descendant);
  }
  if (Number.isInteger(nestedPid) && nestedPid > 0) pids.add(nestedPid);
  pids.delete(process.pid);
  return [...pids].filter(pid => Number.isInteger(pid) && pid > 0);
}

async function writeFixture(project, pidFile) {
  await fsp.mkdir(project, { recursive: true });
  await fsp.writeFile(path.join(project, 'project.godot'), [
    'config_version=5',
    '',
    '[application]',
    'config/name="mcp-nested-cancel-fixture"',
    'run/main_scene="res://main.tscn"',
    '',
  ].join('\n'));
  await fsp.writeFile(path.join(project, 'main.gd'), [
    'extends Node',
    '',
    'func _ready() -> void:',
    '\tvar target := OS.get_environment("GODOT_MCP_TEST_PIDFILE")',
    '\tif not target.is_empty():',
    '\t\tvar handle := FileAccess.open(target, FileAccess.WRITE)',
    '\t\tif handle != null:',
    '\t\t\thandle.store_string(str(OS.get_process_id()))',
    '\t\t\thandle.close()',
    '\tprint("NESTED-UP")',
    '',
  ].join('\n'));
  await fsp.writeFile(path.join(project, 'main.tscn'), [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="res://main.gd" id="1"]',
    '',
    '[node name="Main" type="Node"]',
    'script = ExtResource("1")',
    '',
  ].join('\n'));
  await fsp.writeFile(pidFile, '', { flag: 'a' });
}

/** 准备一次真实嵌套运行；返回快照与收尾手段。 */
async function startNestedRun(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-nested-cancel-'));
  const project = path.join(root, 'project');
  const pidFile = path.join(root, 'nested.pid');
  await writeFixture(project, pidFile);

  const previous = process.env.GODOT_MCP_TEST_PIDFILE;
  process.env.GODOT_MCP_TEST_PIDFILE = pidFile;
  const controller = new AbortController();
  const cleanup = async () => {
    if (previous === undefined) delete process.env.GODOT_MCP_TEST_PIDFILE;
    else process.env.GODOT_MCP_TEST_PIDFILE = previous;
    // 失败路径也必须收尾：abort + 兜底杀掉快照到的 pid
    try { controller.abort(); } catch { /* 已取消 */ }
    for (const pid of snapshotPids(project, pidFile)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }
    await fsp.rm(root, { recursive: true, force: true });
  };
  t.after(cleanup);

  // quit_after 是**秒**（ops.gd 会换算成帧）；给足 600 秒，确保不会在测试期间自然退出，
  // 从而让「取消/超时」成为唯一可能的结束原因。
  const pending = runOperation('run_project', { project, quit_after: 600, headless: true }, {
    timeoutMs: 120_000,
    signal: controller.signal,
  });
  const failure = pending.then(() => undefined, error => error);

  const nestedPid = await waitFor(async () => {
    const text = await fsp.readFile(pidFile, 'utf8').catch(() => '');
    const value = Number(text.trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }, { timeoutMs: 60_000 });
  assert.ok(nestedPid, '嵌套 Godot 必须真的启动（否则这条用例没有验证对象）');
  assert.equal(isAlive(nestedPid), true, '嵌套 Godot 在取消前必须还活着（不能是自然退出）');
  return { root, project, pidFile, nestedPid, controller, failure };
}

/** 等所有快照 pid 都退出。 */
async function assertAllDead(pids, label) {
  const survivors = [];
  for (const pid of pids) {
    const gone = await waitFor(() => !isAlive(pid), { timeoutMs: 20_000 });
    if (!gone) survivors.push(pid);
  }
  assert.deepEqual(survivors, [], `${label}：以下 pid 仍然活着 ${survivors.join(', ')}`);
}

test('真实 Godot → helper → 嵌套 Godot：取消后所有 pid 在返回前就已回收', { skip: NO_ENGINE && !REQUIRE_GODOT ? NO_ENGINE : false }, async t => {
  if (NO_ENGINE) assert.fail(NO_ENGINE);
  const run = await startNestedRun(t);
  const before = snapshotPids(run.project, run.pidFile);
  // 至少三层：外层 Godot（跑 ops.gd）+ Node helper + 嵌套 Godot。
  // 缺 helper 就等于没验证到最容易被漏掉的那一层（进程组覆盖不到它），所以这里是 >= 3。
  assert.ok(before.length >= 3, `取消前必须捕获外层 Godot + helper + 嵌套 Godot：${before.join(', ')}`);
  assert.ok(before.includes(run.nestedPid), '快照必须包含嵌套 Godot');

  run.controller.abort();
  const error = await run.failure;
  assert.ok(error, '取消必须让操作以失败结束，而不是假装成功');
  assert.equal(error.code, 'ABORTED', `取消语义应当是 ABORTED，实际：${error.code} / ${error.message}`);

  const kill = error.details?.kill ?? error.kill;
  assert.ok(kill, '取消错误里必须带上进程树回收结果');
  assert.equal(kill.ok, true, `杀树必须成功：${JSON.stringify(kill)}`);
  assert.deepEqual(kill.survivors ?? [], [], '不应有幸存者');
  assert.equal(kill.closed, true, '外层 Godot 必须在 reject 之前就已经退出（有界 await）');
  assert.ok(kill.snapshot >= 2, `杀前快照必须包含后代：${JSON.stringify(kill)}`);
  assert.ok(before.includes(kill.pid), `kill.pid 必须就是外层 Godot：kill=${kill.pid} snapshot=${before.join(',')}`);

  // 调用返回时整棵树就该没了 —— 调用方可以立刻做下一步写操作。
  // 断言只用**本次的快照**：全系统匹配 `nested-helper.mjs` 会把并行跑的其它测试文件的
  // helper 也算进来（实测误报「仍有 helper 残留」，而且 t.after 里的兜底清理还会误杀别人的进程）。
  await assertAllDead(before, '取消后');
  // 项目路径是本用例独有的临时目录，所以按项目匹配是精确的（不会撞到别的测试文件）
  const afterProject = pidsMatchingAll([run.project]);
  assert.deepEqual(afterProject, [], `取消后仍有进程指向该项目：${afterProject.join(', ')}`);
  t.diagnostic(`快照 pid=${before.join(', ')}；kill=${JSON.stringify(kill)}`);
});

test('真实 Godot → helper → 嵌套 Godot：外层超时同样在返回前回收整棵树', { skip: NO_ENGINE && !REQUIRE_GODOT ? NO_ENGINE : false }, async t => {
  if (NO_ENGINE) assert.fail(NO_ENGINE);
  const run = await startNestedRun(t);
  const before = snapshotPids(run.project, run.pidFile);

  // 另起一次短超时的调用（不动第一个调用的 signal）：触发外层 TIMEOUT 回收路径
  const timedOut = await runOperation('run_project', { project: run.project, quit_after: 600, headless: true }, {
    timeoutMs: 3000,
  }).then(() => undefined, error => error);
  assert.ok(timedOut, '超时必须让操作以失败结束');
  assert.equal(timedOut.code, 'TIMEOUT', `超时语义应当是 TIMEOUT，实际：${timedOut.code} / ${timedOut.message}`);

  const kill = timedOut.details?.kill ?? timedOut.kill;
  assert.ok(kill, '超时错误里必须带上进程树回收结果');
  assert.deepEqual(kill.survivors ?? [], [], '超时不应留下幸存者');
  assert.equal(kill.closed, true, '超时路径也必须在返回前等到进程退出');

  // 第一次调用（仍在跑）也要收尾：abort + 等它结束
  run.controller.abort();
  await run.failure;
  await assertAllDead(before, '超时后');
});
