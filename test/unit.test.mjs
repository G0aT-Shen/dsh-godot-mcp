// Node 侧单元测试 + WebSocket 客户端真机往返测试。
// 运行：node --test test/
//
// 重点保护：
//   1. godot.mjs 的纯函数（项目解析、协议结果提取）—— 上游 ops.gd 依赖它们；
//   2. bridge.mjs 的 WebSocket 客户端 —— 它是 L2 编辑器桥的唯一通路，
//      手写帧编解码最容易出错，所以用真实 WebSocket 服务端做往返验证；
//   3. 工具定义的结构契约 —— DSH 注册要求 parameters/output 字段存在。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractResult, resolveProject, findProjectRoot, RESULT_MARKER } from '../src/godot.mjs';
import { GodotController, buildToolDefinitions } from '../src/server.mjs';
import { renderValue } from '../src/tools.mjs';
import { connectWebSocket, callRuntime, probePort, bridgeTimeoutFor } from '../src/bridge.mjs';
import { BUILD_INPUTS, LOADED_BUILD, buildStatus, computeBuildId } from '../src/build.mjs';
import { SERVER_INFO, handleMessage } from '../src/mcp-stdio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures');

// ---------------------------------------------------------------- extractResult

test('extractResult 只认协议标记行，并忽略 Godot 自身日志', () => {
  const stdout = [
    'Godot Engine v4.7.2.stable.official - https://godotengine.org',
    'some noise',
    `${RESULT_MARKER}{"ok":true,"data":{"a":1}}`,
    'trailing log',
  ].join('\n');
  assert.deepEqual(extractResult(stdout), { ok: true, data: { a: 1 } });
});

test('extractResult 取最后一个结果行（脚本可能输出多条）', () => {
  const stdout = `${RESULT_MARKER}{"ok":true,"n":1}\n${RESULT_MARKER}{"ok":true,"n":2}\n`;
  assert.deepEqual(extractResult(stdout), { ok: true, n: 2 });
});

test('extractResult 对无标记输出返回 undefined，对坏 JSON 返回 ok:false', () => {
  assert.equal(extractResult('just log lines'), undefined);
  assert.deepEqual(extractResult(`${RESULT_MARKER}{not json`), {
    ok: false,
    error: `无法解析协议结果：{not json`,
  });
});

test('extractResult 容忍标记前有前缀文本（同一行）', () => {
  assert.deepEqual(extractResult(`[INFO] x ${RESULT_MARKER}{"ok":true}`), { ok: true });
});

test('extractScriptError 能从 Godot 输出里抽出 GDScript 根因', async () => {
  const { extractScriptError } = await import('../src/operations.mjs');
  const raw = [
    'Godot Engine v4.7.2.stable.official - https://godotengine.org',
    '',
    "SCRIPT ERROR: Invalid operands 'String' and 'Object' in operator '=='.",
    '          at: _op_write_settings (/path/ops.gd:1230)',
  ].join('\n');
  assert.equal(extractScriptError(raw), "SCRIPT ERROR: Invalid operands 'String' and 'Object' in operator '=='.");
  assert.equal(extractScriptError('no errors here'), undefined);
  assert.equal(extractScriptError(''), undefined);
  assert.equal(extractScriptError(undefined), undefined);
});

test('extractScriptError 也能抓 Parse Error', async () => {
  const { extractScriptError } = await import('../src/operations.mjs');
  assert.equal(
    extractScriptError('Parse Error: The variable type is being inferred from a Variant value.'),
    'Parse Error: The variable type is being inferred from a Variant value.',
  );
});

// ---------------------------------------------------------------- project 解析

test('resolveProject 显式路径优先', async () => {
  const resolved = await resolveProject({ project: FIXTURE });
  assert.equal(resolved, FIXTURE);
});

test('resolveProject 从子目录向上找到 project.godot', async () => {
  const nested = path.join(FIXTURE, 'deep', 'nested');
  const resolved = await resolveProject({ cwd: nested });
  assert.equal(resolved, FIXTURE);
});

