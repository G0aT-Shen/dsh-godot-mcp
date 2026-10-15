// 核心控制器与工具面：DSH 原生插件与独立 MCP server 共用同一套定义。
//
// 工具面刻意保持「少量工具 + op 参数」的形状：
//   godot          —— L1 无头操作（万能，op 覆盖项目/场景/资源/设置/文件/脚本/导出/运行）
//   godot_batch    —— 串行批量 L1 操作（减少往返）
//   godot_session  —— 长驻编辑器/游戏进程的生命周期与日志
//   godot_connect  —— L2 编辑器实时桥 / L3 运行中游戏桥
//   godot_status   —— 环境自检（Godot 路径、ops 引擎、桥端口占用）
//
// 这样设计的原因：MCP 客户端（含我）对「几十个细碎工具」的检索成本很高，
// 而 op 名字可以写在 description 里当速查表，一次就能看到全部能力。

import process from 'node:process';
import { buildStatus } from './build.mjs';
import { DEFAULT_EDITOR_PORT, DEFAULT_RUNTIME_PORT, godotStatus, resolveProject } from './godot.mjs';
import { GodotOperationError, OPS_SCRIPT, runOperation, selfCheck } from './operations.mjs';
import { ProcessRegistry } from './processes.mjs';
import { callBridge, probePort } from './bridge.mjs';
import { installBridge } from './install.mjs';
import { pendingInjections } from './inject.mjs';

/** op 速查表：写进工具 description，让我不必先探索就能用对参数。 */
export const OP_CHEATSHEET = `可用的 op（params 直接平铺在 params 对象里，除特别说明外都需要项目上下文）：
环境: version{}
项目: project_info{} | create_project{name,renderer?}
场景: list_scenes{pattern?} | create_scene{scene_path,root_type?,root_name?} | read_scene{scene_path,max_depth?}
     read_scene_tree 用 read_scene | add_node{scene_path,node_type,node_name,parent_node_path?,properties?}
     modify_node{scene_path,node_path,properties?,new_name?} | remove_node{scene_path,node_path}
     instantiate_scene{scene_path,instance_path,parent_node_path?,node_name?}
     attach_script{scene_path,node_path,script_path} | connect_signal{scene_path,from_node,signal,to_node,method,binds?}
设置: read_settings{keys?} | write_settings{settings} | delete_settings{keys}
文件: list_files{dir?,pattern?,recursive?} | read_file{path,max_bytes?} | write_file{path,content}
     delete_file{path} | create_dir{path}
脚本: find_symbols{path} | parse_check{paths?,deep?} —— deep 逐个文件真编译，慢但不会漏级联
资源: resave_resources{paths?} | import_assets{paths?} | export_project{preset,output_path,debug?}
运行: run_project{headless?(默认 true),scene?,quit_after?(秒，默认10)} —— headless 无帧缓冲，截图请改用 godot_session(game)
逃生舱: gdscript{source} —— source 是完整 GDScript（extends SceneTree 语义），调用 MCP_RESULT(v) 回传结果

示例：
  godot(op="create_scene", params={scene_path:"res://main.tscn", root_type:"Node2D"})
  godot(op="add_node", params={scene_path:"res://main.tscn", node_type:"Sprite2D", node_name:"Hero"})
  godot(op="gdscript", params={source:"func _init(): MCP_RESULT(Engine.get_version_info())"})`;

export const EDITOR_OPS = [
  'editor.info', 'editor.scene_tree', 'editor.select', 'editor.add_node', 'editor.set_property',
  'editor.remove_node', 'editor.save_scene', 'editor.open_scene', 'editor.reload_scripts',
  'editor.run', 'editor.stop', 'editor.execute', 'editor.console_log',
];

export const RUNTIME_OPS = [
  'rt.info', 'rt.scene_tree', 'rt.get_node', 'rt.get_property', 'rt.set_property',
  'rt.call_method', 'rt.screenshot', 'rt.input', 'rt.eval', 'rt.quit',
  'rt.freeze', 'rt.resume', 'rt.step', 'rt.digest',
  'rt.errors', 'rt.act', 'rt.ui', 'rt.wait', 'rt.performance', 'rt.ping',
];

