#!/usr/bin/env node
// MCP 协议层验收：把本项目当成**真正的 MCP server** 来用（不经 DSH）。
//
// 为什么需要这个脚本：
//   项目有两条使用路径 —— ① DSH 插件；② 标准 stdio MCP server（给 dsh-mcp-client /
//   Codex / Claude Code 用）。之前我只测过控制器和 DSH 工具面，**协议层从未被测过**：
//   initialize / tools/list / tools/call 的实际线上形状、错误如何回传，都没有证据。
//   如果决定走"只做 MCP"，这条路必须自己站得住。
//
// 做法：像任何 MCP 客户端那样 spawn 本项目的 server，用 NDJSON JSON-RPC 对话，
//   并真的让它调用 Godot 干活。零依赖，不需要 DSH。
//
// 用法：node scripts/verify-mcp.mjs

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'bin', 'godot-mcp.mjs');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}\n`);
}

/** 最小 MCP 客户端：NDJSON JSON-RPC over stdio。 */
function connect(command, args, { env, cwd } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  const notifications = [];
  let stderr = '';

  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  child.stdout.on('data', chunk => {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // 非协议行（日志等）忽略
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve } = pending.get(message.id);
        pending.delete(message.id);
        resolve(message);
      } else if (message.method !== undefined) {
        notifications.push(message);
      }
    }
  });

  const request = (method, params, timeoutMs = 240_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(id, {
        resolve: message => {
          clearTimeout(timer);
          resolve(message);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const notify = method => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return {
    child,
    request,
    notify,
    notifications,
    get stderr() {
      return stderr;
    },
    close: () => child.kill('SIGTERM'),
  };
}

async function main() {
  const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-proto-'));
  process.stdout.write(`项目：${projectDir}\nserver：${SERVER}\n\n`);

  // 关键：模拟 dsh-mcp-client 的行为 —— 它用 scrubbedParentEnv() 起子进程，
  // 所以 GODOT_MCP_* 一律不可依赖；这里刻意只给 GODOT_MCP_PROJECT 之外的干净环境。
  const client = connect(process.execPath, [SERVER], {
    cwd: projectDir,
    env: { GODOT_MCP_PROJECT: projectDir },
  });

  try {
    // 1. initialize
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'verify-mcp', version: '1.0.0' },
    });
    record('initialize 成功', init.result !== undefined, init.result?.serverInfo?.name ?? JSON.stringify(init.error));
    record('serverInfo 正确', init.result?.serverInfo?.name === 'godot-mcp', init.result?.serverInfo?.version);
    record('协议版本被回显', typeof init.result?.protocolVersion === 'string', init.result?.protocolVersion);
    record('声明了 tools 能力', init.result?.capabilities?.tools !== undefined);
    client.notify('notifications/initialized');

    // 2. tools/list
    const list = await client.request('tools/list', {});
    const tools = list.result?.tools ?? [];
    record('tools/list 返回 5 个工具', tools.length === 5, tools.map(t => t.name).join(', '));
    const expected = ['godot', 'godot_batch', 'godot_session', 'godot_connect', 'godot_status'];
    record('工具名与设计一致', expected.every(name => tools.some(t => t.name === name)));
    record(
      '每个工具都有 inputSchema（MCP 要求 inputSchema 而非 parameters）',
      tools.every(t => t.inputSchema?.type === 'object'),
      tools.map(t => `${t.name}:${t.inputSchema?.type}`).join(' '),
    );
    record('工具描述非空（模型要靠它发现能力）', tools.every(t => (t.description ?? '').length > 20));

    // 3. tools/call —— 真的让 Godot 干活（经由 stdio server）
    const status = await client.request('tools/call', { name: 'godot_status', arguments: {} });
    const statusText = status.result?.content?.[0]?.text ?? '';
    record('tools/call godot_status 成功', status.result !== undefined && status.result.isError !== true, statusText.slice(0, 120));
    record('经协议层也能读到真实 Godot 版本', /4\.7\.2/.test(statusText), (statusText.match(/"version":[^,]*/) ?? [])[0]);

    const created = await client.request('tools/call', {
      name: 'godot',
      arguments: { op: 'create_project', params: { project_path: projectDir, name: 'MCP Protocol Test' } },
    });
    const createdText = created.result?.content?.[0]?.text ?? '';
    record('经协议层 create_project 成功', created.result?.isError !== true && createdText.includes('"created": true'), createdText.slice(0, 160));
    record('项目文件真的落盘', await fsp.stat(path.join(projectDir, 'project.godot')).then(s => s.isFile()).catch(() => false));

    const scene = await client.request('tools/call', {
      name: 'godot_batch',
      arguments: {
        project: projectDir,
        steps: [
          { op: 'create_scene', scene_path: 'res://main.tscn', root_type: 'Node2D', root_name: 'Main' },
          { op: 'add_node', scene_path: 'res://main.tscn', node_type: 'Sprite2D', node_name: 'Hero' },
        ],
      },
    });
    const sceneText = scene.result?.content?.[0]?.text ?? '';
    record('经协议层 godot_batch 两步都成功', scene.result?.isError !== true && sceneText.includes('"ok": true'), sceneText.slice(0, 120));

    // 4. 错误必须如实回传（不能假装成功）
    const missing = await client.request('tools/call', { name: 'godot_batch', arguments: {} });
    record('缺少必填参数时返回 JSON-RPC error', missing.error?.code === -32602, JSON.stringify(missing.error ?? missing.result).slice(0, 160));

    const badOp = await client.request('tools/call', {
      name: 'godot',
      arguments: { op: 'no_such_op_xyz', params: {} },
    });
    const badText = badOp.result?.content?.[0]?.text ?? '';
    record(
      '未知 op 以 isError 回传且带原因',
      badOp.result?.isError === true || badOp.error !== undefined,
      (badText || JSON.stringify(badOp.error ?? {})).slice(0, 160),
    );

    const unknown = await client.request('tools/call', { name: 'nope', arguments: {} });
    record('未知工具返回 -32602', unknown.error?.code === -32602, JSON.stringify(unknown.error).slice(0, 120));

    // 5. 未实现的方法
    const unknownMethod = await client.request('nonsense/method', {});
    record('未知方法返回 -32601', unknownMethod.error?.code === -32601, JSON.stringify(unknownMethod.error).slice(0, 120));
  } finally {
    client.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .catch(error => record('协议验收异常中断', false, String(error?.stack ?? error)))
  .finally(() => {
    const failed = results.filter(item => !item.ok);
    process.stdout.write(`\n=== 汇总 ===\n通过 ${results.length - failed.length}/${results.length}\n`);
    for (const item of failed) process.stdout.write(`  - ${item.name}: ${JSON.stringify(item.detail)}\n`);
    process.exitCode = failed.length ? 1 : 0;
  });