test('resolveProject 找不到项目时抛 PROJECT_NOT_FOUND', async () => {
  await assert.rejects(() => resolveProject({ cwd: '/tmp' }), error => {
    assert.equal(error.code, 'PROJECT_NOT_FOUND');
    return true;
  });
});

test('findProjectRoot 在根目录停止而不是死循环', async () => {
  assert.equal(await findProjectRoot('/'), undefined);
});

// ---------------------------------------------------------------- 工具结构契约

test('工具定义满足 DSH 注册契约：name/description/parameters + handler', () => {
  const controller = new GodotController({});
  const tools = buildToolDefinitions(controller);
  assert.equal(tools.length, 5);
  const names = tools.map(tool => tool.name);
  assert.deepEqual(names, ['godot', 'godot_batch', 'godot_session', 'godot_connect', 'godot_status']);
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.description.length > 20, `${tool.name} 描述过短`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.handler, 'function');
    // DSH 的 register() 需要 parameters/inputSchema 是合法 JSON Schema 对象
    assert.equal(typeof tool.inputSchema.properties, 'object');
  }
});

test('工具名满足 DeepSeek 函数名约束（≤64 字符、[A-Za-z0-9_-]）', () => {
  for (const tool of buildToolDefinitions(new GodotController({}))) {
    assert.ok(tool.name.length <= 64);
    assert.match(tool.name, /^[A-Za-z0-9_-]+$/);
  }
});

test('renderValue 输出 text content block', () => {
  assert.deepEqual(renderValue({ a: 1 }), [{ type: 'text', text: '{\n  "a": 1\n}' }]);
});

// ---------------------------------------------------------------- 批量与错误归一化

test('batch 缺少 op 时返回 BAD_STEP 且不调用引擎', async () => {
  const controller = new GodotController({});
  const result = await controller.batch([{ foo: 1 }]);
  assert.equal(result.ok, false);
  assert.equal(result.steps[0].code, 'BAD_STEP');
});

