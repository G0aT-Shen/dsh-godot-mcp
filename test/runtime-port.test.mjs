// 运行时端口来源、就绪探测与项目归属校验的回归。
//
// 背景（两个真实坑）：
//   1. `src/inject.mjs` 会把自定义端口写进 `.godot/mcp_bridge/port.cfg`，但运行时脚本
//      原来只读 `GODOT_MCP_RUNTIME_PORT` —— 写了不读，于是「自定义端口」永远不生效；
//   2. 游戏启动到监听端口之间有时间差，而且端口可能被别的进程或**另一个项目**的游戏占用。
//      把「第一次 connection refused」当成永久不兼容、或者直接连到别的项目上，
//      都会让上层拿到看似成功其实错误的连接。
//
// 这里用假 TCP 服务覆盖可判定的分支；真实 Godot 的端到端部分在 scripts/verify-l3.mjs。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeProjectPath, projectIdentity, waitForRuntime } from '../src/bridge.mjs';
import { injectTransientBridge } from '../src/inject.mjs';

const PROTOCOL = 'godot-mcp-runtime/1';

/** 起一个假的运行时桥（行分隔 JSON），返回 {port, close, requests}。 */
async function fakeRuntime({ project, protocol = PROTOCOL, reply = true, port = 0, startDelayMs = 0 } = {}) {
  const requests = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        requests.push(message);
        if (!reply) continue; // 占着端口但不按协议回话 = 外来服务
        socket.write(`${JSON.stringify({
          id: message.id,
          ok: true,
          data: { pong: true, nonce: message.params?.nonce, port: server.address().port, protocol, project, pid: 4321 },
        })}\n`);
      }
    });
  });
  if (startDelayMs > 0) await new Promise(resolve => setTimeout(resolve, startDelayMs));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.unref();
    }),
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('normalizeProjectPath：分隔符、末尾斜杠、Windows 大小写', () => {
  assert.equal(normalizeProjectPath('/a/b/', 'darwin'), '/a/b');
  assert.equal(normalizeProjectPath('C:\\DSH\\Proj\\', 'win32'), 'c:/dsh/proj');
  assert.equal(normalizeProjectPath('C:/DSH/Proj', 'win32'), 'c:/dsh/proj');
  assert.equal(normalizeProjectPath(undefined), '');
});

test('就绪探测：项目匹配时通过，并且确实发了带 nonce 的 rt.ping', async t => {
  const server = await fakeRuntime({ project: '/work/projA' });
  t.after(() => server.close());
  const ready = await waitForRuntime({ port: server.port, project: '/work/projA', timeoutMs: 3000 });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(ready.project, '/work/projA');
  assert.equal(ready.pid, 4321);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].op, 'rt.ping');
  assert.ok(server.requests[0].params.nonce, '必须带 nonce，防止把迟到的旧回包当成本次结果');
});

test('就绪探测：端口被另一个项目占用时明确报 PROJECT_MISMATCH，不装作成功', async t => {
  const server = await fakeRuntime({ project: '/work/projB' });
  t.after(() => server.close());
  const ready = await waitForRuntime({ port: server.port, project: '/work/projA', timeoutMs: 3000 });
  assert.equal(ready.ok, false);
  assert.equal(ready.code, 'PROJECT_MISMATCH');
  assert.equal(ready.project, '/work/projB');
  assert.match(ready.error, /另一个项目/);
});

test('就绪探测：还没起来的端口会重试，晚到的服务也能被等到', async t => {
  const port = await freePort();
  const server = await fakeRuntime({ project: '/work/projA', port, startDelayMs: 1200 });
  t.after(() => server.close());
  const ready = await waitForRuntime({ port, project: '/work/projA', timeoutMs: 6000, pollMs: 100 });
  assert.equal(ready.ok, true, JSON.stringify(ready));
});

test('就绪探测：一直没人监听 → RUNTIME_NOT_READY（而不是「不兼容」）', async () => {
  const port = await freePort();
  const ready = await waitForRuntime({ port, project: '/work/projA', timeoutMs: 800, pollMs: 100 });
  assert.equal(ready.ok, false);
  assert.equal(ready.code, 'RUNTIME_NOT_READY');
  assert.match(ready.error, /就绪超时/);
});

test('就绪探测：端口被外来服务占用（连得上但不按协议回话）→ PORT_OCCUPIED', async t => {
  const server = await fakeRuntime({ reply: false });
  t.after(() => server.close());
  const ready = await waitForRuntime({ port: server.port, project: '/work/projA', timeoutMs: 1200, pollMs: 100 });
  assert.equal(ready.ok, false);
  assert.equal(ready.code, 'PORT_OCCUPIED', JSON.stringify(ready));
});

