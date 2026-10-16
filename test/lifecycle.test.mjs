import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import net from 'node:net';
import { GodotController } from '../src/server.mjs';
import { injectTransientBridge, restoreTransientBridge, pendingInjections } from '../src/inject.mjs';
import { startMcpServer } from '../src/mcp-stdio.mjs';
import { godotPath, runProcess } from '../src/godot.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `condition did not become true within ${timeoutMs}ms`);
    await delay(25);
  }
}

/**
 * 真实 Godot 夹具项目。
 *
 * 为什么不再用「带 shebang 的假引擎」：Windows 既不认 `#!` 也没有可执行位，
 * 旧夹具只能在 POSIX 上跑，于是三个关键生命周期用例在 win32 上被**静默跳过** ——
 * 而「自然退出、按 kind 停止、同项目共享注入」恰恰是最需要在 Windows 上验证的部分。
 * 现在改用真实 Godot + 一个最小项目：`--headless` 原生可跑，且用 `exit-now`
 * 参数控制自然退出，语义与旧夹具一致。
 */
function fixtureProject(root) {
  return { project: path.join(root, 'project'), binary: undefined };
}

async function writeFixtureProject(project) {
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'project.godot'), [
    'config_version=5',
    '',
    '[application]',
    'config/name="mcp-lifecycle-fixture"',
    'run/main_scene="res://main.tscn"',
    '',
  ].join('\n'));
  // 用 `--` 之后的**用户参数**（OS.get_cmdline_user_args）而不是普通引擎参数：
  // 把自定义参数直接塞进引擎参数列表，Godot 会当成未知引擎参数并报错退出 ——
  // 那样「自然退出」其实是被参数错误打死的，测试就变成了假通过。
  await fs.writeFile(path.join(project, 'main.gd'), [
    'extends Node',
    '',
    'func _ready() -> void:',
    '\tprint("READY")',
    '\tfor argument in OS.get_cmdline_user_args():',
    '\t\tif argument == "exit-now":',
    '\t\t\tget_tree().quit(0)',
    '\t\t\treturn',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(project, 'main.tscn'), [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="res://main.gd" id="1"]',
    '',
    '[node name="Main" type="Node"]',
    'script = ExtResource("1")',
    '',
  ].join('\n'));
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmcp-lifecycle-'));
  const previous = process.env.GODOT_MCP_STATE_DIR;
  process.env.GODOT_MCP_STATE_DIR = path.join(root, 'state');
  t.after(async () => {
    if (previous === undefined) delete process.env.GODOT_MCP_STATE_DIR;
    else process.env.GODOT_MCP_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project');
  await writeFixtureProject(project);
  const controller = new GodotController({ godotPath: requireRealGodot(), defaultProject: project });
  const dispose = async () => { await controller.shutdown(); };
  return { root, project, controller, dispose };
}

/**
 * 真实 Godot 是本组用例的前置条件。没有就明确跳过（而不是静默通过），
 * 并且在 CI 里用 GODOT_MCP_REQUIRE_GODOT=1 把跳过升级为失败 —— 关键生命周期用例
 * 不允许在 CI 上悄悄消失。
 */
function requireRealGodot() {
  const binary = godotPath();
  if (binary) return binary;
  if (process.env.GODOT_MCP_REQUIRE_GODOT === '1') {
    assert.fail('CI 要求真实 Godot（GODOT_MCP_REQUIRE_GODOT=1），但没有找到可执行文件');
  }
  return undefined;
}

const REAL_GODOT_SKIP = process.env.GODOT_MCP_REQUIRE_GODOT === '1' || godotPath() ? false : 'no real Godot available';
const REAL_SKIP_NOTE = '没有可用的 Godot 可执行文件（设置 GODOT_MCP_GODOT 或把 Godot 放进 PATH）';

test('repeated recovery preserves the original override through final cleanup', async t => {
  const f = await fixture(t);
  const original = '[rendering]\nrenderer/rendering_method="gl_compatibility"\n';
  await fs.writeFile(path.join(f.project, 'override.cfg'), original);
  for (let n = 0; n < 3; n++) await injectTransientBridge(f.project);
  await restoreTransientBridge(f.project);
  assert.equal(await fs.readFile(path.join(f.project, 'override.cfg'), 'utf8'), original);
  assert.deepEqual(await pendingInjections(), []);
});

test('natural process exit cleans injection without an explicit stop', { skip: REAL_GODOT_SKIP && REAL_SKIP_NOTE }, async t => {
  const f = await fixture(t);
  try {
    const child = await f.controller.processes.startGame({
      project: f.project,
      godot: f.controller.config.godotPath,
      keepAwake: false,
      headless: true,
      extraArgs: ['--', 'exit-now'],
    });
    // 先确认游戏真的起来了（READY），再等它自己退出，并且退出码必须是 0 ——
    // 「参数报错被打死」也会退出，那不是自然退出。
    await until(() => child.stdout.includes('READY'), 60_000);
    if (child.running) await once(child, 'exit');
    assert.equal(child.exitCode, 0, `自然退出必须是 0，实际 ${child.exitCode}；stderr=${child.stderr.slice(-400)}`);
    await child.bridgeCleanup;
    assert.equal(existsSync(path.join(f.project, '.godot/mcp_bridge')), false);
    assert.deepEqual(await pendingInjections(), []);
  } finally { await f.dispose(); }
});

test('stop by kind waits for injection cleanup and restores user configuration', { skip: REAL_GODOT_SKIP && REAL_SKIP_NOTE }, async t => {
  const f = await fixture(t);
  const original = '[application]\nconfig/name="mine"\n';
  await fs.writeFile(path.join(f.project, 'override.cfg'), original);
  try {
    const result = await f.controller.session('game', { keepAwake: false, headless: true });
    assert.equal(result.ok, true);
    await until(() => f.controller.processes.get(result.session.id).stdout.includes('READY'), 60_000);
    const stopped = await f.controller.session('stop', { kind: 'game' });
    assert.equal(stopped.ok, true);
    assert.equal(await fs.readFile(path.join(f.project, 'override.cfg'), 'utf8'), original);
    assert.equal(existsSync(path.join(f.project, '.godot/mcp_bridge')), false);
    assert.deepEqual(await pendingInjections(), []);
  } finally { await f.dispose(); }
});

test('shared project injection survives until the last game or attach is released', { skip: REAL_GODOT_SKIP && REAL_SKIP_NOTE }, async t => {
  const f = await fixture(t);
  const original = '[application]\nconfig/name="shared"\n';
  await fs.writeFile(path.join(f.project, 'override.cfg'), original);
  try {
    const [a, b] = await Promise.all([
      f.controller.session('game', { keepAwake: false, headless: true }),
      f.controller.session('game', { keepAwake: false, headless: true }),
    ]);
    assert.equal(a.ok && b.ok, true);
    const attached = await f.controller.session('attach', {});
    assert.equal(attached.ok, true);
    await f.controller.session('stop', { id: a.session.id });
    assert.match(await fs.readFile(path.join(f.project, 'override.cfg'), 'utf8'), /McpRuntime=/);
    await f.controller.session('stop', { id: b.session.id });
    assert.equal(existsSync(path.join(f.project, '.godot/mcp_bridge')), true);
    await f.controller.session('detach', { id: attached.id });
    assert.equal(await fs.readFile(path.join(f.project, 'override.cfg'), 'utf8'), original);
    assert.deepEqual(await pendingInjections(), []);
  } finally { await f.dispose(); }
});

test('parallel cleanup of different projects does not lose persistent state updates', async t => {
  const f = await fixture(t);
  const projects = [f.project, path.join(f.root, 'other')];
  await fs.mkdir(projects[1]);
  await fs.writeFile(path.join(projects[1], 'project.godot'), 'config_version=5\n');
  await Promise.all(projects.map(p => injectTransientBridge(p)));
  assert.equal((await pendingInjections()).length, 2);
  await Promise.all(projects.map(p => restoreTransientBridge(p)));
  assert.deepEqual(await pendingInjections(), []);
});

function transport(controller) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, nl)));
      buffer = buffer.slice(nl + 1);
    }
  });
  const finished = startMcpServer({ input, output, controller });
  return { input, messages, finished, send: message => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') };
}
const call = (id, op) => ({ id, method: 'tools/call', params: { name: 'godot', arguments: { op } } });

