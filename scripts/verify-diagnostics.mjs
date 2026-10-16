#!/usr/bin/env node
// 诊断质量验收：这三项都是「一次真实踩坑」换来的，所以每条断言都对应一个
// 真机场景，而不是静态检查。
//
//   1. parse_check 的级联归属：一个脚本加载失败，往往是被它依赖的脚本连累的。
//      修之前，N 个受影响文件会报出 N 条一模一样的错误（实测 5 个文件全报
//      board.gd 的同一行），真正的源文件淹没在里面。
//   2. attach_script 的自愈：新建项目从未被扫描过，全局类缓存不存在，于是
//      「先写带 class_name 的脚本，再挂脚本」必然报 Could not find type X。
//   3. run_project 的显示模式：默认 headless，没有帧缓冲 —— 不显式回给调用方
//      就会有人拿它去截图，然后收获一个永久挂起。
//
// 用法：
//   node scripts/verify-diagnostics.mjs           # 跑完清理临时项目
//   node scripts/verify-diagnostics.mjs --keep    # 保留临时目录便于排查

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { GodotController } from '../src/server.mjs';

const keep = process.argv.includes('--keep');
const results = [];
const tempDirs = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const icon = ok ? '✔' : '✖';
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  process.stdout.write(`${icon} ${name}${suffix}\n`);
}

function section(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

async function makeProject(label, controller) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `godot-mcp-${label}-`));
  tempDirs.push(dir);
  const created = await controller.op('create_project', { project_path: dir, name: `Diag ${label}` });
  if (created.ok !== true) throw new Error(`create_project 失败：${created.error}`);
  return dir;
}

// 复刻当初真实踩到的那条错误：未类型化 const 数组让 `var x := arr[i][j]` 无法推断。
const BROKEN_BASE = `class_name Base
extends RefCounted

const ROWS := ["ab", "cd"]


static func at(index: int) -> String:
	var c := ROWS[index][0]
	return c
`;

const DEPENDENT = name => `extends Node

## 只引用 Base，自己没有任何语法问题。
func probe() -> String:
	return Base.at(0)

func tag() -> String:
	return "${name}"
`;

async function checkParseCascade(controller) {
  section('1. parse_check 级联归属');
  const dir = await makeProject('cascade', controller);

  const basePath = path.join(dir, 'base.gd');
  await fsp.writeFile(basePath, BROKEN_BASE);
  const depPaths = [];
  for (let i = 1; i <= 4; i++) {
    const p = path.join(dir, `dep${i}.gd`);
    await fsp.writeFile(p, DEPENDENT(`dep${i}`));
    depPaths.push(p);
  }

  // 先建类缓存，否则依赖方会报 "Could not find type Base"，
  // 那是另一种级联，测不到「依赖方复述被依赖方的错」这一条。
  const imported = await controller.op('import_assets', {}, { project: dir });
  record('import_assets 建出全局类缓存', imported.ok === true, imported.ok ? imported.data : imported.error);
  const cacheFile = path.join(dir, '.godot', 'global_script_class_cache.cfg');
  record('类缓存文件确实存在（前置条件）', await exists(cacheFile), cacheFile);

  const paths = ['res://base.gd', ...depPaths.map((_, i) => `res://dep${i + 1}.gd`)];
  const checked = await controller.op('parse_check', { paths, deep: true }, { project: dir });
  if (checked.ok !== true) {
    record('parse_check 返回结果', false, checked.error);
    return;
  }
  const errors = checked.data.errors ?? [];
  const primary = errors.filter(e => e.cascade !== true);
  const cascaded = errors.filter(e => e.cascade === true);

  record(
    '5 个请求文件只报出 1 条真错（修前是 5 条重复）',
    errors.length === 1,
    `unique=${checked.data.unique_errors} cascade=${checked.data.cascade_errors} errors=${JSON.stringify(errors).slice(0, 400)}`,
  );
  record(
    '该错误归属到真正的源文件 base.gd，而不是被连累的 dep*.gd',
    primary.length === 1 && primary[0].path === 'res://base.gd' && primary[0].origin === 'res://base.gd',
    primary[0] ? `path=${primary[0].path} origin=${primary[0].origin}` : '(没有主错误)',
  );
  record(
    '错误行号指向 base.gd 里真正有问题的那一行（8）',
    primary[0]?.line === 8,
    primary[0]?.line,
  );
  record(
    '主错误排在第 1 条（调用方读第一条就是该修的文件）',
    errors[0]?.cascade === false && errors[0]?.path === 'res://base.gd',
    errors[0] ? `${errors[0].path} cascade=${errors[0].cascade}` : '(空)',
  );
  record(
    'deep 模式下 5 个文件都被真编译，affects 记全',
    Array.isArray(primary[0]?.affects) && primary[0].affects.length === 5,
    primary[0]?.affects,
  );
  record('没有把被连累的文件误标成独立错误', cascaded.length === 0, `cascaded=${cascaded.length}`);

  // 反向对照：给 dep1 塞一个它自己的、与 Base 无关的错，必须单独成条。
  await fsp.writeFile(path.join(dir, 'dep1.gd'), `${DEPENDENT('dep1')}
const OOPS := [1, 2]


func own() -> int:
	var v := OOPS[0][0]
	return v
`);
  const twice = await controller.op('parse_check', { paths, deep: true }, { project: dir });
  const twiceErrors = twice.data?.errors ?? [];
  const baseEntry = twiceErrors.find(e => e.path === 'res://base.gd');
  const ownEntries = twiceErrors.filter(e => e.path === 'res://dep1.gd');
  record(
    'dep1 自己的错与 base.gd 的错分开报（不误合并）',
    baseEntry !== undefined && ownEntries.length >= 1 && ownEntries.every(e => e.cascade === false),
    JSON.stringify(twiceErrors.map(e => ({ path: e.path, line: e.line, cascade: e.cascade }))),
  );
  record(
    'base.gd 那条仍然只有一条（dep1 的错没有把它拆成两份）',
    twiceErrors.filter(e => e.path === 'res://base.gd').length === 1,
    `base entries=${twiceErrors.filter(e => e.path === 'res://base.gd').length}`,
  );
}

