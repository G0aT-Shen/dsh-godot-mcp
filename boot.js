// dsh-godot-mcp —— DSH **原生插件**入口（当前未启用）
//
// ★ 现状：项目接入 DSH 的方式已改为「标准 stdio MCP server + DSH 自带的
//   dsh-mcp-client」（见 README「接入 DSH」）。本插件入口因此**不在
//   dsh.profile.bundles 里，不会被加载**；实际对外提供能力的是
//   src/mcp-stdio.mjs + bin/godot-mcp.mjs。
//
//   保留原因：同一套 src/ 逻辑两种形态共用。若要重新启用插件形态，先把包名加回
//   dsh.profile.bundles，并先读 verification/SUMMARY.md 第 7 节 —— 插件形态曾在
//   真实 DSH 里出现「条目已组合、但工具一个都没注册」的问题。
//
// 职责：
//   1. 创建一个 GodotController（进程内单例，工具调用之间共享长驻进程注册表）；
//   2. 把 5 个 Godot 工具注册到 DSH 工具注册表（inject=['tools'] + ctx.tools.register，
//      这是 DSH 的规范写法；对照可用的 @hanyangshen/codex-shared 实现）；
//   3. 插件卸载时停掉所有由它启动的 Godot 进程，避免留下孤儿编辑器/游戏；
//   4. 启动时把「模块已加载/apply 已调用/注册了哪些工具」写入诊断文件（见 src/diagnose.mjs）。
//
// 配置（profile 的插件 config 或 cordis.patch.yml）：
//   godotPath        覆盖 Godot 可执行文件路径
//   defaultProject   默认项目目录（缺省时从 cwd 向上找 project.godot）
//   editorPort       编辑器桥端口，默认 9089
//   runtimePort      运行时桥端口，默认 9091

import { GodotController, buildToolDefinitions } from './src/server.mjs';
import { registerGodotTools } from './src/tools.mjs';
import { reportBootStatus } from './src/diagnose.mjs';

export const name = 'godot-mcp';

// 用 cordis 的依赖声明（而不是"可选访问 + 静默降级"）：
// 声明 inject 后 cordis 会等这些服务就绪再激活本插件，属性访问 `ctx.tools` 才是合法的。
// 之前的写法用 ctx.get('tools') 并在拿不到时只 warn 一句就返回 —— 那等于把
// "插件根本没注册成功" 变成一个看不见的软失败：DSH 里表现为 unknown tool，
// 而所有本地测试仍然全绿。这类问题必须让它可见。
export const inject = ['tools'];

/** DSH 工具名（也是 MCP server 暴露的名字，保持两边一致）。 */
export const TOOL_NAMES = ['godot', 'godot_batch', 'godot_session', 'godot_connect', 'godot_status'];

/**
 * 记录启动状态到磁盘。
 *
 * 为什么需要：DSH 是图形应用，插件的 console 输出我看不到，而"工具没出现"这个现象
 * 既可能是模块没被 import、也可能是 apply 没被调用、也可能是注册被拒。
 * 写一个状态文件就能在一次重启内区分这三种情况，不用反复猜。
 * 只做 best-effort，绝不因为写不了文件而影响插件本身。
 */
// 模块级就记一笔：能写出这个文件，说明模块确实被 import 了。
reportBootStatus({ moduleLoaded: true, phase: 'import' });

export function apply(ctx, config = {}) {
  reportBootStatus({ moduleLoaded: true, applyCalled: true, phase: 'apply', config: { ...config } });

  const controller = new GodotController({
    godotPath: typeof config.godotPath === 'string' ? config.godotPath : undefined,
    defaultProject: typeof config.defaultProject === 'string' ? config.defaultProject : undefined,
    editorPort: Number.isInteger(config.editorPort) ? config.editorPort : undefined,
    runtimePort: Number.isInteger(config.runtimePort) ? config.runtimePort : undefined,
    cwd: config.cwd,
  });

  const definitions = buildToolDefinitions(controller);
  const registered = [];
  const errors = [];

  // 工具注册。
  //
  // 注意这里**不再包一层 ctx.effect**：注册只需要在 apply 时发生一次，
  // effect 只是多引入一条可能不被调用/被回滚的路径。注销交给 cordis 自己管。
  let tools;
  try {
    tools = ctx.tools ?? (typeof ctx.get === 'function' ? ctx.get('tools') : undefined);
  } catch (error) {
    errors.push(`访问 tools 服务失败：${String(error?.message ?? error)}`);
  }

  if (!tools || typeof tools.register !== 'function') {
    const message =
      'godot-mcp: 拿不到 tools 服务（ctx.tools 与 ctx.get("tools") 都不可用），工具未注册。' +
      `inject=${JSON.stringify(inject)}`;
    ctx.logger?.error?.(message);
    reportBootStatus({ applyCalled: true, phase: 'failed', toolsAvailable: false, errors: [...errors, message] });
    // 这里刻意抛错：让 DSH 明确看到这个条目激活失败，而不是静默少一批工具。
    throw new Error(message);
  }

  try {
    registerGodotTools(controller, tools, {
      definitions,
      logger: {
        info: message => ctx.logger?.info?.(message),
        warn: message => {
          errors.push(String(message));
          ctx.logger?.warn?.(message);
        },
        error: message => {
          errors.push(String(message));
          ctx.logger?.error?.(message);
        },
      },
      onRegister: toolName => registered.push(toolName),
    });
  } catch (error) {
    errors.push(`registerGodotTools 抛错：${String(error?.message ?? error)}`);
  }

  ctx.logger?.info?.(`godot-mcp: 已注册 ${registered.length} 个工具：${registered.join(', ')}`);
  reportBootStatus({
    applyCalled: true,
    phase: registered.length === TOOL_NAMES.length ? 'ok' : 'partial',
    toolsAvailable: true,
    registered,
    expected: TOOL_NAMES,
    errors,
  });

  // 进程回收：插件卸载/DSH 退出时杀掉所有受管 Godot 进程。
  ctx.effect(() => {
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      controller
        .shutdown()
        .then(results => {
          const killed = results.filter(result => result?.stopped).length;
          if (killed) ctx.logger?.info?.(`godot-mcp: 已停止 ${killed} 个 Godot 会话`);
        })
        .catch(error => ctx.logger?.warn?.(`godot-mcp: 停止会话时出错：${String(error?.message ?? error)}`));
    };
  });

  // 说明：这里曾经尝试注册一条可选 HTTP 路由 /godot-mcp/status，但那版写法是错的：
  // 它的 shape 被写成了 `{ method, path, handler: async () => ({status, headers, body}) }`，
  // 而 DSH 的 webServer.register 要的是 Node 风格 `{ kind, path, handler(req, res) }`
  // （对照 @hanyangshen/codex-shared 的可用实现可见）。既然是可选增强、且 `godot_status`
  // 工具已经覆盖了同样的观测需求，就直接去掉，避免留一条"看起来注册了其实没生效"的路径。
  // 要外部观测请直接用 godot_status 工具。

  return { controller, definitions };
}
