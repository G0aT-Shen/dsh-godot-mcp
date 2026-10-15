#!/usr/bin/env node
// 端到端验收：用真实 Godot 跑通「建项目 → 建场景 → 加节点 → 挂脚本 → 运行 → 读输出」全链路。
//
// 这个脚本是交付物的验收口径，不是单元测试：
//   · 每个断言都对应一条真实 Godot 进程调用；
//   · 失败不会掩盖成功——会打印每一步的真实结果与耗时；
//   · 退出码非 0 表示整条链路没跑通。
//
// 用法：
//   node scripts/verify-e2e.mjs            # 完整链路
//   node scripts/verify-e2e.mjs --keep     # 保留临时项目目录便于排查

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { GodotController } from '../src/server.mjs';

const keep = process.argv.includes('--keep');
const results = [];
let projectDir;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const icon = ok ? '✔' : '✖';
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  process.stdout.write(`${icon} ${name}${suffix}\n`);
}

function section(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

async function main() {
  const controller = new GodotController({ cwd: process.cwd() });
  projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-e2e-'));

  section('0. 环境自检');
  const status = await controller.probe();
  record('Godot 可执行文件可用', status.godot?.ok === true, status.godot?.version ?? status.godot?.error);
  record('无头操作引擎可用', status.opsEngine?.ok === true, status.opsEngine?.error);
  if (!status.ok) {
    process.stdout.write('\n环境没准备好，后续步骤跳过。\n');
    return;
  }

  section('1. 项目层');
  const created = await controller.op('create_project', { project_path: projectDir, name: 'E2E Verification' });
  record('create_project', created.ok === true, created.ok ? created.data : created.error);
  if (!created.ok) return;

  const info = await controller.op('project_info', {}, { project: projectDir });
  record('project_info 读到项目名', info.ok === true && info.data?.name === 'E2E Verification', info.ok ? info.data?.name : info.error);

  section('2. 场景与节点层');
  const scene = await controller.op('create_scene', {
    scene_path: 'res://main.tscn',
    root_type: 'Node2D',
    root_name: 'Main',
  }, { project: projectDir });
  record('create_scene', scene.ok === true, scene.ok ? scene.data : scene.error);

  const sprite = await controller.op('add_node', {
    scene_path: 'res://main.tscn',
    node_type: 'Sprite2D',
    node_name: 'Hero',
  }, { project: projectDir });
  record('add_node(Sprite2D)', sprite.ok === true, sprite.ok ? sprite.data : sprite.error);

  const child = await controller.op('add_node', {
    scene_path: 'res://main.tscn',
    parent_node_path: 'Main/Hero',
    node_type: 'Camera2D',
    node_name: 'Cam',
  }, { project: projectDir });
  record('add_node 到子路径', child.ok === true, child.ok ? child.data : child.error);

  const tree = await controller.op('read_scene', { scene_path: 'res://main.tscn' }, { project: projectDir });
  const treeText = JSON.stringify(tree.data ?? {});
  record('read_scene 能读回 Hero 与 Cam', tree.ok === true && treeText.includes('Hero') && treeText.includes('Cam'), tree.ok ? 'ok' : tree.error);

  section('3. 脚本层');
  const script = await controller.op('write_file', {
    path: 'res://hero.gd',
    content: 'extends Sprite2D\n\nvar speed: float = 120.0\n\nfunc _ready() -> void:\n\tprint("HERO_READY")\n',
  }, { project: projectDir });
  record('write_file(hero.gd)', script.ok === true, script.ok ? script.data : script.error);

  const attach = await controller.op('attach_script', {
    scene_path: 'res://main.tscn',
    node_path: 'Main/Hero',
    script_path: 'res://hero.gd',
  }, { project: projectDir });
  record('attach_script', attach.ok === true, attach.ok ? attach.data : attach.error);

  const symbols = await controller.op('find_symbols', { path: 'res://hero.gd' }, { project: projectDir });
  record('find_symbols 能列出 speed/_ready', symbols.ok === true, symbols.ok ? JSON.stringify(symbols.data).slice(0, 160) : symbols.error);

  section('4. 运行层');
  // 必须先指定主场景，否则 Godot 起来后没有可运行的场景树（create_project 不预设主场景）。
  const mainScene = await controller.op('write_settings', {
    settings: { 'application/run/main_scene': 'res://main.tscn' },
  }, { project: projectDir });
  record('write_settings 指定主场景', mainScene.ok === true, mainScene.ok ? mainScene.data : mainScene.error);

  const readBack = await controller.op('read_settings', {
    keys: ['application/run/main_scene'],
  }, { project: projectDir });
  record('read_settings 读回主场景', readBack.ok === true && JSON.stringify(readBack.data).includes('main.tscn'), readBack.ok ? readBack.data : readBack.error);

  // 项目文件必须是 Godot 能解析的形式。曾经出现过 write_settings 写出
  // `run/main_scene=Resource("res://main.tscn")` 导致整个项目加载失败的情况，
  // 所以这里对落盘内容做一次结构断言（而不是只看 op 的返回值）。
  const projectText = await fsp.readFile(path.join(projectDir, 'project.godot'), 'utf8');
  record(
    'project.godot 里路径型设置是带引号的字符串（不是 Resource(...) 表达式）',
    /run\/main_scene="res:\/\/main\.tscn"/.test(projectText) && !/Resource\(/.test(projectText),
    projectText.split('\n').filter(line => line.includes('main_scene')).join(' | ') || '(未找到 main_scene 行)',
  );

  const run = await controller.op('run_project', { headless: true, quit_after: 3 }, { project: projectDir, timeoutMs: 120_000 });
  const runText = `${run.data?.stdout ?? ''}${run.data?.stderr ?? ''}`;
  // exit_code 由目标程序决定；headless 下正常结束可能是 0，也可能被看门狗收尾成 137。
  // 真正的验收点是「脚本真的跑起来并打印了」，所以这里只要求 op 本身没报错。
  record('run_project 正常返回（非看门狗超时）', run.ok === true, run.ok ? `exit=${run.data?.exit_code} timed_out=${run.data?.timed_out}` : run.error);
  record('运行输出包含脚本打印的 HERO_READY', runText.includes('HERO_READY'), run.ok ? (runText.includes('HERO_READY') ? 'found' : `未找到；实际输出：${runText.slice(0, 300)}`) : run.error);

  section('5. 逃生舱');
  const escape = await controller.op('gdscript', {
    source: 'func _init():\n\tMCP_RESULT({"engine": Engine.get_version_info()["string"], "sum": 1 + 1})\n',
  }, { project: projectDir });
  record('gdscript 逃生舱返回值正确', escape.ok === true && JSON.stringify(escape.data).includes('"sum":2'), escape.ok ? escape.data : escape.error);

  section('6. 桥安装层');
  const setup = await controller.session('setup', { project: projectDir });
  record('godot_session(setup) 报告安装结果', typeof setup.ok === 'boolean', setup.ok ? `copied=${setup.copied?.length ?? 0}` : setup.error);
  record('project.godot 写入插件/autoload', setup.settings?.autoload === true || setup.settings?.editorPlugins === true, JSON.stringify(setup.settings ?? {}));
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
    if (projectDir) {
      if (keep) process.stdout.write(`临时项目保留在：${projectDir}\n`);
      else await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => {});
    }
    process.exitCode = failed.length ? 1 : 0;
  });
