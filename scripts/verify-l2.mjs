#!/usr/bin/env node
// L2 编辑器桥集成测试：用**本项目自己的** Node WebSocket 客户端去连真实 Godot 编辑器插件。
//
// 为什么单独做这一步：bridge-layer 是用另一个 WebSocket 客户端验证的 addon，
// 而生产链路走的是 src/bridge.mjs 里手写的客户端。两者必须真的能通，否则
// godot_connect(target="editor") 在真实使用中就是坏的。
//
// 用法：node scripts/verify-l2.mjs [项目目录]
//   不传项目目录时自动在临时目录里造一个并装好桥。

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { GodotController } from '../src/server.mjs';
import { installBridge } from '../src/install.mjs';
import { probePort } from '../src/bridge.mjs';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}\n`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 轮询等端口就绪（Godot 编辑器启动可能要几秒）。 */
async function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort({ port, timeoutMs: 1000 })) return true;
    await sleep(500);
  }
  return false;
}

async function main() {
  let projectDir = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  let temporary = false;

  if (!projectDir) {
    projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-l2-'));
    temporary = true;
    await fsp.writeFile(
      path.join(projectDir, 'project.godot'),
      'config_version=5\n\n[application]\n\nconfig/name="L2Verify"\nrun/main_scene="res://main.tscn"\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(projectDir, 'main.tscn'),
      '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n\n[node name="Sprite" type="Sprite2D" parent="."]\n',
      'utf8',
    );
  }

  const controller = new GodotController({ cwd: projectDir });
  process.stdout.write(`项目：${projectDir}\n\n`);

  process.stdout.write('=== 安装桥 ===\n');
  const install = await installBridge(projectDir);
  record('installBridge 成功', install.ok === true, `copied=${install.copied?.length ?? 0}`);
  record('project.godot 启用插件', install.settings?.editorPlugins === true);

  process.stdout.write('\n=== 启动 headless 编辑器 ===\n');
  const session = await controller.session('editor', { project: projectDir, headless: true });
  record('编辑器会话已启动', session.ok === true, session.session?.id);
  if (!session.ok) return;

  const port = controller.editorPort;
  const up = await waitForPort(port);
  record(`编辑器桥监听 ${port}`, up, up ? 'listening' : '超时未监听');

  if (!up) {
    const logs = await controller.session('logs', { id: session.session.id, limit: 20_000 });
    process.stdout.write(`\n编辑器日志：\n${logs?.text?.slice(-3000) ?? '(无)'}\n`);
    return;
  }

  process.stdout.write('\n=== 通过本项目 Node 客户端调用 L2 ===\n');
  const info = await controller.bridge('editor', 'editor.info');
  record('editor.info', info.ok === true, info.ok ? `project=${info.data?.project_path ?? info.data?.projectPath ?? '-'}` : info.error);

  const tree = await controller.bridge('editor', 'editor.scene_tree', {});
  const treeText = JSON.stringify(tree.data ?? {});
  record('editor.scene_tree 能看到 Sprite 节点', tree.ok === true && treeText.includes('Sprite'), tree.ok ? `len=${treeText.length}` : tree.error);

  const added = await controller.bridge('editor', 'editor.add_node', {
    parent_path: '',
    type: 'Camera2D',
    name: 'McpCam',
  });
  record('editor.add_node 新增 Camera2D', added.ok === true, added.ok ? JSON.stringify(added.data).slice(0, 160) : added.error);

  const tree2 = await controller.bridge('editor', 'editor.scene_tree', {});
  record('新增节点出现在场景树里', tree2.ok === true && JSON.stringify(tree2.data).includes('McpCam'), tree2.ok ? 'found' : tree2.error);

  const settings = await controller.bridge('editor', 'editor.set_property', {
    node_path: 'Sprite',
    property: 'position',
    value: { x: 12, y: 34 },
  });
  record('editor.set_property 写 Vector2', settings.ok === true, settings.ok ? JSON.stringify(settings.data).slice(0, 160) : settings.error);

  const executed = await controller.bridge('editor', 'editor.execute', {
    source: 'return {"engine": Engine.get_version_info()["string"], "nodes": get_tree().get_node_count()}\n',
  });
  record('editor.execute 逃生舱', executed.ok === true, executed.ok ? JSON.stringify(executed.data).slice(0, 200) : executed.error);

  const saved = await controller.bridge('editor', 'editor.save_scene', {});
  record('editor.save_scene', saved.ok === true, saved.ok ? JSON.stringify(saved.data).slice(0, 120) : saved.error);

  process.stdout.write('\n=== 错误路径 ===\n');
  const badOp = await controller.bridge('editor', 'editor.no_such_op', {});
  record('未知 op 返回 ok:false', badOp.ok === false, badOp.error?.slice(0, 100));

  process.stdout.write('\n=== 收尾 ===\n');
  const stopped = await controller.session('stop', { kind: 'editor' });
  record('编辑器会话已停止', stopped.ok === true, JSON.stringify(stopped.stopped?.[0] ?? stopped).slice(0, 160));

  if (temporary) await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => {});
}

main()
  .catch(error => record('链路异常中断', false, String(error?.stack ?? error)))
  .finally(() => {
    const failed = results.filter(result => !result.ok);
    process.stdout.write(`\n=== 汇总 ===\n通过 ${results.length - failed.length}/${results.length}\n`);
    for (const item of failed) process.stdout.write(`  - ${item.name}: ${JSON.stringify(item.detail)}\n`);
    process.exitCode = failed.length ? 1 : 0;
  });