test('就绪探测：协议不对（别的 MCP 服务占了端口）→ 不会误判为我们的桥', async t => {
  const server = await fakeRuntime({ project: '/work/projA', protocol: 'something-else/9' });
  t.after(() => server.close());
  const ready = await waitForRuntime({ port: server.port, project: '/work/projA', timeoutMs: 1000, pollMs: 100 });
  assert.equal(ready.ok, false);
  // 「端口上有东西但不是我们的桥」现在被更精确地判为 NOT_RUNTIME_BRIDGE；
  // PORT_OCCUPIED 保留给「连得上但一直不说话」的服务。
  assert.ok(['PORT_OCCUPIED', 'NOT_RUNTIME_BRIDGE'].includes(ready.code), JSON.stringify(ready));
});

test('custom port：注入时写下的 port.cfg 内容必须被运行时脚本读得到（文件契约）', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-portcfg-'));
  const previous = process.env.GODOT_MCP_STATE_DIR;
  process.env.GODOT_MCP_STATE_DIR = path.join(root, 'state');
  t.after(async () => {
    if (previous === undefined) delete process.env.GODOT_MCP_STATE_DIR;
    else process.env.GODOT_MCP_STATE_DIR = previous;
    await fsp.rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project');
  await fsp.mkdir(project);
  await fsp.writeFile(path.join(project, 'project.godot'), 'config_version=5\n');
  await injectTransientBridge(project, { port: 19099 });
  const portCfg = await fsp.readFile(path.join(project, '.godot', 'mcp_bridge', 'port.cfg'), 'utf8');
  assert.match(portCfg, /\[mcp\]/);
  assert.match(portCfg, /^port=19099$/m);
  // 运行时脚本读的就是这个键（ConfigFile: [mcp] port）
  const script = await fsp.readFile(path.join(process.cwd(), 'godot', 'runtime', 'godot_mcp_runtime.gd'), 'utf8');
  assert.match(script, /\.godot\/mcp_bridge/, '运行时脚本必须在 .godot/mcp_bridge 下找 port.cfg');
  assert.match(script, /get_value\("mcp", "port"/, '必须读 [mcp] port 这个键，和注入端写的一致');
});

test('就绪探测：期望项目但对面报不出身份 → PROJECT_UNVERIFIED（不当作匹配）', async t => {
  const server = await fakeRuntime({ project: undefined });
  t.after(() => server.close());
  const ready = await waitForRuntime({ port: server.port, project: '/work/projA', timeoutMs: 2000 });
  assert.equal(ready.ok, false);
  assert.equal(ready.code, 'PROJECT_UNVERIFIED', JSON.stringify(ready));
  assert.match(ready.error, /没有上报项目路径/);
});

test('就绪探测：取消立刻以 ABORTED 结束（不吞掉、不继续重试）', async () => {
  const port = await freePort();
  const controller = new AbortController();
  const started = Date.now();
  const pending = waitForRuntime({ port, project: '/work/projA', timeoutMs: 30_000, pollMs: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, error => error.code === 'ABORTED');
  assert.ok(Date.now() - started < 3000, 'abort 之后必须立刻回来，不能等满 pollMs/超时');
});

test('就绪探测：真并发启动的迟到服务也能等到（不是先等再连）', async t => {
  const port = await freePort();
  let server;
  const pending = waitForRuntime({ port, project: '/work/projA', timeoutMs: 8000, pollMs: 100 });
  await new Promise(resolve => setTimeout(resolve, 300));
  server = await fakeRuntime({ project: '/work/projA', port });
  t.after(() => server.close());
  const ready = await pending;
  assert.equal(ready.ok, true, JSON.stringify(ready));
});

test('项目身份：realpath 归一（macOS /var 与 /private/var 是同一目录）与 UNC 拒绝', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-identity-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const identity = projectIdentity(dir);
  assert.equal(identity.ok, true);
  if (process.platform === 'darwin') {
    // 临时目录在 /var/folders 下：realpath 之后应当是 /private/var/...
    assert.ok(identity.path.startsWith('/private/'), `macOS 上 realpath 应当解析到 /private：${identity.path}`);
    const short = projectIdentity(dir.replace(/^\/private/, ''));
    assert.equal(short.comparison, identity.comparison, '/var 与 /private/var 必须被判定为同一项目');
    assert.equal(identity.viaRealPath, true);
  }
  const unc = projectIdentity('\\\\build-server\\dsh tools\\project');
  assert.equal(unc.ok, false);
  assert.equal(unc.code, 'UNC_UNSUPPORTED');
  assert.equal(projectIdentity('').code, 'EMPTY_PROJECT');
});

test('godot_connect：显式 project 时 rt.ping 也必须校验归属（不能成为绕过检查的后门）', async t => {
  const { GodotController } = await import('../src/server.mjs');
  const server = await fakeRuntime({ project: '/work/projB' });
  t.after(() => server.close());
  const controller = new GodotController({ runtimePort: server.port });

  // 传了 project 就必须校验：rt.ping 也不例外
  const wrong = await controller.bridge('runtime', 'rt.ping', {}, { port: server.port, project: '/work/projA' });
  assert.equal(wrong.ok, false, 'rt.ping 不能绕过归属校验');
  assert.equal(wrong.code, 'PROJECT_MISMATCH');

  const right = await controller.bridge('runtime', 'rt.ping', {}, { port: server.port, project: '/work/projB' });
  assert.equal(right.ok, true);
  assert.equal(right.ownership.verified, true);
  assert.equal(right.ownership.remoteProject, '/work/projB');

  // 不传 project 且没有任何可解析目标时：允许纯探测，但必须**明确标注未校验**
  // （不能沉默地当作「已验证」，也不能直接拒绝一个只读探测）
  const plain = await controller.bridge('runtime', 'rt.ping', {}, { port: server.port, readyTimeoutMs: 0 });
  assert.equal(plain.ok, true);
  assert.equal(plain.ownership.verified, false);
  assert.equal(plain.ownership.reason, 'PROJECT_UNSPECIFIED');
});

test('godot_connect：显式 project 时 pid 不匹配要拒绝（PID_MISMATCH）', async t => {
  const { GodotController } = await import('../src/server.mjs');
  const server = await fakeRuntime({ project: '/work/projA' });
  t.after(() => server.close());
  const controller = new GodotController({ runtimePort: server.port });
  // 期望 pid = 9999999（假的），远端报 4321 → 必须拒绝，绝不把命令发给别的实例
  const wrong = await controller.bridge('runtime', 'rt.eval', {}, {
    port: server.port,
    project: '/work/projA',
    readyTimeoutMs: 2000,
    expectedPid: 9999999,
  });
  assert.equal(wrong.ok, false, JSON.stringify(wrong));
  assert.equal(wrong.code, 'PID_MISMATCH');
  assert.match(String(wrong.error), /pid=/);
});

test('godot_connect：身份校验与真正的 op 走同一条连接（TOCTOU 关闭 + 不冒充验证）', async t => {
  const { GodotController } = await import('../src/server.mjs');
  const connections = [];
  let socketId = 0;
  const server = net.createServer(peer => {
    const id = ++socketId;
    connections.push({ id, ops: [] });
    let buffer = '';
    peer.on('data', data => {
      buffer += String(data);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        connections.find(entry => entry.id === id).ops.push(message.op);
        peer.write(`${JSON.stringify({
          id: message.id,
          ok: true,
          data: message.op === 'rt.ping'
            ? { pong: true, nonce: message.params?.nonce, port: server.address().port, protocol: 'godot-mcp-runtime/1', project: '/work/projA', pid: 4321 }
            : { echoed: message.op },
        })}\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(() => resolve()); }));

  const controller = new GodotController({ runtimePort: server.address().port });
  const result = await controller.bridge('runtime', 'rt.get_property', { node_path: '/root' }, {
    port: server.address().port,
    project: '/work/projA',
    readyTimeoutMs: 2000,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ownership.verified, true);
  // 执行 op 的那条连接上，第一条必须是身份校验的 rt.ping，第二条才是真正的 op
  const opConnection = connections.find(entry => entry.ops.includes('rt.get_property'));
  assert.ok(opConnection, '必须有一条连接执行了真正的 op');
  const pingAt = opConnection.ops.indexOf('rt.ping');
  const opAt = opConnection.ops.indexOf('rt.get_property');
  assert.ok(pingAt >= 0 && pingAt < opAt, `同一连接上必须先校验再执行：${JSON.stringify(opConnection.ops)}`);
});

test('godot_connect：多个游戏会话且未指定 project → AMBIGUOUS_PROJECT（不静默挑一个）', async () => {
  const { GodotController } = await import('../src/server.mjs');
  const controller = new GodotController();
  // 直接伪造两个「在跑的游戏会话」
  const fake = project => ({
    id: `game-${project}`, kind: 'game', running: true, projectPath: project,
    toJSON: () => ({ id: `game-${project}`, kind: 'game', running: true, projectPath: project }),
  });
  controller.processes.processes.set('a', fake('/work/one'));
  controller.processes.processes.set('b', fake('/work/two'));
  const result = await controller.bridge('runtime', 'rt.get_property', {}, { port: 65000, readyTimeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AMBIGUOUS_PROJECT');
  assert.match(String(result.error), /多个游戏会话/);
});

test('godot_connect：没有任何可解析目标时，写类 op 拒绝（PROJECT_UNSPECIFIED），纯探测才放行', async () => {
  const { GodotController } = await import('../src/server.mjs');
  const controller = new GodotController({ cwd: os.tmpdir() });
  const write = await controller.bridge('runtime', 'rt.set_property', {}, { port: 65001, readyTimeoutMs: 500 });
  assert.equal(write.ok, false);
  assert.equal(write.code, 'PROJECT_UNSPECIFIED');
});
