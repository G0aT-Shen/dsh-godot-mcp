// 嵌套执行 + 进程树回收的跨平台回归。
//
// 这里刻意**不用任何 POSIX 专有物**：夹具是可执行文件（node.exe / node），
// 脚本走 `-e` 传入，不用 shebang、不用 .cmd —— 这样同一套用例在 macOS 和
// windows-latest 上都是原生可跑的（旧的 lifecycle 夹具靠 `#!` 脚本，Windows 上只能跳过）。
//
// 覆盖的验收点：
//   1. 输出分离（stdout/stderr 不混）、真实退出码、参数边界（空格/引号/$/中文/#）；
//   2. 超时杀树：子进程 + 孙进程都要死；
//   3. 外层被强杀时不留孤儿（helper 的父进程看门狗）；
//   4. runProcess 的取消/超时回收整棵子树；
//   5. killTree / terminateTree 对三代进程树的真实回收；
//   6. 唯一临时产物全部清理，不留文件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killTree, taskkillArgs, taskkillPath, terminateTree } from '../src/proc-tree.mjs';
import { runProcess } from '../src/godot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, '..', 'src', 'nested-helper.mjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await delay(intervalMs);
    if (Date.now() > deadline) {
      assert.fail(`等待超时（${timeoutMs}ms）：${label}`);
    }
  }
}

const alive = pid => waitFor(() => !isAlive(pid), { timeoutMs: 10_000, label: `pid ${pid} 退出` });
const dead = async (pid, label) => assert.equal(await alive(pid), true, `${label}（pid ${pid}）必须已经被回收`);

/** 起一次 helper，返回 {dir, result, status, started}。 */
async function runHelper(request, { waitMs = 20_000 } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-nested-'));
  const files = {
    dir,
    req: path.join(dir, 'req.json'),
    out: path.join(dir, 'out.txt'),
    err: path.join(dir, 'err.txt'),
    result: path.join(dir, 'result.json'),
    status: path.join(dir, 'status.json'),
  };
  await fsp.writeFile(files.req, JSON.stringify({
    exe: process.execPath,
    args: [],
    timeoutMs: 5000,
    outPath: files.out,
    errPath: files.err,
    resultPath: files.result,
    statusPath: files.status,
    ...request,
  }));
  const helper = spawn(process.execPath, [HELPER, files.req], { stdio: ['ignore', 'pipe', 'pipe'] });
  // 必须在 spawn 之后立刻挂上：helper 写完结果就 exit，等我们轮询到结果再去监听 'close'
  // 会永远等不到（事件早就发过了）。
  const helperClosed = new Promise(resolve => helper.once('close', resolve));
  let helperStderr = '';
  helper.stderr.on('data', chunk => { helperStderr += String(chunk); });
  const result = await waitFor(async () => {
    try {
      return JSON.parse(await fsp.readFile(files.result, 'utf8'));
    } catch {
      return undefined;
    }
  }, { timeoutMs: waitMs, label: 'helper 结果文件' });
  assert.ok(result, `helper 必须写出结果文件（stderr: ${helperStderr.slice(0, 300)}）`);
  await Promise.race([helperClosed, delay(10_000).then(() => assert.fail('helper 写完结果后必须自己退出'))]);
  return { files, result, helperStderr };
}

test('helper：stdout/stderr 分离、真实退出码、参数逐字传递、产物清理', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-args-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const argvFile = path.join(dir, 'argv.json');
  const tricky = ['a b', "it's", '${HOME}', '`whoami`', '中文 #1', 'x;y&z', 'C:\\DSH #1\\n.exe'];
  const script = 'const fs=require("node:fs");'
    + 'fs.writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)));'
    + 'process.stdout.write("OUT-MARKER\\n");'
    + 'process.stderr.write("ERR-MARKER\\n");'
    + 'process.exit(7);';
  const { files, result } = await runHelper({
    args: ['-e', script, argvFile, ...tricky],
    timeoutMs: 10_000,
  });

  assert.equal(result.spawnError, undefined, '不该是 spawn 失败');
  assert.equal(result.exitCode, 7, '必须拿到真实退出码');
  assert.equal(result.timedOut, false);
  assert.equal(await fsp.readFile(files.out, 'utf8'), 'OUT-MARKER\n');
  assert.equal(await fsp.readFile(files.err, 'utf8'), 'ERR-MARKER\n');
  assert.equal(fs.existsSync(files.req), false, 'helper 必须删掉自己的请求文件');
  assert.ok(JSON.parse(await fsp.readFile(files.status, 'utf8')).pid > 0, 'status 必须记录子进程 pid');
  assert.deepEqual(JSON.parse(await fsp.readFile(argvFile, 'utf8')), tricky, '参数必须逐字传递（不经 shell）');
});