/**
 * 递归剔除 undefined 值。
 *
 * 为什么必须有这个：DSH 要求工具输出是「lossless JSON」，只要结果对象里出现
 * 一个 `undefined`（例如尚未结束的进程没有 endedAt/exitCode），整个工具调用会
 * 直接被判为 `value is not lossless JSON` 而失败 —— 调用方看不到任何有用信息。
 * 所以在返回边界统一清洗，而不是指望每个字段都恰好有值。
 * @param {unknown} value
 * @returns {unknown}
 */
export function cleanJson(value) {
  // 数组里的 undefined 必须变成 null：JSON.stringify 本来就会这么做，
  // 但 DSH 的 lossless 校验是按「序列化后是否等于原值」判定的，
  // 留下 undefined 会让数组项前后不一致。
  if (Array.isArray(value)) return value.map(item => (item === undefined ? null : cleanJson(item)));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = cleanJson(item);
    }
    return out;
  }
  return value;
}

/** 工具调用的统一错误归一化：任何异常都变成带 code 的结构化结果。 */
function failure(error, extra = {}) {
  return cleanJson({
    ok: false,
    code: error?.code ?? 'ERROR',
    error: String(error?.message ?? error),
    ...(error?.details !== undefined ? { details: error.details } : {}),
    ...extra,
  });
}

export class GodotController {
  /**
   * @param {{godotPath?: string, defaultProject?: string, cwd?: string, editorPort?: number, runtimePort?: number}} [config]
   */
  constructor(config = {}) {
    this.config = config;
    this.processes = new ProcessRegistry();
    this.editorPort = config.editorPort ?? DEFAULT_EDITOR_PORT;
    this.runtimePort = config.runtimePort ?? DEFAULT_RUNTIME_PORT;
  }

  get baseOptions() {
    return {
      godot: this.config.godotPath,
      defaultProject: this.config.defaultProject,
      cwd: this.config.cwd,
    };
  }

  /** L1：单次 op。 */
  async probe() {
    const status = await godotStatus(this.config.godotPath);
    const engine = status.ok ? await selfCheck(this.baseOptions) : { ok: false, error: status.error };
    const [editorUp, runtimeUp] = await Promise.all([
      probePort({ port: this.editorPort }),
      probePort({ port: this.runtimePort }),
    ]);
    // 只报告、不删除：自动清理可能在别的地方还有活跃会话时误伤。
    const pending = await pendingInjections().catch(() => []);
    return {
      ok: Boolean(status.ok && engine.ok),
      // 构建指纹：长驻进程会把 ESM 模块缓存在内存里，改完源码不重启就不生效。
      // 不用这个字段的话，「活体工具跑的是旧构建」只能靠对比 mtime 猜出来。
      server: { pid: process.pid, build: buildStatus() },
      godot: status,
      opsEngine: { script: OPS_SCRIPT, ...engine },
      bridges: {
        editor: { port: this.editorPort, listening: editorUp },
        runtime: { port: this.runtimePort, listening: runtimeUp },
      },
      sessions: cleanJson(this.processes.list()),
      ...(pending.length ? { pendingInjections: cleanJson(pending) } : {}),
    };
  }

  async op(op, params = {}, options = {}) {
    try {
      const project = options.project ?? params.project ?? this.config.defaultProject;
      const result = await runOperation(
        op,
        params,
        { ...this.baseOptions, project, signal: options.signal, timeoutMs: options.timeoutMs },
      );
      return result;
    } catch (error) {
      return failure(error, { op });
    }
  }

