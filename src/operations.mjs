// L1 无头操作层：把一次 op 调用翻译成
//   <godot> --headless --path <project> --script <ops.gd> <op> <json>
// 并解析回 @@GODOT_MCP@@ 协议结果。
//
// 契约见 DESIGN.md §2.1。本模块不含业务语义，只负责「调用 + 解析 + 归一化错误」。

import path from 'node:path';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import {
  PACKAGE_ROOT,
  RESULT_MARKER,
  engineHelperEnv,
  extractResult,
  godotPath,
  resolveProject,
  runProcess,
} from './godot.mjs';

/** ops.gd 是本层唯一入口；放在包内 godot/ 目录。 */
export const OPS_SCRIPT = path.join(PACKAGE_ROOT, 'godot', 'ops.gd');

/** 超过这个时长的 op 视为长任务（run_project / export_project 等），用更宽的超时。 */
const LONG_OPS = new Set(['run_project', 'export_project', 'import_assets', 'resave_resources', 'gdscript']);

/** 不需要项目的 op（纯引擎/工具类）。 */
const NO_PROJECT_OPS = new Set(['version']);

const DEFAULT_TIMEOUT_MS = 120_000;
const LONG_TIMEOUT_MS = 900_000;

/**
 * 新建项目里「先写带 class_name 的脚本，再 attach_script」是必经之路，但此时
 * `.godot/global_script_class_cache.cfg` 还不存在（项目从未被扫描过），于是脚本里
 * 引用的全局类全部解析失败，attach_script 报 "Could not find type X"。
 * 这不是用户的错，补一次 `--import` 重建类缓存就能好。
 *
 * 重试必须换一个新进程：全局类列表是引擎启动时从缓存文件载入的，同一个进程里
 * 就算是重新 load 也看不到新类。所以策略放在这一层（每次 op 都是新进程），
 * 而不是放进 ops.gd 里原地 reload。
 */
const CLASS_CACHE_RETRY_OPS = new Set(['attach_script']);
// 同一个病因（全局类没进缓存）有两种写法，实测都出现过：
//   · 类缓存里「有这个名字」但脚本加载不出来 → "Could not find type \"Pacman\" in the current scope."
//   · 缓存里压根没扫到过这个名字         → "Identifier \"Player\" not declared in the current scope."
// 只匹配前者的话，新建项目这条路径会漏掉一半。
const CLASS_CACHE_ERROR = /Could not find type|not declared in the current scope/i;

export class GodotOperationError extends Error {
  constructor(message, { op, code = 'GODOT_OP_FAILED', details } = {}) {
    super(message);
    this.name = 'GodotOperationError';
    this.op = op;
    this.code = code;
    this.details = details;
  }
}

/**
 * 执行一次无头 op（带「类缓存缺失」自愈）。
 *
 * 除 attach_script 的首次失败外，本函数不做任何隐式重试：失败就是失败。
 *
 * @param {string} op 操作名，见 DESIGN.md §2.1
 * @param {object} [params] 操作参数（会自动补上 project_path）
 * @param {{project?: string, cwd?: string, godot?: string, timeoutMs?: number, signal?: AbortSignal, defaultProject?: string}} [options]
 * @returns {Promise<{ok: true, op: string, data: unknown, durationMs: number, warnings?: string[], retriedAfterImport?: boolean}>}
 */
export async function runOperation(op, params = {}, options = {}) {
  try {
    return await runOperationOnce(op, params, options);
  } catch (error) {
    if (!CLASS_CACHE_RETRY_OPS.has(op) || !CLASS_CACHE_ERROR.test(String(error?.message ?? ''))) {
      throw error;
    }
    // 重建全局类缓存后原样重试一次；import 自己失败就照原样抛出最初的错误，
    // 免得用「import 的错误」盖掉真正的原因。
    try {
      await runOperationOnce('import_assets', {}, options);
    } catch {
      throw error;
    }
    const retried = await runOperationOnce(op, params, options);
    return { ...retried, retriedAfterImport: true };
  }
}

