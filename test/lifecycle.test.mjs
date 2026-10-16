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
import { runProcess } from '../src/godot.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await delay(10);
  }
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
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'project.godot'), 'config_version=5\n');
  const binary = path.join(root, 'fake-godot');
  await fs.writeFile(binary, `#!${process.execPath}\nprocess.stdout.write('READY\\n');\nif (process.argv.includes('exit-now')) process.exit(0);\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const controller = new GodotController({ godotPath: binary, defaultProject: project });
  const dispose = async () => { await controller.shutdown(); };
  return { root, project, controller, dispose };
}

test('repeated recovery preserves the original override through final cleanup', async t => {
  const f = await fixture(t);
  const original = '[rendering]\nrenderer/rendering_method="gl_compatibility"\n';
  await fs.writeFile(path.join(f.project, 'override.cfg'), original);
  for (let n = 0; n < 3; n++) await injectTransientBridge(f.project);
  await restoreTransientBridge(f.project);
  assert.equal(await fs.readFile(path.join(f.project, 'override.cfg'), 'utf8'), original);
  assert.deepEqual(await pendingInjections(), []);
});

test('natural process exit cleans injection without an explicit stop', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  try {
    const child = await f.controller.processes.startGame({ project: f.project, godot: f.controller.config.godotPath, keepAwake: false, extraArgs: ['exit-now'] });
    if (child.running) await once(child, 'exit');
    await child.bridgeCleanup;
    assert.equal(existsSync(path.join(f.project, '.godot/mcp_bridge')), false);
    assert.deepEqual(await pendingInjections(), []);
  } finally { await f.dispose(); }
});

test('stop by kind waits for injection cleanup and restores user configuration', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const original = '[application]\nconfig/name="mine"\n';
  await fs.writeFile(path.join(f.project, 'override.cfg'), original);
  try {
    const result = await f.controller.session('game', { keepAwake: false });
    assert.equal(result.ok, true);
    await until(() => f.controller.processes.get(result.session.id).stdout.includes('READY'));
    const stopped = await f.controller.session('stop', { kind: 'game' });
    assert.equal(stopped.ok, true);
    assert.equal(await fs.readFile(path.join(f.project, 'override.cfg'), 'utf8'), original);
    assert.equal(existsSync(path.join(f.project, '.godot/mcp_bridge')), false);
    assert.deepEqual(await pendingInjections(), []);
  } finally { await f.dispose(); }
});

test('shared project injection survives until the last game or attach is released', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const original = '[application]\nconfig/name="shared"\n';
  await fs.writeFile(path.join(f.project, 'override.cfg'), original);
  try {
    const [a, b] = await Promise.all([
      f.controller.session('game', { keepAwake: false }),
      f.controller.session('game', { keepAwake: false }),
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

for (const target of ['editor', 'runtime']) {
  test(`${target} bridge cancellation closes an outstanding socket promptly`, async () => {
    let socket;
    let received = false;
    const server = net.createServer(peer => {
      socket = peer;
      peer.on('data', data => {
        if (target === 'editor' && data.toString().startsWith('GET ')) {
          peer.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        } else received = true;
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const abort = new AbortController();
    let result;
    const pending = new GodotController().bridge(target, target === 'editor' ? 'editor.execute' : 'rt.eval', {}, {
      port: server.address().port, signal: abort.signal, timeoutMs: 3000,
    }).then(value => { result = value; });
    try {
      await until(() => received);
      abort.abort();
      await until(() => result !== undefined);
      assert.equal(result.code, 'ABORTED');
      assert.equal(result.ok, false);
    } finally {
      socket?.destroy();
      await pending;
      await new Promise(resolve => server.close(resolve));
    }
  });
}

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
