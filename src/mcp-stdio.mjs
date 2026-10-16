// 独立 MCP stdio 服务器：让任何 MCP 客户端（Codex、Claude Code、Cursor…）
// 也能用同一套 Godot 工具面。协议：JSON-RPC 2.0，每行一条消息（NDJSON）。
//
// 注册示例：
//   codex mcp add godot -- node /path/to/dsh-godot-mcp/bin/godot-mcp.mjs
//   claude mcp add godot -- node /path/to/dsh-godot-mcp/bin/godot-mcp.mjs

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { LOADED_BUILD } from './build.mjs';
import { GodotController, buildToolDefinitions } from './server.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'godot-mcp', version: '1.0.0', build: LOADED_BUILD.id };

const text = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/**
 * 处理一条 JSON-RPC 消息。导出供测试直接调用。
 * @param {object} message
 * @param {{controller: GodotController, notify?: Function, signal?: AbortSignal}} context
 */
export async function handleMessage(message, { controller, notify = () => {}, signal } = {}) {
  const { id, method, params } = message ?? {};
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message_) => ({ jsonrpc: '2.0', id, error: { code, message: message_ } });
  const tools = buildToolDefinitions(controller);

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Godot 引擎控制：godot 执行无头操作（场景/节点/设置/文件/脚本/导出/运行），' +
          'godot_session 管理长驻编辑器与游戏进程，godot_connect 与运行中的编辑器/游戏实时交互，' +
          'godot_status 自检环境。首次使用先调 godot_status。',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = tools.find(item => item.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      const args = params?.arguments ?? {};
      const missing = (tool.inputSchema.required ?? []).filter(key => args[key] === undefined);
      if (missing.length) return fail(-32602, `Missing required argument(s): ${missing.join(', ')}`);
      const progressToken = params?._meta?.progressToken;
      let completed = 0;
      const progress = message_ => {
        if (progressToken === undefined || signal?.aborted) return;
        notify({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken, progress: ++completed, message: message_ },
        });
      };
      try {
        if (signal?.aborted) return null;
        progress(`${tool.name} 开始`);
        const value = await tool.handler(args, { signal });
        if (signal?.aborted) return null;
        progress(`${tool.name} 完成`);
        return reply({ content: [{ type: 'text', text: text(value) }], isError: value?.ok === false });
      } catch (error) {
        if (signal?.aborted) return null;
        return reply({ content: [{ type: 'text', text: `Error: ${error?.message ?? error}` }], isError: true });
      }
    }
    default:
      return message?.id === undefined ? null : fail(-32601, `Method not found: ${method}`);
  }
}

/**
 * 启动 stdio 服务器（阻塞直到 stdin 结束）。
 * @param {{controller?: GodotController, input?: NodeJS.ReadStream, output?: NodeJS.WriteStream, config?: object}} [options]
 */
export async function startMcpServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const controller = options.controller ?? new GodotController(options.config ?? {});

  let buffer = '';
  const send = message => {
    if (message) output.write(`${JSON.stringify(message)}\n`);
  };
  const notify = message => output.write(`${JSON.stringify(message)}\n`);
  const requests = new Map();
  const tasks = new Set();
  let toolQueue = Promise.resolve();

  const cancelAll = () => {
    for (const request of requests.values()) request.abort();
  };
  const dispatch = message => {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    if (message.method === 'notifications/cancelled') {
      requests.get(message.params?.requestId)?.abort(message.params?.reason);
      return;
    }
    // 其他通知不能产生响应，也不能以 tools/call 通知的方式产生副作用。
    if (message.id === undefined) return;
    if (requests.has(message.id)) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Request id is already in use' } });
      return;
    }
    const request = new AbortController();
    requests.set(message.id, request);
    const execute = async () => {
      if (request.signal.aborted) return;
      const result = await handleMessage(message, { controller, notify, signal: request.signal });
      if (!request.signal.aborted) send(result);
    };
    // 保留写操作的串行语义；ping、发现和只读自检不排在长任务后面。
    const queued = message.method === 'tools/call' && message.params?.name !== 'godot_status';
    const task = (queued ? toolQueue.then(execute) : execute())
      .catch(error => {
        if (!request.signal.aborted) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
      })
      .finally(() => { requests.delete(message.id); tasks.delete(task); });
    tasks.add(task);
    if (queued) toolQueue = task;
  };

  input.setEncoding?.('utf8');
  const shutdown = async () => {
    cancelAll();
    await Promise.allSettled([...tasks]);
    await controller.shutdown().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    for await (const chunk of input) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          continue;
        }
        dispatch(message);
      }
    }
  } finally {
    cancelAll();
    await Promise.allSettled([...tasks]);
    await controller.shutdown().catch(() => {});
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
  return { controller };
}

// 作为可执行入口（`node bin/godot-mcp.mjs` 或 mcp add 时）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startMcpServer({
    config: {
      godotPath: process.env.GODOT_MCP_GODOT,
      defaultProject: process.env.GODOT_MCP_PROJECT,
    },
  });
}