  /** L1 批量：串行执行，任一步失败即停（fail-fast），返回每步结果。 */
  async batch(steps = [], options = {}) {
    if (!Array.isArray(steps) || steps.length === 0) {
      return { ok: false, code: 'BAD_STEPS', error: 'steps 必须是非空数组' };
    }
    const results = [];
    const started = Date.now();
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index] ?? {};
      const { op, ...params } = step;
      if (!op) {
        results.push({ index, ok: false, code: 'BAD_STEP', error: `第 ${index} 步缺少 op` });
        return { ok: false, steps: results, stoppedAt: index, durationMs: Date.now() - started };
      }
      const result = await this.op(op, params, { ...options, project: step.project ?? options.project });
      results.push({ index, op, ...result });
      if (result.ok === false) {
        return { ok: false, steps: results, stoppedAt: index, durationMs: Date.now() - started };
      }
    }
    return { ok: true, steps: results, durationMs: Date.now() - started };
  }

  /** L2/L3：桥调用。 */
  async bridge(target, op, params = {}, options = {}) {
    try {
      const port =
        options.port ??
        (target === 'editor' ? this.editorPort : this.runtimePort);
      const data = await callBridge(target, op, params, {
        port,
        host: options.host,
        timeoutMs: options.timeoutMs,
      });
      return { ok: true, target, op, data };
    } catch (error) {
      return failure(error, { target, op });
    }
  }

  /** 长驻进程：启动/停止/日志/列表。 */
  async session(action, params = {}) {
    try {
      const options = { ...this.baseOptions, ...params };
      switch (action) {
        case 'list':
          return { ok: true, sessions: cleanJson(this.processes.list()) };
        case 'setup': {
          // 把编辑器桥 + 运行时桥自动装进项目，使后续 editor/runtime 控制可用。
          const project = await resolveProject({
            project: params.project ?? this.config.defaultProject,
            cwd: this.config.cwd,
          });
          const report = await installBridge(project, {
            editor: params.editor,
            runtime: params.runtime,
          });
          return report;
        }
        case 'editor': {
          const process_ = await this.processes.startEditor(options);
          return { ok: true, session: cleanJson(process_.toJSON()) };
        }
        case 'game': {
          const process_ = await this.processes.startGame(options);
          return { ok: true, session: cleanJson(process_.toJSON()) };
        }
        case 'attach': {
          // 游戏不是我们启动的（CI / 手动 godot --path . / 外部调试器），
          // 但注入桥之后，那个游戏一启动就能被 godot_connect(runtime) 接管。
          const project = await resolveProject({
            project: params.project ?? this.config.defaultProject,
            cwd: this.config.cwd,
          });
          const attached = await this.processes.attach(project, {
            runtimePort: params.runtimePort ?? this.runtimePort,
          });
          return cleanJson({
            ok: true,
            action: 'attach',
            id: attached.id,
            project: attached.projectPath,
            bridge: attached.bridge,
            port: params.runtimePort ?? this.runtimePort,
            hint: '现在可以手动启动游戏（例如 `godot --path <project>`），启动后直接用 godot_connect(target="runtime") 接管。做完用 detach 撤销。',
          });
        }
        case 'detach': {
          const project = params.project
            ? await resolveProject({ project: params.project, cwd: this.config.cwd })
            : undefined;
          const result = await this.processes.detach(params.id, project);
          if (!result) return { ok: false, code: 'NO_SUCH_ATTACH', error: `没有 attach 记录 ${params.id ?? params.project ?? ''}` };
          return cleanJson({ ok: true, ...result });
        }
        case 'cleanup': {
          // 回收上一次 MCP 进程被杀之后残留的零足迹注入。
          const swept = await this.processes.sweepInjections();
          return cleanJson({ ok: true, swept, count: swept.length });
        }
        case 'stop': {
          if (params.id) {
            const result = await this.processes.stop(params.id, { graceMs: params.graceMs });
            if (!result) return { ok: false, code: 'NO_SUCH_SESSION', error: `没有会话 ${params.id}` };
            return { ok: true, id: params.id, ...result };
          }
          const kind = params.kind;
          const targets = this.processes.findRunning(kind);
          if (!targets.length) return { ok: true, stopped: [], note: '没有正在运行的会话' };
          const results = await Promise.all(
            targets.map(process_ => process_.stop({ graceMs: params.graceMs }).then(result => ({ id: process_.id, ...result }))),
          );
          return { ok: true, stopped: results };
        }
        case 'logs': {
          const id = params.id ?? this.processes.findRunning(params.kind)[0]?.id;
          if (!id) return { ok: false, code: 'NO_SUCH_SESSION', error: '没有可读日志的会话（请传 id）' };
          const output = this.processes.readOutput(id, {
            cursor: params.cursor,
            limit: params.limit,
            stream: params.stream,
          });
          if (!output) return { ok: false, code: 'NO_SUCH_SESSION', error: `没有会话 ${id}` };
          const status = cleanJson(this.processes.get(id).toJSON());
          return { ok: true, ...cleanJson(output), status };
        }
        default:
          return { ok: false, code: 'BAD_ACTION', error: `未知 action：${action}（list/editor/game/stop/logs）` };
      }
    } catch (error) {
      return failure(error);
    }
  }

  /** 解析项目路径（供工具回显与调试）。 */
  async resolveProjectFor(project) {
    return resolveProject({ project: project ?? this.config.defaultProject, cwd: this.config.cwd });
  }

  async shutdown() {
    await this.processes.stopAll();
  }
}