test('helper：spawn 失败如实上报（不挂死、不假装成功）', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-nospawn-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { result } = await runHelper({ exe: path.join(dir, 'does-not-exist-xyz'), args: [], timeoutMs: 5000 });
  assert.equal(result.spawnError, true);
  assert.match(String(result.error), /ENOENT|not found|no such file/i);
  assert.equal(result.timedOut, false);
});

test('helper：超时会杀掉整棵子树（子进程与孙进程都不留）', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-timeout-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pids.json');
  const script = 'const {spawn}=require("node:child_process");const fs=require("node:fs");'
    + 'const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:false});'
    + 'fs.writeFileSync(process.argv[1],JSON.stringify({child:process.pid,grandchild:g.pid}));'
    + 'process.stdout.write("UP\\n");setInterval(()=>{},1000);';
  const { files, result } = await runHelper({ args: ['-e', script, pidFile], timeoutMs: 1200 });

  assert.equal(result.timedOut, true);
  assert.equal(result.killed, true, '超时路径必须真的杀过树');
  assert.equal(await fsp.readFile(files.out, 'utf8'), 'UP\n', '超时也必须保留已捕获输出');
  const pids = JSON.parse(await fsp.readFile(pidFile, 'utf8'));
  assert.ok(pids.child > 0 && pids.grandchild > 0);
  await dead(pids.child, '超时的子进程');
  await dead(pids.grandchild, '超时的孙进程');
});

test('helper：外层被强杀时，父进程看门狗回收子树（不留孤儿）', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-orphan-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pids.json');
  const inner = 'const {spawn}=require("node:child_process");const fs=require("node:fs");'
    + 'const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:false});'
    + 'fs.writeFileSync(process.argv[1],JSON.stringify({child:process.pid,grandchild:g.pid}));'
    + 'setInterval(()=>{},1000);';

  // middle 是 helper 的父进程；我们对 middle 直接 SIGKILL，模拟外层 Godot 被强杀。
  const middleScript = 'const {spawn}=require("node:child_process");const fs=require("node:fs");'
    + 'const h=spawn(process.execPath,[process.argv[1],process.argv[2]],{stdio:"ignore"});'
    + 'fs.writeFileSync(process.argv[3],JSON.stringify({helper:h.pid}));setInterval(()=>{},1000);';
  const reqPath = path.join(dir, 'req.json');
  const outPath = path.join(dir, 'out.txt');
  const resultPath = path.join(dir, 'result.json');
  await fsp.writeFile(reqPath, JSON.stringify({
    exe: process.execPath,
    args: ['-e', inner, pidFile],
    timeoutMs: 60_000,
    outPath,
    errPath: path.join(dir, 'err.txt'),
    resultPath,
    statusPath: path.join(dir, 'status.json'),
  }));
  const middle = spawn(process.execPath, ['-e', middleScript, HELPER, reqPath, path.join(dir, 'middle.json')], { stdio: 'ignore' });
  t.after(() => { try { process.kill(middle.pid, 'SIGKILL'); } catch { /* 已退出 */ } });

  const nested = await waitFor(async () => {
    try { return JSON.parse(await fsp.readFile(pidFile, 'utf8')); } catch { return undefined; }
  }, { timeoutMs: 15_000, label: '嵌套子进程 pid' });
  assert.ok(nested?.grandchild > 0, '嵌套孙进程必须已经起来');

  process.kill(middle.pid, 'SIGKILL'); // 强杀 helper 的父进程
  await dead(nested.grandchild, '父进程消失后的孙进程');
  await dead(nested.child, '父进程消失后的子进程');
  // helper 只在「子树真的死掉」之后才写结果，所以这里必须等结果文件出现，
  // 不能杀完立刻读（那会读到「还没有结果」而不是「没有清理」）。
  const result = await waitFor(async () => {
    try {
      return JSON.parse(await fsp.readFile(resultPath, 'utf8'));
    } catch {
      return undefined;
    }
  }, { timeoutMs: 15_000, label: '父进程消失后的 helper 结果文件' });
  assert.ok(result, 'helper 必须写出结果文件');
  assert.equal(result.orphaned, true, '结果文件必须记录「父进程消失」这一原因');
  assert.equal(result.stillRunning, undefined, '子树必须真的已经结束');
});