async function checkAttachSelfHeal(controller) {
  section('2. attach_script 在未扫描过的新项目上自愈');
  const dir = await makeProject('attach', controller);

  await fsp.writeFile(path.join(dir, 'player.gd'), `class_name Player
extends Node2D

var speed := 10.0
`);
  await fsp.writeFile(path.join(dir, 'main.gd'), `extends Node2D

## 引用全局类 Player —— 类缓存没建起来时这一行就解析不过。
func _ready() -> void:
	var p := Player.new()
	p.speed = 20.0
	add_child(p)
`);

  const scene = await controller.op('create_scene', {
    scene_path: 'res://main.tscn',
    root_type: 'Node2D',
    root_name: 'Main',
  }, { project: dir });
  record('create_scene', scene.ok === true, scene.ok ? scene.data : scene.error);

  const cacheFile = path.join(dir, '.godot', 'global_script_class_cache.cfg');
  const cacheBefore = await exists(cacheFile);
  record(
    '前置条件：此刻还没有全局类缓存（否则测不到这条路径）',
    cacheBefore === false,
    cacheFile,
  );

  const attached = await controller.op('attach_script', {
    scene_path: 'res://main.tscn',
    node_path: '.',
    script_path: 'res://main.gd',
  }, { project: dir, timeoutMs: 300_000 });

  record('attach_script 成功（修前这里报 Could not find type Player）', attached.ok === true, attached.ok ? attached.data : attached.error);
  record(
    '并且明确告知是靠补 import 自愈的',
    attached.ok === true && attached.retriedAfterImport === true,
    `retriedAfterImport=${attached.retriedAfterImport}`,
  );

  // 自愈之后场景里真的挂上了脚本，而不是只回了个 ok。
  const sceneBack = await controller.op('read_scene', { scene_path: 'res://main.tscn' }, { project: dir });
  const tree = sceneBack.data?.tree ?? {};
  record(
    '重读场景确认脚本已落在场景根上',
    sceneBack.ok === true && String(tree.properties?.script ?? '').includes('main.gd'),
    JSON.stringify(tree.properties ?? {}).slice(0, 200),
  );
}