async function runOperationOnce(op, params = {}, options = {}) {
  if (typeof op !== 'string' || !op) {
    throw new GodotOperationError('op 必须是非空字符串', { op: String(op), code: 'BAD_OP' });
  }
  const binary = godotPath(options.godot);
  if (!binary) {
    throw new GodotOperationError(
      '找不到 Godot 可执行文件。设置 GODOT_MCP_GODOT / GODOT_PATH，或在 DSH 插件 config 里填 godotPath。',
      { op, code: 'GODOT_NOT_FOUND' },
    );
  }
  if (!existsSync(OPS_SCRIPT)) {
    throw new GodotOperationError(`找不到操作引擎脚本：${OPS_SCRIPT}`, { op, code: 'OPS_SCRIPT_MISSING' });
  }

  // 项目解析：run_project 等需要真实项目；纯工具类 op（version）不需要。
  let projectPath;
  const needsProject = !NO_PROJECT_OPS.has(op);
  if (needsProject) {
    projectPath = await resolveProject({
      project: options.project ?? params.project_path ?? params.project,
      cwd: options.cwd,
      defaultProject: options.defaultProject,
    });
  }

  const payload = { ...params };
  delete payload.project;
  if (projectPath) payload.project_path = projectPath;

  // Godot 在 `--path <不存在的目录>` 时会直接 "Invalid project path specified ... aborting"
  // 退出，连协议行都不会输出。create_project 的语义本来就是「把目录变成项目」，
  // 所以这里先把目标目录建出来，否则该 op 永远不可能成功。
  if (op === 'create_project' && projectPath) {
    await mkdirp(projectPath);
  }

  const args = ['--headless'];
  if (projectPath) args.push('--path', projectPath);
  args.push('--script', OPS_SCRIPT, op, JSON.stringify(payload ?? {}));

  const timeoutMs =
    options.timeoutMs ?? (LONG_OPS.has(op) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  let result;
  try {
    result = await runProcess(binary, args, {
      cwd: projectPath ?? options.cwd,
      timeoutMs,
      signal: options.signal,
      // ops.gd 的嵌套 op（导入/导出/run_project/deep parse_check）要自己起 Node helper。
      // 显式传递当前 Node 和 helper 的绝对路径，避免嵌套执行依赖 PATH 搜索。
      env: engineHelperEnv(),
    });
  } catch (error) {
    // 进程树回收结果要如实带出去：调用方需要知道「杀干净了没有」，
    // 而不是只知道「超时/取消了」。kill.ok=false 或 survivors 非空意味着可能有残留。
    const killDetail = error?.kill ? { kill: error.kill } : undefined;
    if (error?.code === 'TIMEOUT') {
      throw new GodotOperationError(`op ${op} 超时（${timeoutMs}ms）`, { op, code: 'TIMEOUT', details: { message: String(error.message), ...killDetail } });
    }
    if (error?.code === 'ABORTED') {
      throw new GodotOperationError(`op ${op} 已取消`, { op, code: 'ABORTED', details: killDetail });
    }
    throw new GodotOperationError(`启动 Godot 失败：${String(error?.message ?? error)}`, { op, code: 'SPAWN_FAILED' });
  }

  const parsed = extractResult(result.stdout) ?? extractResult(result.stderr);
  if (!parsed) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().slice(-3000);
    throw new GodotOperationError(
      `op ${op} 没有返回协议结果（exit=${result.exitCode}）。Godot 输出：\n${detail || '(空)'}`,
      { op, code: 'NO_PROTOCOL_RESULT', details: detail },
    );
  }
  if (parsed.ok !== true) {
    // 协议里 ok:false 是最常见的失败形态。但如果同一个 op 还伴随 GDScript 运行时错误
    // （ops.gd 里抛异常会被 _init 的安全网兜成 "returned without calling finish()"），
    // 那才是真正的根因 —— 把它一并带出来，否则排查会绕远路。
    const scriptError = extractScriptError(result.stderr) ?? extractScriptError(result.stdout);
    const message = String(parsed.error ?? `op ${op} 失败`);
    throw new GodotOperationError(
      scriptError ? `${message}\n[GDScript 根因] ${scriptError}` : message,
      {
        op,
        code: String(parsed.code ?? 'GODOT_OP_FAILED'),
        details: { ...parsed, ...(scriptError ? { scriptError } : {}) },
      },
    );
  }

  // ops.gd 的 run_project 等长任务有自带墙钟超时兜底：超时会以 exit=137 返回，
  // 这时**不能**当成成功 —— 它意味着目标程序被杀了，输出也不完整。
  if (result.exitCode === 137 && parsed.data?.timed_out === true) {
    throw new GodotOperationError(
      `op ${op} 被 ops.gd 的看门狗超时终止（timed_out=true，exit=137）。` +
        `已捕获输出：${String(parsed.data?.stdout ?? '').slice(-500) || '(空)'}`,
      { op, code: 'GODOT_WATCHDOG_TIMEOUT', details: parsed.data },
    );
  }

  return {
    ok: true,
    op,
    data: parsed.data ?? null,
    durationMs: result.durationMs,
    ...(parsed.warnings ? { warnings: parsed.warnings } : {}),
    ...(parsed.logs ? { logs: parsed.logs } : {}),
  };
}

/**
 * 从 Godot 输出里抽出 GDScript 运行时错误的首行（`SCRIPT ERROR: ...`）。
 * 用途：ops.gd 内部抛异常时，协议层只能看到兜底信息，真正根因在这里。
 * @param {string} text
 * @returns {string|undefined}
 */
export function extractScriptError(text) {
  const match = /^\s*(SCRIPT ERROR|Parse Error):\s*(.+)$/m.exec(String(text ?? ''));
  if (match) return `${match[1]}: ${match[2].trim()}`;
  const alt = /^\s*SCRIPT ERROR:\s*(.+)$/m.exec(String(text ?? ''));
  return alt ? `SCRIPT ERROR: ${alt[1].trim()}` : undefined;
}

/** 递归建目录（create_project 需要目标目录先存在）。 */async function mkdirp(target) {
  try {
    await fsp.mkdir(target, { recursive: true });
  } catch (error) {
    throw new GodotOperationError(`无法创建项目目录 ${target}：${String(error?.message ?? error)}`, {
      op: 'create_project',
      code: 'MKDIR_FAILED',
    });
  }
}

/** 供启动自检：确认 ops.gd 存在且 Godot 能跑它。 */export async function selfCheck(options = {}) {
  const scriptExists = existsSync(OPS_SCRIPT);
  if (!scriptExists) return { ok: false, error: `缺少 ${OPS_SCRIPT}` };
  try {
    const result = await runOperation('version', {}, { ...options, timeoutMs: 30_000 });
    return { ok: true, ...result.data, opsScript: OPS_SCRIPT };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), code: error?.code };
  }
}

export { RESULT_MARKER, resolveProject };