test('runProcess：取消与超时都会回收整棵子树', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-runproc-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const script = 'const {spawn}=require("node:child_process");const fs=require("node:fs");'
    + 'const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:false});'
    + 'fs.writeFileSync(process.argv[1],JSON.stringify({root:process.pid,grandchild:g.pid}));'
    + 'setInterval(()=>{},1000);';

  // 1) 取消
  const abortFile = path.join(dir, 'abort.json');
  const controller = new AbortController();
  const aborted = runProcess(process.execPath, ['-e', script, abortFile], { timeoutMs: 60_000, signal: controller.signal });
  const abortPids = await waitFor(async () => {
    try { return JSON.parse(await fsp.readFile(abortFile, 'utf8')); } catch { return undefined; }
  }, { timeoutMs: 10_000, label: '取消用例的 pid 文件' });
  controller.abort();
  await assert.rejects(aborted, { code: 'ABORTED' });
  await dead(abortPids.root, '取消后的根进程');
  await dead(abortPids.grandchild, '取消后的孙进程');

  // 2) 超时
  const timeoutFile = path.join(dir, 'timeout.json');
  const timedOut = runProcess(process.execPath, ['-e', script, timeoutFile], { timeoutMs: 1200 });
  const timeoutPids = await waitFor(async () => {
    try { return JSON.parse(await fsp.readFile(timeoutFile, 'utf8')); } catch { return undefined; }
  }, { timeoutMs: 10_000, label: '超时用例的 pid 文件' });
  await assert.rejects(timedOut, { code: 'TIMEOUT' });
  await dead(timeoutPids.root, '超时后的根进程');
  await dead(timeoutPids.grandchild, '超时后的孙进程');
});

test('killTree / terminateTree：三代进程树一次回收，且必须在根存活时枚举', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-tree-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'tree.json');
  const grandchildScript = 'setInterval(()=>{},1000);';
  const childScript = 'const {spawn}=require("node:child_process");const fs=require("node:fs");'
    + `const g=spawn(process.execPath,["-e",${JSON.stringify(grandchildScript)}],{stdio:"ignore",detached:false});`
    + 'fs.writeFileSync(process.argv[1],JSON.stringify({grandchild:g.pid}));setInterval(()=>{},1000);';
  const rootScript = 'const {spawn}=require("node:child_process");const fs=require("node:fs");'
    + `const c=spawn(process.execPath,["-e",${JSON.stringify(childScript)},process.argv[1]],{stdio:"ignore",detached:false});`
    + 'fs.writeFileSync(process.argv[2],JSON.stringify({child:c.pid}));setInterval(()=>{},1000);';

  const root = spawn(process.execPath, ['-e', rootScript, pidFile, path.join(dir, 'root.json')], {
    stdio: 'ignore',
    detached: process.platform !== 'win32', // 与生产一致：POSIX 自成进程组
  });
  t.after(() => { try { process.kill(root.pid, 'SIGKILL'); } catch { /* 已退出 */ } });
  const pids = await waitFor(async () => {
    try { return JSON.parse(await fsp.readFile(pidFile, 'utf8')); } catch { return undefined; }
  }, { timeoutMs: 10_000, label: '三代进程 pid' });
  const rootPids = JSON.parse(await fsp.readFile(path.join(dir, 'root.json'), 'utf8'));

  const killed = await killTree(root.pid, { force: true });
  assert.equal(killed.ok, true, `杀树必须成功：${JSON.stringify(killed)}`);
  await dead(rootPids.child, '根的子进程');
  await dead(pids.grandchild, '根的孙进程');

  // 根已经死了以后再想杀树：Windows 上必然定位不到后代 —— 这正是「必须先杀树」的原因，
  // 这里断言的是「不会再抛异常」，真实语义由上面的顺序保证。
  const again = await killTree(root.pid, { force: true });
  assert.equal(typeof again.ok, 'boolean');

  // terminateTree 的优雅路径必须能结束一个真实进程
  const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: process.platform !== 'win32' });
  const result = await terminateTree(victim.pid, { graceMs: 1500, isAlive: () => isAlive(victim.pid) });
  await dead(victim.pid, 'terminateTree 的目标进程');
  assert.equal(typeof result.method, 'string');
});

test('taskkill 参数与绝对路径（Windows 分支的可断言部分）', () => {
  assert.deepEqual(taskkillArgs(1234), ['/PID', '1234', '/T', '/F']);
  assert.deepEqual(taskkillArgs(1234, { force: false }), ['/PID', '1234', '/T']);
  assert.deepEqual(taskkillArgs(1234, { tree: false }), ['/PID', '1234', '/F']);
  assert.equal(taskkillPath({ SystemRoot: 'D:\\Windows' }, 'win32'), 'D:\\Windows\\System32\\taskkill.exe');
  assert.equal(taskkillPath({}, 'darwin'), undefined);
});

