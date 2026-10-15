#!/usr/bin/env node
// Godot MCP CLI：既是 MCP stdio server，也是本地命令行工具（便于不开客户端时验证）。
//
// 用法：
//   node bin/godot-mcp.mjs                      # 作为 MCP stdio server 运行（默认）
//   node bin/godot-mcp.mjs serve                # 同上，显式
//   node bin/godot-mcp.mjs status               # 环境自检
//   node bin/godot-mcp.mjs op <op> '<json>'     # 跑一次无头操作
//   node bin/godot-mcp.mjs op gdscript '{"source":"..."}'
//   node bin/godot-mcp.mjs tools                # 打印工具清单（JSON）
//   node bin/godot-mcp.mjs install-addon <项目目录>  # 把编辑器/运行时桥装进项目（与 godot_session setup 同一路径）

import path from 'node:path';
import process from 'node:process';
import { GodotController, buildToolDefinitions } from '../src/server.mjs';
import { installBridge } from '../src/install.mjs';
import { startMcpServer } from '../src/mcp-stdio.mjs';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'serve';

function controllerFromEnv() {
  return new GodotController({
    godotPath: process.env.GODOT_MCP_GODOT,
    defaultProject: process.env.GODOT_MCP_PROJECT,
    cwd: process.cwd(),
  });
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  switch (command) {
    case 'serve': {
      await startMcpServer({
        config: { godotPath: process.env.GODOT_MCP_GODOT, defaultProject: process.env.GODOT_MCP_PROJECT },
      });
      return;
    }
    case 'status': {
      const status = await controllerFromEnv().probe();
      print(status);
      process.exitCode = status.ok ? 0 : 1;
      return;
    }
    case 'tools': {
      const tools = buildToolDefinitions(controllerFromEnv());
      print(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
      return;
    }
    case 'op': {
      const op = argv[1];
      if (!op) {
        print({ ok: false, error: '用法：op <op> \'<json params>\'' });
        process.exitCode = 2;
        return;
      }
      const raw = argv[2] ?? '{}';
      let params;
      try {
        params = JSON.parse(raw);
      } catch (error) {
        print({ ok: false, error: `params 不是合法 JSON：${error.message}` });
        process.exitCode = 2;
        return;
      }
      const controller = controllerFromEnv();
      const result = await controller.op(op, params);
      print(result);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    case 'install-addon': {
      const target = argv[1];
      if (!target) {
        print({ ok: false, error: '用法：install-addon <项目目录>' });
        process.exitCode = 2;
        return;
      }
      const targetProject = path.resolve(target);
      // 复用 src/install.mjs 的安装逻辑：它与 godot_session(action="setup") 是同一条代码路径，
      // 所以 CLI 装出来的结果和工具装出来的结果必然一致（含 project.godot 的插件/autoload 写入）。
      try {
        const report = await installBridge(targetProject);
        print(report);
        process.exitCode = report.ok ? 0 : 1;
      } catch (error) {
        print({ ok: false, error: String(error?.message ?? error) });
        process.exitCode = 1;
      }
      return;
    }
    default: {
      print({
        ok: false,
        error: `未知命令：${command}`,
        usage: ['serve', 'status', 'tools', "op <op> '<json>'", 'install-addon <项目目录>'],
      });
      process.exitCode = 2;
    }
  }
}


main().catch(error => {
  print({ ok: false, error: String(error?.stack ?? error) });
  process.exitCode = 1;
});
