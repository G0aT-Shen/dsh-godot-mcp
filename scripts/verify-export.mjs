#!/usr/bin/env node
// Native release export: closed by default, usable only after explicit opt-in.
// A crashed game must never count as evidence that the runtime port is closed.
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { godotPath, runProcess } from '../src/godot.mjs';
import { killTree } from '../src/proc-tree.mjs';
import { runOperation } from '../src/operations.mjs';
import { installBridge } from '../src/install.mjs';

const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(400, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
function evaluate(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let text = '';
    const timer = setTimeout(() => finish(new Error('rt.eval timed out')), 5000);
    const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.once('error', error => finish(error));
    socket.once('connect', () => socket.write(JSON.stringify({ id: 'gate', op: 'rt.eval', params: { source: 'return 6*7\n' } }) + '\n'));
    socket.on('data', chunk => {
      text += chunk;
      if (text.includes('\n')) {
        try { finish(null, JSON.parse(text.split('\n')[0])); } catch (error) { finish(error); }
      }
    });
  });
}
async function probe(binary, port, forced) {
  const env = { ...process.env, GODOT_MCP_RUNTIME_PORT: String(port) };
  // Explicitly remove inherited opt-in so the negative control is reproducible.
  delete env.GODOT_MCP_RUNTIME_FORCE;
  if (forced) env.GODOT_MCP_RUNTIME_FORCE = '1';
  const child = spawn(binary, ['--headless'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  let ended = false;
  let failure;
  let output = '';
  const closed = new Promise(resolve => child.once('close', resolve));
  child.once('error', error => { failure = error; });
  child.once('exit', () => { ended = true; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-16000); });
  try {
    const deadline = Date.now() + (forced ? 25000 : 10000);
    let sawOpen = false;
    do {
      if (failure || ended) throw failure ?? new Error(`Export exited early (${child.exitCode}): ${output}`);
      if (await portOpen(port)) {
        sawOpen = true;
        if (forced) {
          const reply = await evaluate(port);
          return { sawOpen, reply, output };
        }
        break;
      }
      await sleep(200);
    } while (Date.now() < deadline);
    if (failure || ended) throw failure ?? new Error(`Export exited early: ${output}`);
    return { sawOpen, output };
  } finally {
    if (child.pid) await killTree(child.pid, { force: true });
    let timer;
    try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Export process did not close after cleanup')), 8000); })]); }
    finally { clearTimeout(timer); }
  }
}
async function selfTest() {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try { record('探针识别真实监听端口', await portOpen(port)); }
  finally { await new Promise(resolve => server.close(resolve)); }
  record('探针识别关闭端口', !(await portOpen(port)));
}
async function main() {
  await selfTest();
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('This export acceptance script currently supports Windows and macOS');
  const windows = process.platform === 'win32';
  const godot = godotPath();
  if (!godot) throw new Error('Godot not found');
  const version = await runProcess(godot, ['--headless', '--version']);
  const match = version.stdout.match(/(\d+\.\d+(?:\.\d+)?)\.(stable|beta\d*|rc\d*)/);
  if (!match) throw new Error(`Cannot identify template version: ${version.stdout}`);
  const templateVersion = `${match[1]}.${match[2]}`;
  const dataRoot = windows
    ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
    : path.join(os.homedir(), 'Library', 'Application Support');
  const templateDir = path.join(dataRoot, 'Godot', 'export_templates', templateVersion);
  const template = path.join(templateDir, windows ? 'windows_release_x86_64.exe' : 'macos.zip');
  const available = await fsp.stat(template).then(stat => stat.isFile()).catch(() => false);
  record('当前引擎版本的原生 release 模板存在', available, template);
  if (!available) { process.exitCode = 2; return; }
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'Godot 导出 #1-'));
  try {
    await fsp.writeFile(path.join(project, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="ExportGate"\nrun/main_scene="res://main.tscn"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\ntextures/vram_compression/import_etc2_astc=true\n');
    await fsp.writeFile(path.join(project, 'main.tscn'), '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n');
    const installed = await installBridge(project);
    record('安装用于导出验收的运行时桥', installed.ok === true && installed.settings.autoload === true);
    if (!installed.ok) throw new Error(JSON.stringify(installed));
    const preset = windows ? 'Windows Desktop' : 'macOS';
    await fsp.writeFile(path.join(project, 'export_presets.cfg'), `[preset.0]\nname="Native"\nplatform="${preset}"\nrunnable=true\nadvanced_options=false\ndedicated_server=false\ncustom_features=""\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path=""\nscript_export_mode=2\n\n[preset.0.options]\nbinary_format/architecture="${windows ? 'x86_64' : 'universal'}"\n${windows ? 'codesign/enable=false\n' : 'application/bundle_identifier="com.example.exportgate"\ncodesign/codesign=0\nnotarization/notarization=0\n'}`);
    const artifact = path.join(project, 'dist', windows ? 'ExportGate.exe' : 'ExportGate.app');
    const exported = await runOperation('export_project', { preset: 'Native', output_path: artifact, debug: false }, { project, timeoutMs: 600000 });
    record('export_project 如实报告成功', exported.ok === true, exported.error ?? 'ok');
    const binary = windows ? artifact : path.join(artifact, 'Contents', 'MacOS', 'ExportGate');
    const exists = await fsp.stat(binary).then(stat => stat.isFile()).catch(() => false);
    record('原生导出程序真实存在', exists, binary);
    if (!exists || !exported.ok) throw new Error('Native release export failed');
    const port = await freePort();
    const plain = await probe(binary, port, false);
    record('release 持续运行 10 秒，全程未开放运行时端口', !plain.sawOpen, plain.output.slice(-500));
    const forced = await probe(binary, port, true);
    record('显式 opt-in 后运行时端口开放', forced.sawOpen);
    record('同一成品 rt.eval 返回 42', forced.reply?.ok === true && forced.reply?.data?.result === 42, forced.reply);
    record('验收后端口关闭', !(await portOpen(port)));
  } finally { await fsp.rm(project, { recursive: true, force: true }); }
}
main().catch(error => record('验收异常', false, error.stack ?? String(error))).finally(() => {
  const failed = results.filter(item => !item.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exitCode = process.exitCode || (failed.length ? 1 : 0);
});