async function checkRunProjectDisplay(controller) {
  section('3. run_project 显式回报显示模式');
  const dir = await makeProject('display', controller);
  await controller.op('create_scene', {
    scene_path: 'res://main.tscn',
    root_type: 'Node2D',
    root_name: 'Main',
  }, { project: dir });
  await controller.op('write_settings', { settings: { 'application/run/main_scene': 'res://main.tscn' } }, { project: dir });

  const headless = await controller.op('run_project', { headless: true, quit_after: 2 }, { project: dir, timeoutMs: 120_000 });
  record('headless 运行返回 display=dummy', headless.ok === true && headless.data?.display === 'dummy', headless.ok ? `display=${headless.data?.display}` : headless.error);
  record(
    'headless 运行附带「没有帧缓冲、截图请改用会话」的提示',
    /framebuffer/i.test(String(headless.data?.note ?? '')) && /godot_session/.test(String(headless.data?.note ?? '')),
    headless.data?.note,
  );

  const windowed = await controller.op('run_project', { headless: false, quit_after: 2 }, { project: dir, timeoutMs: 120_000 });
  record(
    'headless:false 走窗口路径并回报 display=window',
    windowed.ok === true && windowed.data?.display === 'window' && windowed.data?.note === undefined,
    windowed.ok ? `display=${windowed.data?.display} exit=${windowed.data?.exit_code}` : windowed.error,
  );
}

/**
 * 4. 嵌套助手脚本的目录选择。
 *
 * 真机踩到过：`user://` 不可写（沙箱化 agent / 只读 HOME / CI 容器）时，旧实现只回一句
 * "cannot create helper script <路径>"，于是 deep parse_check 报「0 个错误」——
 * 等于告诉调用方「代码是干净的」，而实际上一个文件都没被检查过。
 *
 * 两条断言都带**前置探针**：先确认那个目录真的写不进去，否则整段就是空转。
 */
async function checkHelperDirs(controller) {
  section('4. 嵌套助手脚本目录');
  if (process.platform !== 'darwin') {
    process.stdout.write('ℹ 非 macOS：user:// 布局不同，本节跳过（未验证，不当作通过）\n');
    return;
  }

  const dir = await makeProject('helper', controller);
  await fsp.writeFile(
    path.join(dir, 'broken.gd'),
    'extends Node\n\nfunc _ready() -> void:\n\tvar x: int = \n',
  );
  const paths = ['res://broken.gd'];
  const userDir = path.join(
    os.homedir(), 'Library', 'Application Support', 'Godot', 'app_userdata', 'Diag helper', 'mcp_tmp',
  );
  await fsp.mkdir(userDir, { recursive: true });

  // A. user:// 不可写 → 必须自己换目录并照样给出结论
  const baseline = await controller.op('parse_check', { paths, deep: true }, { project: dir });
  record(
    '前置条件：基线能查出这个语法错（否则后面的断言没有意义）',
    baseline.ok === true && (baseline.data?.unique_errors ?? 0) > 0,
    baseline.ok ? `unique_errors=${baseline.data?.unique_errors}` : baseline.error,
  );

  await fsp.chmod(userDir, 0o500);
  try {
    const blocked = await fsp
      .writeFile(path.join(userDir, 'write-probe'), 'x')
      .then(() => false, () => true);
    record('前置探针：user:// 的 mcp_tmp 此刻确实不可写', blocked === true, userDir);

    const degraded = await controller.op('parse_check', { paths, deep: true }, { project: dir });
    record(
      'user:// 不可写时 deep parse_check 仍出结论（自动换到系统临时目录）',
      degraded.ok === true && (degraded.data?.unique_errors ?? 0) > 0,
      degraded.ok
        ? `unique_errors=${degraded.data?.unique_errors}（基线 ${baseline.data?.unique_errors}）`
        : degraded.error,
    );
  } finally {
    await fsp.chmod(userDir, 0o700).catch(() => {});
  }

  // B. 显式指定的目录不可写 → 必须报错，绝不允许返回「0 个错误」
  const readonly = await fsp.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-ro-'));
  tempDirs.push(readonly);
  await fsp.chmod(readonly, 0o500);
  const previous = process.env.GODOT_MCP_HELPER_DIR;
  process.env.GODOT_MCP_HELPER_DIR = readonly;
  try {
    const loud = await controller.op('parse_check', { paths, deep: true }, { project: dir });
    record(
      '显式目录不可写时，deep parse_check 报错而不是假报「没有错误」',
      loud.ok === false && String(loud.error).includes('GODOT_MCP_HELPER_DIR'),
      loud.ok
        ? `ok=true（危险：返回了 ${JSON.stringify(loud.data).slice(0, 140)}）`
        : String(loud.error).slice(0, 220),
    );

    const run = await controller.op('run_project', { quit_after: 2 }, { project: dir });
    record(
      '同一个坏目录下 run_project 的失败是可行动的（说清原因与修法）',
      run.ok === false && String(run.error).includes('GODOT_MCP_HELPER_DIR'),
      run.ok ? `ok=true exit=${run.data?.exit_code}` : String(run.error).slice(0, 220),
    );
  } finally {
    if (previous === undefined) delete process.env.GODOT_MCP_HELPER_DIR;
    else process.env.GODOT_MCP_HELPER_DIR = previous;
    await fsp.chmod(readonly, 0o700).catch(() => {});
  }
}