test('batch 空数组被拒绝', async () => {
  const result = await new GodotController({}).batch([]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_STEPS');
});

test('cleanJson 递归剔除 undefined（DSH 要求 lossless JSON）', async () => {
  const { cleanJson } = await import('../src/server.mjs');
  const messy = {
    ok: true,
    a: undefined,
    nested: { b: undefined, c: 1, deep: [{ d: undefined, e: 'x' }] },
    list: [1, undefined, { f: undefined }],
  };
  const cleaned = cleanJson(messy);
  assert.deepEqual(cleaned, { ok: true, nested: { c: 1, deep: [{ e: 'x' }] }, list: [1, null, {}] });
  // 数组里的 undefined 被规范化为 null（与 JSON.stringify 行为一致）
  assert.deepEqual(cleanJson([1, undefined, 2]), [1, null, 2]);
  // 关键性质：清洗后可以无损走一遍 JSON 往返
  assert.deepEqual(JSON.parse(JSON.stringify(cleaned)), cleaned);
});

test('session(list) 的输出不含 undefined，可安全 JSON 往返', async () => {
  const controller = new GodotController({});
  const result = await controller.session('list');
  assert.equal(result.ok, true);
  // 模拟 DSH 的 lossless JSON 校验：序列化后必须与原值完全一致
  const roundTrip = JSON.parse(JSON.stringify(result));
  assert.deepEqual(roundTrip, result);
});

test('session 未知 action 返回结构化错误而非抛异常', async () => {
  const result = await new GodotController({}).session('nope');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_ACTION');
});

test('godot_connect 未知 target 被拒绝', async () => {
  const result = await new GodotController({}).bridge('bogus', 'x');
  assert.equal(result.ok, false);
  assert.match(result.error, /未知的桥目标/);
});

test('找不到 Godot 时 op 返回结构化 GODOT_NOT_FOUND 而不是崩溃', async () => {
  const controller = new GodotController({ godotPath: '/nonexistent/godot', defaultProject: FIXTURE });
  const result = await controller.op('version');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GODOT_NOT_FOUND');
});

// ---------------------------------------------------------------- WebSocket 往返

/** 一个极小的 WebSocket 服务端，用来验证客户端的握手与帧编解码。 */
function startEchoWebSocketServer() {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString('latin1');
        const key = /Sec-WebSocket-Key: (.+)/i.exec(head)?.[1]?.trim();
        const accept = crypto
          .createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
            `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        upgraded = true;
        buffer = buffer.subarray(end + 4);
      }
      // 解码客户端文本帧（客户端必须掩码）
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        let mask;
        if (masked) {
          if (buffer.length < offset + 4) return;
          mask = buffer.subarray(offset, offset + 4);
          offset += 4;
        }
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buffer = buffer.subarray(offset + length);
        if (opcode !== 0x1) continue;
        // 回显：把收到的 JSON 原样包一层
        const received = JSON.parse(payload.toString('utf8'));
        const replyText = `${JSON.stringify({ id: received.id, ok: true, data: { echoed: received.op } })}\n`;
        const data = Buffer.from(replyText, 'utf8');
        const header = Buffer.alloc(data.length < 126 ? 2 : 4);
        header[0] = 0x81;
        if (data.length < 126) header[1] = data.length;
        else {
          header[1] = 126;
          header.writeUInt16BE(data.length, 2);
        }
        socket.write(Buffer.concat([header, data]));
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('WebSocket 客户端能完成握手、发送文本帧并读回响应', async () => {
  const { server, port } = await startEchoWebSocketServer();
  try {
    const ws = await connectWebSocket({ port, timeoutMs: 5000 });
    ws.send(`${JSON.stringify({ id: 'abc', op: 'editor.info', params: {} })}\n`);
    const raw = await ws.receive(5000);
    const message = JSON.parse(raw.trim());
    assert.equal(message.id, 'abc');
    assert.equal(message.ok, true);
    assert.equal(message.data.echoed, 'editor.info');
    ws.destroy();
  } finally {
    server.close();
  }
});

test('WebSocket 客户端对大响应（>65535 字节）也能正确解码', async () => {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const key = /Sec-WebSocket-Key: (.+)/i.exec(buffer.subarray(0, end).toString('latin1'))?.[1]?.trim();
        const accept = crypto
          .createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
            `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        upgraded = true;
        buffer = Buffer.alloc(0);
        // 主动推一条 70000 字节的文本帧（触发 64 位长度分支）
        const payload = Buffer.from(`${JSON.stringify({ id: 'big', ok: true, data: { pad: 'x'.repeat(70000) } })}\n`, 'utf8');
        const header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
        socket.write(Buffer.concat([header, payload]));
      }
    });
    socket.on('error', () => {});
  });
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    const ws = await connectWebSocket({ port, timeoutMs: 5000 });
    const raw = await ws.receive(5000);
    const message = JSON.parse(raw.trim());
    assert.equal(message.id, 'big');
    assert.equal(message.data.pad.length, 70000);
    ws.destroy();
  } finally {
    server.close();
  }
});

test('WebSocket 客户端连不上时在超时内报明确错误', async () => {
  await assert.rejects(
    () => connectWebSocket({ port: 1, timeoutMs: 1000 }),
    error => {
      assert.match(String(error.message), /连接编辑器桥/);
      return true;
    },
  );
});

test('probePort 对未监听端口返回 false，对监听端口返回 true', async () => {
  const server = net.createServer(() => {});
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    assert.equal(await probePort({ port }), true);
    assert.equal(await probePort({ port: 1, timeoutMs: 500 }), false);
  } finally {
    server.close();
  }
});

