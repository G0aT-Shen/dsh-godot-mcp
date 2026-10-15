// 按 DSH 的 mcp-client 起 server 的方式做一次真实探针：
// 干净环境（scrubbed env）+ 绝对路径命令 → initialize → tools/list。
//
// 为什么必须真起一次：配错 node 路径、配错 server 路径这类问题，光看 YAML 看不出来；
// 而 mcp-client 用 scrubbedParentEnv() 起子进程，`PATH` 里的 node 并不可依赖。
//
// 被 scripts/setup.mjs 与 scripts/verify-wiring.mjs 共用。

import { spawn } from 'node:child_process';
import os from 'node:os';

/**
 * @param {{command: string, args?: string[], cwd?: string, env?: Record<string,string>, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, tools?: string[], serverInfo?: object, protocolVersion?: string, error?: string, stderr?: string}>}
 */
export function probeMcpServer({ command, args = [], cwd, env, timeoutMs = 90_000 }) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      // 刻意只给最小环境：mcp-client 的 scrubbedParentEnv() 正是会洗掉凭据类与陈旧 DSH_* 变量。
      // 额外传入的 env 来自 profile 配置（例如钉住 GODOT_MCP_GODOT）。
      env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', ...(env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let settled = false;
    let initResult;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(value);
    };
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      settled = true;
      resolve({ ok: false, error: `探针超时（${timeoutMs}ms）`, stderr });
    }, timeoutMs);

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
          continue;
        }
        if (message.id === 1 && message.result) {
          if (initResult === undefined) initResult = message.result;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          if (message.error) {
            finish({ ok: false, error: `tools/list 失败：${JSON.stringify(message.error)}`, stderr });
            continue;
          }
          finish({
            ok: true,
            tools: (message.result?.tools ?? []).map(tool => tool.name),
            serverInfo: initResult?.serverInfo,
            protocolVersion: initResult?.protocolVersion,
            stderr,
          });
        }
      }
    });
    child.on('error', error => {
      finish({ ok: false, error: String(error.message), stderr });
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe-mcp', version: '1' } },
    });
  });
}