test('stdio serves ping while a tool runs and cancellation aborts its child process', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmcp-cancel-'));
  let signal;
  let childPromise;
  const pidFile = path.join(root, 'pid');
  const tr = transport({
    async op(op, params, options) {
      signal = options.signal;
      childPromise = runProcess(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)', pidFile], { signal, timeoutMs: 3000 });
      try { await childPromise; return { ok: true }; }
      catch (error) { return { ok: false, code: error.code }; }
    },
    async shutdown() {},
  });
  try {
    tr.send(call(1, 'slow'));
    await until(() => existsSync(pidFile));
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    tr.send({ id: 2, method: 'ping' });
    await until(() => tr.messages.some(m => m.id === 2));
    assert.ok(signal instanceof AbortSignal);
    tr.send({ method: 'notifications/cancelled', params: { requestId: 1, reason: 'user cancelled' } });
    await until(() => signal.aborted);
    await assert.rejects(childPromise, { code: 'ABORTED' });
    await until(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
    assert.equal(tr.messages.some(m => m.id === 1), false, 'cancelled request must not send a success response');
  } finally {
    tr.input.end();
    await tr.finished;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('queued tools stay serial and a cancelled queued write never executes', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const tr = transport({ async op(op) { started.push(op); if (op === 'first') await gate; return { ok: true }; }, async probe() { return { ok: true }; }, async shutdown() {} });
  try {
    tr.send(call(1, 'first'));
    tr.send(call(2, 'must-not-write'));
    tr.send(call(3, 'third'));
    await until(() => started.length > 0);
    tr.send({ method: 'notifications/cancelled', params: { requestId: 2 } });
    tr.send({ id: 4, method: 'ping' });
    tr.send({ id: 5, method: 'tools/call', params: { name: 'godot_status', arguments: {} } });
    await until(() => tr.messages.some(m => m.id === 4));
    await until(() => tr.messages.some(m => m.id === 5));
    assert.deepEqual(started, ['first']);
    release();
    await until(() => tr.messages.some(m => m.id === 3));
    assert.deepEqual(started, ['first', 'third']);
    assert.equal(tr.messages.some(m => m.id === 2), false);
  } finally { release(); tr.input.end(); await tr.finished; }
});

test('editor bridge cancellation closes an outstanding socket promptly', async () => {
  let socket;
  let received = false;
  const server = net.createServer(peer => {
    socket = peer;
    peer.on('data', data => {
      if (data.toString().startsWith('GET ')) {
        peer.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      } else received = true;
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const abort = new AbortController();
  let result;
  const pending = new GodotController().bridge('editor', 'editor.execute', {}, {
    port: server.address().port, signal: abort.signal, timeoutMs: 3000,
  }).then(value => { result = value; });
  try {
    await until(() => received);
    abort.abort();
    await until(() => result !== undefined, 15_000);
    assert.equal(result.code, 'ABORTED');
    assert.equal(result.ok, false);
  } finally {
    socket?.destroy();
    await pending;
    await new Promise(resolve => server.close(resolve));
  }
});

test('runtime bridge cancellation closes an outstanding socket promptly', async () => {
  // 运行时的取消路径现在包含「同连接身份校验」：先应答 rt.ping，再对真正的 op 保持沉默，
  // 这样才是在验证「挂住的 op 被取消后立刻断开」，而不是在校验阶段就失败。
  let socket;
  let received = false;
  let projectPath;
  const server = net.createServer(peer => {
    socket = peer;
    let buffer = '';
    peer.on('data', data => {
      buffer += String(data);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.op === 'rt.ping') {
          peer.write(`${JSON.stringify({
            id: message.id,
            ok: true,
            data: {
              pong: true,
              nonce: message.params.nonce,
              port: server.address().port,
              protocol: 'godot-mcp-runtime/1',
              project: projectPath,
              pid: process.pid,
            },
          })}\n`);
        } else {
          received = true; // 真正的 op：不回，制造「挂住」
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'gmcp-bridge-cancel-'));
  projectPath = fixture;
  const abort = new AbortController();
  let result;
  const pending = new GodotController().bridge('runtime', 'rt.eval', {}, {
    port: server.address().port,
    project: fixture,
    readyTimeoutMs: 3000,
    signal: abort.signal,
    timeoutMs: 3000,
  }).then(value => { result = value; });
  try {
    await until(() => received, 15_000);
    abort.abort();
    await until(() => result !== undefined, 15_000);
    assert.equal(result.code, 'ABORTED');
    assert.equal(result.ok, false);
  } finally {
    socket?.destroy();
    await pending;
    await new Promise(resolve => server.close(resolve));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('EOF aborts pending tools before shutting down the controller', async () => {
  let entered = false;
  let observedAbort = false;
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const tr = transport({
    async op(op, params, { signal }) {
      entered = true;
      signal?.addEventListener('abort', () => { observedAbort = true; finish(); }, { once: true });
      await gate;
      return { ok: true };
    },
    async shutdown() { assert.equal(observedAbort, true); },
  });
  try {
    tr.send(call(1, 'slow'));
    await until(() => entered);
    tr.input.end();
    await until(() => observedAbort);
  } finally { finish(); tr.input.end(); await tr.finished; }
});