test('callRuntime 在端口无人监听时返回带上下文的错误', async () => {
  await assert.rejects(
    () => callRuntime('rt.info', {}, { port: 1, timeoutMs: 800 }),
    error => {
      assert.match(String(error.message), /连接运行时桥/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- 桥超时预算

test('bridgeTimeoutFor：慢 op 拿到更宽的默认预算，显式值永远优先', () => {
  assert.equal(bridgeTimeoutFor('rt.info', undefined), 15_000);
  assert.equal(bridgeTimeoutFor('rt.eval', undefined), 30_000);
  assert.equal(bridgeTimeoutFor('rt.screenshot', undefined), 20_000);
  assert.equal(bridgeTimeoutFor('editor.execute', undefined), 30_000);
  assert.equal(bridgeTimeoutFor('rt.eval', 5_000), 5_000);
  // 非法显式值退回默认，而不是变成 0 或 NaN 让请求立刻超时
  assert.equal(bridgeTimeoutFor('rt.eval', 0), 30_000);
  assert.equal(bridgeTimeoutFor('rt.eval', -1), 30_000);
});

test('桥超时的报错必须给出补救办法，而不是只说「超时了」', async () => {
  // 起一个只接受连接、永不回包的 TCP 服务端，模拟「桥在，但这条请求没回来」
  const server = net.createServer(socket => socket.on('data', () => {}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      () => callRuntime('rt.eval', {}, { port, timeoutMs: 400 }),
      error => {
        assert.equal(error.code, 'BRIDGE_TIMEOUT');
        assert.match(error.message, /rt\.eval/);
        assert.match(error.message, /timeoutMs/); // 客户端侧怎么加大
        assert.match(error.message, /params\.timeout_ms/); // 脚本侧还有自己的预算
        assert.match(error.message, /frame_post_draw/); // 最经典的挂起源
        return true;
      },
    );
    // 非 eval 的 op 不该提 params.timeout_ms，避免误导
    await assert.rejects(
      () => callRuntime('rt.info', {}, { port, timeoutMs: 400 }),
      error => {
        assert.equal(error.code, 'BRIDGE_TIMEOUT');
        assert.doesNotMatch(error.message, /params\.timeout_ms/);
        return true;
      },
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// ---------------------------------------------------------------- project.godot 改写

test('upsertIniSetting 在节存在时替换同键，不产生重复键', async () => {
  const { upsertIniSetting } = await import('../src/install.mjs');
  const input = '[autoload]\n\nFoo="*res://foo.gd"\n\n[display]\n\nwindow/size/viewport_width=800\n';
  const once = upsertIniSetting(input, 'autoload', 'McpRuntime', '"*res://addons/godot_mcp_bridge/runtime/godot_mcp_runtime.gd"');
  assert.match(once, /McpRuntime="\*res:\/\/addons\/godot_mcp_bridge\/runtime\/godot_mcp_runtime\.gd"/);
  assert.match(once, /Foo="\*res:\/\/foo\.gd"/); // 原有键保留
  assert.match(once, /\[display\]/); // 后续节未被破坏
  // 幂等：再写一次不新增行
  const twice = upsertIniSetting(once, 'autoload', 'McpRuntime', '"*res://addons/godot_mcp_bridge/runtime/godot_mcp_runtime.gd"');
  assert.equal(twice, once);
  assert.equal(twice.split('\n').filter(line => line.startsWith('McpRuntime=')).length, 1);
});

test('upsertIniSetting 在节不存在时追加新节', async () => {
  const { upsertIniSetting } = await import('../src/install.mjs');
  const input = '[application]\n\nconfig/name="X"\n';
  const out = upsertIniSetting(input, 'editor_plugins', 'enabled', 'PackedStringArray("res://addons/godot_mcp_bridge/plugin.cfg")');
  assert.match(out, /\[editor_plugins\]/);
  assert.match(out, /enabled=PackedStringArray\("res:\/\/addons\/godot_mcp_bridge\/plugin\.cfg"\)/);
  assert.match(out, /config\/name="X"/);
});

test('upsertIniSetting 能把插件并入已有 enabled 数组且不重复', async () => {
  const { upsertIniSetting } = await import('../src/install.mjs');
  const input =
    '[editor_plugins]\n\nenabled=PackedStringArray("res://addons/other/plugin.cfg")\n';
  const once = upsertIniSetting(input, 'editor_plugins', 'enabled', 'IGNORED', {
    arrayAppendValue: 'res://addons/godot_mcp_bridge/plugin.cfg',
  });
  assert.match(once, /res:\/\/addons\/other\/plugin\.cfg/);
  assert.match(once, /res:\/\/addons\/godot_mcp_bridge\/plugin\.cfg/);
  const twice = upsertIniSetting(once, 'editor_plugins', 'enabled', 'IGNORED', {
    arrayAppendValue: 'res://addons/godot_mcp_bridge/plugin.cfg',
  });
  assert.equal(twice, once);
});

test('installBridge 在缺少 project.godot 时如实报错而不是假装成功', async () => {
  const { installBridge } = await import('../src/install.mjs');
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-noproj-'));
  try {
    const report = await installBridge(dir);
    // 关键契约：没有 project.godot 就不能报告成功，也不能悄悄写出半个项目。
    assert.equal(report.ok, false);
    assert.equal(report.code, 'NO_PROJECT_FILE');
    assert.match(report.error, /project\.godot/);
    const entries = await fsp.readdir(dir);
    assert.ok(!entries.includes('project.godot'), '不应凭空创建 project.godot');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('installBridge 在真实项目上装齐 addon 与 runtime 并写对 project.godot', async () => {
  const { installBridge } = await import('../src/install.mjs');
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-install-'));
  try {
    await fsp.writeFile(
      path.join(dir, 'project.godot'),
      'config_version=5\n\n[application]\n\nconfig/name="InstallTest"\n',
      'utf8',
    );
    const report = await installBridge(dir);
    assert.equal(report.ok, true, JSON.stringify({ missing: report.missing, warnings: report.warnings }));
    assert.equal(report.settings.editorPlugins, true, '未启用编辑器插件');
    assert.equal(report.settings.autoload, true, '未写入运行时 autoload');
    // 落盘校验：文件真的在
    assert.ok(await existsPath(path.join(dir, 'addons', 'godot_mcp_bridge', 'plugin.cfg')));
    assert.ok(await existsPath(path.join(dir, 'addons', 'godot_mcp_bridge', 'runtime')));
    const text = await fsp.readFile(path.join(dir, 'project.godot'), 'utf8');
    assert.match(text, /\[editor_plugins\]/);
    assert.match(text, /enabled=PackedStringArray\("res:\/\/addons\/godot_mcp_bridge\/plugin\.cfg"\)/);
    assert.match(text, /\[autoload\]/);
    assert.match(text, /McpRuntime="\*res:\/\/addons\/godot_mcp_bridge\/runtime\/godot_mcp_runtime\.gd"/);
    assert.match(text, /config\/name="InstallTest"/, '原有设置被破坏');
    // 幂等：装第二次不应改变文件内容
    const second = await installBridge(dir);
    assert.equal(second.ok, true);
    assert.equal(await fsp.readFile(path.join(dir, 'project.godot'), 'utf8'), text);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('installBridge 会检出并覆盖项目里的旧桥，且如实报告（安全相关）', async () => {
  const { installBridge } = await import('../src/install.mjs');
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-stale-'));
  try {
    await fsp.writeFile(path.join(dir, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Stale"\n', 'utf8');
    // 先装一次
    const first = await installBridge(dir);
    assert.equal(first.ok, true);
    assert.equal(first.bridge.existedBefore, false, '首次安装不应声称「已存在」');
    assert.equal(first.bridge.replacedStale, false);
    assert.equal(first.bridge.previousSha256, null);

    // 再装一次（内容相同）→ 不应报 stale
    const second = await installBridge(dir);
    assert.equal(second.bridge.existedBefore, true);
    assert.equal(second.bridge.replacedStale, false, '内容相同不该报 stale');
    assert.equal(second.bridge.previousSha256, second.bridge.installedSha256);

    // 手动把项目内的桥改成「旧版本」→ 再装必须报告 replacedStale 并给出警告
    const installed = path.join(dir, 'addons', 'godot_mcp_bridge', 'runtime', 'godot_mcp_runtime.gd');
    await fsp.writeFile(installed, 'extends Node\n# 假装这是没有门控的旧版本\n', 'utf8');
    const third = await installBridge(dir);
    assert.equal(third.bridge.existedBefore, true);
    assert.equal(third.bridge.replacedStale, true, '内容不同必须报 stale');
    assert.notEqual(third.bridge.previousSha256, third.bridge.installedSha256);
    assert.ok(
      third.warnings.some(w => w.includes('不同内容')),
      `必须给出可行动警告，实际：${JSON.stringify(third.warnings)}`,
    );
    // 覆盖后内容应与源一致
    const after = await fsp.readFile(installed, 'utf8');
    assert.ok(after.length > 1000, '项目内副本应被真正的桥覆盖');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function existsPath(target) {
  const fsp = await import('node:fs/promises');
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 零足迹注入

async function withTempProject(prefix, body) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}state-`));
  process.env.GODOT_MCP_STATE_DIR = stateDir;
  await fsp.writeFile(path.join(dir, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="t"\n');
  try {
    return await body(dir);
  } finally {
    delete process.env.GODOT_MCP_STATE_DIR;
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
}

const injection = await import('../src/inject.mjs');

test('零足迹注入只写 override.cfg 与 .godot/ 下的脚本，绝不动 project.godot', async () => {
  await withTempProject('gmcp-inject-', async dir => {
    const before = await fsp.readFile(path.join(dir, 'project.godot'), 'utf8');
    const report = await injection.injectTransientBridge(dir);
    assert.equal(report.injected, true);
    assert.equal(report.projectFileUntouched, true);

    const override = await fsp.readFile(path.join(dir, 'override.cfg'), 'utf8');
    assert.match(override, /\[autoload\]/);
    assert.match(override, /McpRuntime="\*res:\/\/\.godot\/mcp_bridge\/godot_mcp_runtime\.gd"/);
    assert.ok(existsSync(path.join(dir, '.godot', 'mcp_bridge', 'godot_mcp_runtime.gd')));

    // 这是整个设计的前提：用户的项目文件一个字节都不变
    assert.equal(await fsp.readFile(path.join(dir, 'project.godot'), 'utf8'), before);
    assert.equal(await injection.hasInstalledBridge(dir), false);
  });
});

test('清理会删掉自己写的 override.cfg 与脚本目录（原本没有 override.cfg 时）', async () => {
  await withTempProject('gmcp-restore-', async dir => {
    await injection.injectTransientBridge(dir);
    const result = await injection.restoreTransientBridge(dir);
    assert.deepEqual(result, { restored: false, removedOverride: true, removedScript: true });
    assert.equal(existsSync(path.join(dir, 'override.cfg')), false);
    assert.equal(existsSync(path.join(dir, '.godot', 'mcp_bridge')), false);
  });
});

test('用户自己的 override.cfg 会被原样保住并还原（不能吃掉别人的配置）', async () => {
  await withTempProject('gmcp-own-', async dir => {
    const mine = '[rendering]\n\nrenderer/rendering_method="gl_compatibility"\n';
    await fsp.writeFile(path.join(dir, 'override.cfg'), mine);

    await injection.injectTransientBridge(dir);
    const merged = await fsp.readFile(path.join(dir, 'override.cfg'), 'utf8');
    assert.match(merged, /renderer\/rendering_method/); // 原有内容还在
    assert.match(merged, /McpRuntime=/); // 并且加上了 autoload

    const result = await injection.restoreTransientBridge(dir);
    assert.equal(result.restored, true);
    assert.equal(await fsp.readFile(path.join(dir, 'override.cfg'), 'utf8'), mine);
  });
});

test('上次崩溃留下的残留会在下次注入前先还原（陈旧状态自愈）', async () => {
  await withTempProject('gmcp-stale-', async dir => {
    const mine = '[application]\n\nconfig/name="mine"\n';
    await fsp.writeFile(path.join(dir, 'override.cfg'), mine);
    await injection.injectTransientBridge(dir);
    // 模拟「MCP 被杀、没来得及清理」：备份与注入同时留在磁盘上
    await fsp.writeFile(path.join(dir, '.godot', 'mcp_bridge', 'leftover.gd'), '# stale\n');

    const again = await injection.injectTransientBridge(dir);
    assert.equal(again.recovered.restored, true, '应当先还原用户原有的 override.cfg');
    assert.equal(again.recovered.removedStaleScript, true);
    assert.equal(existsSync(path.join(dir, '.godot', 'mcp_bridge', 'leftover.gd')), false);
  });
});

test('项目里已有提交式桥时，hasInstalledBridge 如实返回 true（auto 模式据此跳过注入）', async () => {
  await withTempProject('gmcp-installed-', async dir => {
    await fsp.writeFile(
      path.join(dir, 'project.godot'),
      'config_version=5\n\n[autoload]\n\nMcpRuntime="*res://addons/godot_mcp_bridge/runtime/godot_mcp_runtime.gd"\n',
    );
    assert.equal(await injection.hasInstalledBridge(dir), true);
  });
});

test('对非 Godot 目录注入会明确报错，而不是写出半个项目', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-notproj-'));
  process.env.GODOT_MCP_STATE_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-notproj-state-'));
  try {
    await assert.rejects(
      () => injection.injectTransientBridge(dir),
      error => {
        assert.equal(error.code, 'NOT_A_PROJECT');
        return true;
      },
    );
  } finally {
    delete process.env.GODOT_MCP_STATE_DIR;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('sweepStaleInjections 回收状态文件里记录、但已无活跃会话的注入', async () => {
  await withTempProject('gmcp-sweep-', async dir => {
    await injection.injectTransientBridge(dir);
    const pending = await injection.pendingInjections();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].project, dir);

    const swept = await injection.sweepStaleInjections({ isActive: () => false });
    assert.equal(swept.length, 1);
    assert.equal(swept[0].cleaned, true);
    assert.equal(existsSync(path.join(dir, 'override.cfg')), false);

    // 活跃中的项目不能被误清
    await injection.injectTransientBridge(dir);
    const kept = await injection.sweepStaleInjections({ isActive: p => p === dir });
    assert.equal(kept.length, 0);
    assert.equal(existsSync(path.join(dir, 'override.cfg')), true);
  });
});

// ---------------------------------------------------------------- build 指纹
//
// 长驻进程把 ESM 模块缓存在内存里：改完 src/*.mjs 不重启，跑的还是旧代码。
// 真机踩到过一次（活体 server 比磁盘源码旧 68 分钟，行为对不上仓库），
// 所以这里守两件事：指纹本身稳定/敏感，以及「加载的」与「磁盘的」能对不上账。

test('computeBuildId 对同一份源码稳定，且是 12 位十六进制', () => {
  const first = computeBuildId();
  const second = computeBuildId();
  assert.equal(first.id, second.id);
  assert.match(first.id, /^[0-9a-f]{12}$/);
  assert.equal(first.files, BUILD_INPUTS.length);
  assert.deepEqual(first.missing, []);
});

test('computeBuildId 随任一参与文件的内容变化（在临时副本上验证）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-build-'));
  try {
    for (const relative of BUILD_INPUTS) {
      const abs = path.join(dir, relative);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, `// ${relative}\n`);
    }
    const before = computeBuildId(dir);
    assert.deepEqual(before.missing, []);
    await fsp.writeFile(path.join(dir, BUILD_INPUTS[0]), '// changed\n');
    assert.notEqual(before.id, computeBuildId(dir).id);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('buildStatus 分得清「进程加载的」与「磁盘上的」源码（陈旧检测）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-stale-'));
  try {
    // 未改动时：两份指纹一致，不能误报 stale
    const current = buildStatus();
    assert.equal(current.stale, false);
    assert.equal(current.loaded, LOADED_BUILD.id);
    assert.equal(current.onDisk, LOADED_BUILD.id);

    // 磁盘换成了另一份源码 → 必须如实报 stale，并给出「怎么让它生效」
    for (const relative of BUILD_INPUTS) {
      const abs = path.join(dir, relative);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, `// ${relative}\n`);
    }
    const foreign = buildStatus(dir);
    assert.equal(foreign.stale, true);
    assert.notEqual(foreign.onDisk, foreign.loaded);
    assert.match(foreign.note, /kill -TERM/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('godot_status 的输出带 server.pid 与构建指纹', async () => {
  const status = await new GodotController({ godotPath: '/nonexistent/godot' }).probe();
  assert.equal(status.ok, false);
  assert.equal(typeof status.server?.pid, 'number');
  assert.match(status.server.build.loaded, /^[0-9a-f]{12}$/);
  assert.equal(status.server.build.stale, false);
});

test('initialize 的 serverInfo 带构建指纹（客户端一连上就能看到）', async () => {
  const reply = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { controller: {} },
  );
  assert.equal(reply.result.serverInfo.name, 'godot-mcp');
  assert.equal(reply.result.serverInfo.build, LOADED_BUILD.id);
  assert.equal(SERVER_INFO.build, LOADED_BUILD.id);
});

// ------------------------------------------------- owner-aware 注入回收
//
// override.cfg 是**项目级**配置：如果另一个还活着的 server（或还跑着的游戏）正靠它工作，
// 「清理残留」把它还原掉就会破坏别人。所以回收必须同时满足「本项目无活跃会话」+
// 「记录里的注入者进程已经不在」。这里把两条安全线都钉住。

test('sweepStaleInjections：注入者进程还活着时不做还原（onSkip 如实汇报原因）', async () => {
  await withTempProject('gmcp-owner-', async dir => {
    await injection.injectTransientBridge(dir);
    // 把自己注入的条目改成「另一个还活着的进程」所有（本测试的父进程），模拟另一个 server
    const stateFile = injection.TRANSIENT_STATE_FILE();
    const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
    state.projects[dir].owner = { pid: process.ppid, host: 'other-server' };
    await fsp.writeFile(stateFile, JSON.stringify(state), 'utf8');
    const skips = [];
    const swept = await injection.sweepStaleInjections({
      isActive: () => false,
      ownerAlive: () => true,
      onSkip: report => skips.push(report),
    });
    assert.deepEqual(swept, [], '注入者还活着时不能清理');
    assert.equal(skips.length, 1);
    assert.equal(skips[0].skipped, 'owner-alive');
    assert.equal(existsSync(path.join(dir, 'override.cfg')), true, '注入必须原地保留');

    // 注入者进程消失（模拟被强杀）之后才允许回收
    const cleaned = await injection.sweepStaleInjections({ isActive: () => false, ownerAlive: () => false });
    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0].cleaned, true);
    assert.equal(existsSync(path.join(dir, 'override.cfg')), false);
  });
});

test('sweepStaleInjections：本项目仍有活跃会话时跳过（不还原）', async () => {
  await withTempProject('gmcp-owner-active-', async dir => {
    await injection.injectTransientBridge(dir);
    const skips = [];
    const swept = await injection.sweepStaleInjections({
      isActive: p => p === dir,
      ownerAlive: () => false,
      onSkip: report => skips.push(report),
    });
    assert.deepEqual(swept, []);
    assert.equal(skips[0].skipped, 'project-active');
    assert.equal(existsSync(path.join(dir, 'override.cfg')), true);
  });
});

test('ProcessRegistry.sweepInjections：另一个还活着的 server 的注入不会被误清', async () => {
  await withTempProject('gmcp-registry-sweep-', async dir => {
    await injection.injectTransientBridge(dir);
    // 把 owner 改成一个「确定还活着」的进程（本测试的父进程），模拟另一个 server 的注入
    const stateFile = injection.TRANSIENT_STATE_FILE();
    const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
    state.projects[dir].owner = { pid: process.ppid, host: 'test-host' };
    await fsp.writeFile(stateFile, JSON.stringify(state), 'utf8');

    const { ProcessRegistry } = await import('../src/processes.mjs');
    const registry = new ProcessRegistry();
    const reports = await registry.sweepInjections();
    const entry = reports.find(item => item.project === dir);
    assert.ok(entry, '必须返回该项目的处理结果（而不是悄悄跳过）');
    assert.equal(entry.cleaned, false);
    assert.equal(entry.skipped, 'owner-alive');
    assert.equal(existsSync(path.join(dir, 'override.cfg')), true, '别人正在用的注入不能被还原');
  });
});