test('runProcess：stdout/stderr 必须被真正捕获（字节忠实，多字节字符跨 chunk 不损坏）', async () => {
  // 1) 基本捕获：漏挂 data 事件会让输出永远是空串（真踩过：op 报「没有协议结果(exit=0)」）
  const basic = await runProcess(process.execPath, ['-e', 'process.stdout.write("OUT\\n");process.stderr.write("ERR\\n")'], { timeoutMs: 10_000 });
  assert.equal(basic.exitCode, 0);
  assert.equal(basic.stdout, 'OUT\n');
  assert.equal(basic.stderr, 'ERR\n');

  // 2) 字节忠实：每次只写 1 个字节，强制把多字节 UTF-8 字符切在 chunk 边界上。
  //    旧实现每收到一个 chunk 就 String(chunk)，这里会解出成片的替换字符。
  const text = '中文输出测试：Godot MCP 🎮 #1';
  const script = 'const s=Buffer.from(process.argv[1],"utf8");for(const b of s){process.stdout.write(Buffer.from([b]));}';
  const split = await runProcess(process.execPath, ['-e', script, text], { timeoutMs: 15_000 });
  assert.equal(split.stdout, text, '逐字节写入时不能出现替换字符');
  assert.equal(split.truncated, false);
});

test('runProcess：signal 已 aborted 时必须在 spawn 之前拒绝（不产生任何副作用）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-preabort-'));
  const marker = path.join(dir, 'spawned.marker');
  try {
    const controller = new AbortController();
    controller.abort(); // 先取消，再调用
    const started = Date.now();
    await assert.rejects(
      runProcess(process.execPath, ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)},"x")`], {
        timeoutMs: 30_000,
        signal: controller.signal,
      }),
      error => error.code === 'ABORTED' && error.kill?.note === 'pre-aborted; no process spawned',
    );
    assert.ok(Date.now() - started < 2000, '前置取消必须立刻返回');
    // 给「万一真的起了进程」留出写文件的时间，再断言副作用不存在
    await delay(500);
    assert.equal(fs.existsSync(marker), false, '前置取消不能让子进程跑起来（连 marker 都不该出现）');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('runProcess：spawn 同步抛错时以错误 reject（不是未处理异常）', async () => {
  // command 传非法类型会让 spawn 同步抛 ERR_INVALID_ARG_TYPE
  await assert.rejects(
    runProcess(null, [], { timeoutMs: 5000 }),
    error => error instanceof TypeError || error?.code === 'ERR_INVALID_ARG_TYPE',
  );
  // 合法但不存在：走异步 'error'（ENOENT），同样必须 reject 而不是崩溃
  await assert.rejects(
    runProcess(path.join(os.tmpdir(), 'definitely-not-here-xyz'), [], { timeoutMs: 5000 }),
    error => error?.code === 'ENOENT',
  );
});

test('runProcess：maxBytes 按剩余字节严格截断，且不产生替换字符', async () => {
  const limit = 64;
  // 输出 200 个「中」字（每个 3 字节 = 600 字节），上限 64 字节 → 只能留 21 个完整字符（63 字节）
  const script = 'process.stdout.write("中".repeat(200))';
  const result = await runProcess(process.execPath, ['-e', script], { timeoutMs: 20_000, maxBytes: limit });
  assert.equal(result.truncated, true, '必须标记截断');
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= limit, `输出必须 <= ${limit} 字节，实际 ${Buffer.byteLength(result.stdout, 'utf8')}`);
  assert.equal(result.stdout.includes('\uFFFD'), false, '截断不能产生替换字符');
  assert.equal(result.stdout, '中'.repeat(21), '应当保留能被 64 字节容纳的完整字符');

  // 上限大于输出时不截断
  const small = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 10_000, maxBytes: limit });
  assert.equal(small.truncated, false);
  assert.equal(small.stdout, 'ok');
});

test('runProcess：取消后有界回收整棵树，且不留长计时器拖住事件循环', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-timer-'));
  const pidFile = path.join(dir, 'pids.json');
  const script = 'const {spawn}=require("node:child_process");const fs=require("node:fs");'
    + 'const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});'
    + 'fs.writeFileSync(process.argv[1],JSON.stringify({root:process.pid,grandchild:g.pid}));'
    + 'setInterval(()=>{},1000);';
  try {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ['-e', script, pidFile], { timeoutMs: 60_000, signal: controller.signal });
    const pids = await waitFor(async () => {
      try { return JSON.parse(await fsp.readFile(pidFile, 'utf8')); } catch { return undefined; }
    }, { timeoutMs: 10_000, label: 'pid 文件' });
    const abortAt = Date.now();
    controller.abort();
    const error = await pending.then(() => undefined, e => e);
    assert.equal(error.code, 'ABORTED');
    // 关键：reject 之前整棵树（快照）必须已经回收 —— 调用方可以立刻做下一步写操作
    await dead(pids.root, '取消后的根进程');
    await dead(pids.grandchild, '取消后的孙进程');
    assert.deepEqual(error.kill.survivors, [], `不应有幸存者：${JSON.stringify(error.kill)}`);
    assert.equal(error.kill.closed, true, '返回时必须已经观察到 close');
    assert.ok(error.kill.snapshot >= 2, `杀前快照必须包含后代：${JSON.stringify(error.kill)}`);
    // 计时器清理：取消后 1 秒内事件循环就该安静下来（这里用「整体耗时」间接验证）
    assert.ok(Date.now() - abortAt < 9000, '回收必须是有界的（不能等满 5s+ 的游离 timer）');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('runProcess：逐字节写入 + 在中文中间截断 —— 总字节 <= 上限且无替换字符', async () => {
  // 逐字节写入：每个 chunk 最多 1 字节 → 多字节字符必然跨 chunk（先跨 chunk 拼接，再在中间截断）
  const limit = 64;
  const text = '中'.repeat(30); // 90 字节
  const script = 'const s=Buffer.from(process.argv[1],"utf8");for(const b of s){process.stdout.write(Buffer.from([b]));}';
  const result = await runProcess(process.execPath, ['-e', script, text], { timeoutMs: 20_000, maxBytes: limit });
  const bytes = Buffer.byteLength(result.stdout, 'utf8');
  assert.equal(result.truncated, true);
  assert.ok(bytes <= limit, `输出必须 <= ${limit} 字节，实际 ${bytes}`);
  assert.equal(result.stdout.includes('\uFFFD'), false, '不能出现替换字符');
  assert.equal(result.stdout, '中'.repeat(21), '21 个完整汉字 = 63 字节，且第 22 个的半个字符要被丢弃');

  // 同一个进程里先写「半字符」再写「补齐它的字节」，且上限刚好落在字符边界之后：
  // 顺序正确时不应出现替换字符（这是「先 end() 再 write」会错的场景）
  const pair = await runProcess(process.execPath, ['-e', [
    'const b = Buffer.from("中文测试", "utf8");',
    'process.stdout.write(b.subarray(0, 4));', // 一个完整「中」+「文」的首字节
    'setTimeout(() => process.stdout.write(b.subarray(4)), 30);',
  ].join('')], { timeoutMs: 20_000, maxBytes: 1024 });
  assert.equal(pair.stdout, '中文测试');
  assert.equal(pair.truncated, false);
});

test('helper kill mode：按 pid 快照整树回收（含孙进程），并写入可判定的结果', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-killmode-'));
  try {
    const pidFile = path.join(dir, 'pids.json');
    const script = 'const {spawn}=require("node:child_process");const fs=require("node:fs");'
      + 'const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});'
      + 'fs.writeFileSync(process.argv[1],JSON.stringify({child:process.pid,grandchild:g.pid}));'
      + 'setInterval(()=>{},1000);';
    const root = spawn(process.execPath, ['-e', script, pidFile], { stdio: 'ignore' });
    const pids = await waitFor(async () => {
      try { return JSON.parse(await fsp.readFile(pidFile, 'utf8')); } catch { return undefined; }
    }, { timeoutMs: 10_000, label: 'kill mode 目标 pid 文件' });

    const requestPath = path.join(dir, 'kill.json');
    const resultPath = path.join(dir, 'kill-result.json');
    await fsp.writeFile(requestPath, JSON.stringify({ roots: [pids.child], timeoutMs: 6000, resultPath }));
    const killer = spawn(process.execPath, [HELPER, '--kill', requestPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exitCode = await new Promise(resolve => killer.once('close', resolve));
    const result = JSON.parse(await fsp.readFile(resultPath, 'utf8'));

    assert.equal(exitCode, 0, `kill mode 必须成功退出：${JSON.stringify(result)}`);
    assert.equal(result.ok, true);
    assert.deepEqual(result.survivors, []);
    assert.ok(result.snapshot >= 2, `快照必须包含孙进程：${JSON.stringify(result)}`);
    await dead(pids.child, 'kill mode 的子进程');
    await dead(pids.grandchild, 'kill mode 的孙进程');
    assert.equal(fs.existsSync(requestPath), false, 'kill 请求文件也要清理');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