/**
 * 4. 「检查没跑完」不能被报成「代码是干净的」。
 *
 * parse_check(deep) 对每个可疑文件真跑一次 `--check-only`。旧实现只看 stderr：
 * 如果那次嵌套检查**超时/异常退出**（exit 137、timed_out、孤儿进程），
 * 它会认为「没有错误」→ 调用方拿到 `errors: []`，把不可信的结论当成干净代码。
 *
 * 这里用**确定性**的方式触发同一类分支：故意造出超过 NESTED_CHECK_ATTEMPTS(25) 的
 * 可疑文件，让后续文件走「attempt cap」这条「检查没跑完」的路径，断言：
 *   · 这些文件被显式记为 check_failed；
 *   · 顶层 incomplete 为 true，checks_failed 计数正确；
 *   · 不会被伪装成 0 errors。
 */
async function checkUntrustedChecksAreNotReportedClean(controller) {
  section('4. 检查没跑完时不能谎报「没有错误」');
  const dir = await makeProject('untrusted', controller);
  const total = 28; // > NESTED_CHECK_ATTEMPTS(25)
  for (let index = 0; index < total; index += 1) {
    await fsp.writeFile(
      path.join(dir, `broken_${index}.gd`),
      `extends Node\n\nfunc broken_${index}( -> void:\n\tpass\n`,
      'utf8',
    );
  }
  const result = await controller.op('parse_check', { deep: true }, { project: dir, timeoutMs: 600_000 });
  const data = result.data ?? {};
  record(
    'deep parse_check 真的执行了',
    result.ok === true,
    result.ok ? `checked=${data.checked}` : result.error,
  );
  record(
    '超过尝试上限的文件被显式标为 check_failed（而不是当作干净）',
    Array.isArray(data.errors) && data.errors.some(item => item.check_failed === true),
    `errors=${(data.errors ?? []).length} checks_failed=${data.checks_failed}`,
  );
  record(
    '顶层 incomplete=true 且 checks_failed>0',
    data.incomplete === true && Number(data.checks_failed) > 0,
    `incomplete=${data.incomplete} checks_failed=${data.checks_failed}`,
  );
  record(
    '结果里没有任何「假装干净」的空间：errors 非空',
    Array.isArray(data.errors) && data.errors.length > 0,
    `unique_errors=${data.unique_errors}`,
  );
}

async function exists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const controller = new GodotController({ cwd: process.cwd() });

  section('0. 环境自检');
  const status = await controller.probe();
  record('Godot 可执行文件可用', status.godot?.ok === true, status.godot?.version ?? status.godot?.error);
  record('无头操作引擎可用', status.opsEngine?.ok === true, status.opsEngine?.error);
  if (!status.ok) {
    process.stdout.write('\n环境没准备好，后续步骤跳过。\n');
    return;
  }

  await checkParseCascade(controller);
  await checkAttachSelfHeal(controller);
  await checkRunProjectDisplay(controller);
  await checkHelperDirs(controller);
  await checkUntrustedChecksAreNotReportedClean(controller);
}

main()
  .catch(error => {
    record('链路异常中断', false, String(error?.stack ?? error));
  })
  .finally(async () => {
    const failed = results.filter(result => !result.ok);
    process.stdout.write(`\n=== 汇总 ===\n通过 ${results.length - failed.length}/${results.length}\n`);
    if (failed.length) {
      process.stdout.write('失败项：\n');
      for (const item of failed) process.stdout.write(`  - ${item.name}: ${JSON.stringify(item.detail)}\n`);
    }
    for (const dir of tempDirs) {
      if (keep) process.stdout.write(`临时项目保留在：${dir}\n`);
      else await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    process.exitCode = failed.length ? 1 : 0;
  });