/** 工具定义（与传输协议无关的规范形状）：{name, description, inputSchema, handler}。 */
export function buildToolDefinitions(controller) {
  return [
    {
      name: 'godot',
      description:
        '控制 Godot 引擎执行一次操作（无头 CLI 层）：创建/编辑场景与节点、读写项目设置、' +
        '文件与脚本操作、资源导入与导出、运行项目、以及 gdscript 逃生舱。\n' +
        `project 省略时自动从当前目录向上查找 project.godot。\n\n${OP_CHEATSHEET}`,
      inputSchema: {
        type: 'object',
        properties: {
          op: { type: 'string', description: '操作名，见描述中的速查表' },
          params: { type: 'object', description: '操作参数，键名见速查表', additionalProperties: true },
          project: { type: 'string', description: 'Godot 项目目录（绝对路径）；省略则自动查找' },
          timeoutMs: { type: 'integer', description: '超时毫秒；长任务如 run_project/export_project 默认 900000' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      handler: async (args, exec) => controller.op(args.op, args.params ?? {}, {
        project: args.project,
        timeoutMs: args.timeoutMs,
        signal: exec?.signal,
      }),
    },
    {
      name: 'godot_batch',
      description:
        '串行执行多步 Godot 操作，任一步失败即停止并返回已执行步骤。适合「建场景→加节点→挂脚本→存盘」这类固定流水线。',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: '步骤数组，每项形如 {op:"add_node", scene_path:"res://a.tscn", ...}',
            items: { type: 'object', additionalProperties: true },
          },
          project: { type: 'string', description: '默认项目目录' },
        },
        required: ['steps'],
        additionalProperties: false,
      },
      handler: async (args, exec) => controller.batch(args.steps ?? [], {
        project: args.project,
        signal: exec?.signal,
      }),
    },
    {
      name: 'godot_session',
      description:
        '管理 Godot 项目与会话：\n' +
        '· setup：把编辑器桥（L2）与运行时桥（L3）**自动安装**进项目（复制 addon、写 project.godot 的插件与 autoload），' +
        '装完才能用 godot_connect。幂等，可重复调用以更新桥。\n' +
        '· editor：打开编辑器（长驻）；· game：运行游戏（长驻，**默认自动零足迹注入运行时桥**，无需先 setup）；\n' +
        '· attach：只注入桥不启动，等外部启动的游戏连上来（CI / 手动启动 / 外部调试器）；\n' +
        '· detach：撤销 attach；· cleanup：回收上一次 MCP 被杀后残留的注入；\n' +
        '· stop：停止会话（按 id 或按 kind）；· logs：读会话日志（支持增量游标）；· list：列出全部会话。\n' +
        '典型流程：godot_session(game) → godot_connect(runtime, ...)（不需要预先安装任何东西）。\n' +
        '编辑器实时层仍需 godot_session(setup) 安装插件。',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['setup', 'editor', 'game', 'attach', 'detach', 'cleanup', 'stop', 'logs', 'list'],
            description: '要执行的动作',
          },
          project: { type: 'string', description: '项目目录' },
          id: { type: 'string', description: '会话 id（stop/logs 用）' },
          kind: { type: 'string', enum: ['editor', 'game'], description: '按类型批量停止或选会话' },
          scene: { type: 'string', description: '运行指定场景（res:// 路径）' },
          headless: { type: 'boolean', description: '无头模式（无窗口，没有帧缓冲）' },
          keepAwake: {
            type: 'boolean',
            description: 'macOS 下用 caffeinate 包住会话防止 App Nap/空闲休眠冻结，默认 true；传 false 关闭',
          },
          cursor: { type: 'integer', description: '日志字节游标，增量读' },
          limit: { type: 'integer', description: '日志最多返回字节数' },
          editor: { type: 'boolean', description: 'setup 时是否安装编辑器桥，默认 true' },
          runtime: { type: 'boolean', description: 'setup 时是否安装运行时桥，默认 true' },
          bridge: {
            type: 'string',
            enum: ['auto', 'transient', 'installed', 'none'],
            description:
              'game 时的桥形态。auto（默认）=项目里已装就用，否则零足迹注入；transient=强制零足迹注入；' +
              'installed=要求已装否则报错；none=不注入。零足迹注入只新增 override.cfg 与 .godot/mcp_bridge/，' +
              '**不修改 project.godot**，会话结束自动清除',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      handler: async (args, exec) => controller.session(args.action, { ...args, signal: exec?.signal }),
    },
    {
      name: 'godot_connect',
      description:
        '与"正在运行的"Godot 通信（热路径）：\n' +
        '· target=editor：编辑器实时桥。可直接改当前编辑场景、选中节点、保存、重载脚本、' +
        '执行任意编辑器脚本（editor.execute）。改动走 UndoRedo，用户可撤销。\n' +
        '· target=runtime：运行中游戏桥。读场景树、读写属性、调用方法、注入输入、截图。\n' +
        '需要先在项目里安装 addon（见 godot/addon/INSTALL.md），并用 godot_session 启动。\n' +
        `editor op：${EDITOR_OPS.join(', ')}\n` +
        `runtime op：${RUNTIME_OPS.join(', ')}`,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['editor', 'runtime'], description: '要连接的目标层' },
          op: { type: 'string', description: '桥操作名（editor.* 或 rt.*）' },
          params: { type: 'object', description: '操作参数', additionalProperties: true },
          port: { type: 'integer', description: '覆盖默认端口（editor 9089 / runtime 9091）' },
          timeoutMs: {
            type: 'integer',
            description:
              '超时毫秒。默认按 op 自适应（普通 15000；rt.eval/editor.execute 30000；rt.screenshot 20000）。' +
              '超时报错里会给出建议值',
          },
        },
        required: ['target', 'op'],
        additionalProperties: false,
      },
      handler: async (args, exec) => controller.bridge(args.target, args.op, args.params ?? {}, {
        port: args.port,
        timeoutMs: args.timeoutMs,
        signal: exec?.signal,
      }),
    },
    {
      name: 'godot_status',
      description:
        '自检：Godot 可执行文件路径与版本、无头操作引擎是否可用、编辑器/运行时桥端口是否在监听、当前会话列表，' +
        '以及 **server 构建指纹**（`server.build.loaded`/`onDisk`/`stale`）。' +
        '首次使用或工具报错时先跑这个；如果 `stale: true`，说明磁盘源码与正在跑的进程不一致，杀掉该 pid 让 mcp-client 自动重启。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => controller.probe(),
    },
  ];
}

export { GodotOperationError };
