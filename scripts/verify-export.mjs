#!/usr/bin/env node
// release 导出验收：证明「导出的成品里不带无鉴权控制端口」。
//
// 背景（Lead 发现的安全缺陷）：
//   L3 运行时桥原来在 _ready() 里无条件监听 127.0.0.1:9091，而 rt.eval 等于任意代码执行。
//   于是用 godot_session(action="setup") 装过桥的项目，一旦 release 导出，
//   成品游戏就会带着一个无鉴权的本地控制端口 —— 等于自带后门。
//
// 本脚本验收两件事，缺一不可：
//   A. release 导出的成品运行起来后，9091 **不监听**（门控生效）；
//   B. 显式 opt-in（GODOT_MCP_RUNTIME_FORCE=1）时，同一个成品能连上（证明是门控而不是功能坏了）。
//
// 依赖：导出模板已装在 ~/Library/Application Support/Godot/export_templates/<ver>。
// 用法：node scripts/verify-export.mjs [项目目录]

import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { godotPath, PACKAGE_ROOT } from '../src/godot.mjs';
import { runOperation } from '../src/operations.mjs';
import { installBridge } from '../src/install.mjs';


const RUNTIME_PORT = Number(process.env.GODOT_MCP_RUNTIME_PORT ?? 9091);

/** 连上 9091 执行一次 rt.eval 的小探针（独立 node 进程，模拟「外部攻击者/客户端」）。 */
const EVAL_PROBE_JS = `const net=require("net");const s=net.connect(${RUNTIME_PORT},"127.0.0.1");
s.on("connect",()=>s.write(JSON.stringify({id:"v",op:"rt.eval",params:{source:"return 6*7\\n"}})+"\\n"));
let b="";s.on("data",d=>{b+=d;if(b.includes("\\n")){process.stdout.write(b.trim());s.destroy();}});
s.on("error",e=>{process.stdout.write("ERR "+e.message)});
setTimeout(()=>s.destroy(),5000);`;
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}\n`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 真实 TCP 探测。 */
function portOpen(port, timeoutMs = 1200) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = value => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/**
 * 轮询探测端口状态。
 *
 * 两个方向的语义必须分开，否则会得到**假通过**（我踩过这个坑）：
 *   · wantOpen=true  ：一旦观测到打开即可提前返回成功；
 *   · wantOpen=false ：必须**观察满整个时间窗**，只有「从头到尾都没打开过」才算成功。
 *     若写成「观测到关闭就返回成功」，那么进程还没启动完的那一瞬间就满足了条件，
 *     于是永远通过 —— 门控到底有没有生效根本测不出来。
 * @returns {{matched: boolean, sawOpen: boolean}}
 */
async function waitForPort(port, { wantOpen, timeoutMs = 25_000 }) {
  const deadline = Date.now() + timeoutMs;
  let sawOpen = false;
  for (;;) {
    if (await portOpen(port)) sawOpen = true;
    if (wantOpen && sawOpen) return { matched: true, sawOpen };
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(400, remaining));
  }
  return { matched: wantOpen ? sawOpen : !sawOpen, sawOpen };
}

/**
 * 启动一个**长驻**进程，边跑边探测端口，然后杀掉。
 *
 * 教训（Lead 实测踩过）：不要用 `--quit-after 600` 之类的小帧数去限制运行时间 ——
 * 无头模式下 Godot 帧率不受限，600 帧远不到 1 秒就跑完退出，之后再探测端口
 * 会得到「没监听」的**假阴性**，从而误判门控生效。所以这里让进程长驻，
 * 用轮询探测，测完显式 SIGKILL 整个进程组。
 *
 * @param {{command: string, args: string[], env?: object, cwd?: string}} spec
 * @param {{wantOpen: boolean, timeoutMs: number}} probe
 */
async function probeWhileRunning(spec, probe, whileRunning) {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
  });
  try {
    const outcome = await waitForPort(RUNTIME_PORT, probe);
    // whileRunning 在**进程仍存活时**执行，用于「端口已开 → 立刻连上去试功能」这类补充验证。
    // 必须在这里做：等 probeWhileRunning 返回后再做就没机会了，那时进程已被 kill。
    let extra;
    if (outcome.matched && typeof whileRunning === 'function') extra = await whileRunning();
    return { ...outcome, extra, pid: child.pid, stdout, exitedEarly: child.exitCode !== null };
  } finally {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
    await sleep(300);
  }
}

/** 启动一个进程并在结束后返回其输出。 */
function runDetached(command, args, { env, timeoutMs = 30_000, cwd } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 探针自检：证明「不监听」这个判定**不是空转**。
 *
 * 动机：一个永远返回「未监听」的检查会让门控验收变成假通过。
 * 所以这里先起一个真实的 TCP 监听，确认：
 *   · waitForPort(wantOpen=false) 在端口**真的开着**时必须返回 matched:false；
 *   · waitForPort(wantOpen=true) 在端口开着时必须返回 matched:true。
 * 两条都成立，后面的 A/B 验收才有意义。
 */
async function selfTestProbe() {
  const server = net.createServer(() => {});
  await new Promise(resolve => server.listen(RUNTIME_PORT, '127.0.0.1', resolve));
  try {
    const negative = await waitForPort(RUNTIME_PORT, { wantOpen: false, timeoutMs: 2_000 });
    record(
      '探针自检：端口确实开着时，「不监听」判定必须失败（否则验收是空转）',
      negative.matched === false,
      negative.matched ? '探针把开着的端口判成了未监听 —— 验收结论不可信！' : '已正确识别为「开着」',
    );
    const positive = await waitForPort(RUNTIME_PORT, { wantOpen: true, timeoutMs: 2_000 });
    record('探针自检：端口开着时，「监听」判定成功', positive.matched === true, String(positive.matched));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}


async function main() {
  // 先证明探针本身可信，再谈门控结论
  await selfTestProbe();

  const godot = godotPath();
  if (!godot) {
    record('找不到 Godot', false);
    return;
  }

  // 0. 模板必须已安装，否则导出必然失败 —— 明确区分「没测」和「测了失败」
  const templatesRoot = path.join(os.homedir(), 'Library', 'Application Support', 'Godot', 'export_templates');
  let installed;
  try {
    installed = await fsp.readdir(templatesRoot);
  } catch {
    installed = [];
  }
  const usable = [];
  for (const entry of installed) {
    const dir = path.join(templatesRoot, entry);
    const files = await fsp.readdir(dir).catch(() => []);
    if (files.some(file => file.endsWith('.zip'))) usable.push(entry);
  }
  record('导出模板已安装', usable.length > 0, usable.join(', ') || `在 ${templatesRoot} 没找到任何模板`);
  if (!usable.length) {
    process.stdout.write('\n结论：**无法验证**（缺导出模板）。这不是「验证失败」，而是「未验证」，请勿当成通过。\n');
    process.exitCode = 2;
    return;
  }

  // 1. 准备一个最小项目（若未指定就临时造一个，保证脚本可独立运行）
  let projectDir = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  let temporary = false;
  if (!projectDir) {
    temporary = true;
    projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-export-'));
    await fsp.writeFile(
      path.join(projectDir, 'project.godot'),
      'config_version=5\n\n[application]\n\nconfig/name="ExportGate"\nrun/main_scene="res://main.tscn"\n',
      'utf8',
    );
    await fsp.writeFile(path.join(projectDir, 'main.tscn'), '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n', 'utf8');
  }
  process.stdout.write(`\n项目：${projectDir}\n\n`);

  // 2. 装桥（这一步会把 autoload 写进 project.godot —— 正是会打进导出的东西）
  const install = await installBridge(projectDir);
  record('桥已安装（autoload 指向 runtime 脚本）', install.ok === true && install.settings.autoload === true);

  // 3. 写导出 preset（不存在时）
  const presetPath = path.join(projectDir, 'export_presets.cfg');
  try {
    await fsp.stat(presetPath);
  } catch {
    await fsp.writeFile(
      presetPath,
      `[preset.0]

name="macOS"
platform="macOS"
runnable=true
advanced_options=false
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path=""
encryption_include_filters=""
encryption_exclude_filters=""
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.0.options]

binary_format/architecture="universal"
application/bundle_identifier="com.example.exportgate"
application/signature=""
codesign/codesign=0
notarization/notarization=0
`,
      'utf8',
    );
  }

  // 3.5 真机踩到的前置条件：macOS universal/arm64 导出要求启用 ETC2 ASTC 纹理导入，
  //     否则 Godot 直接以 "configuration errors" 拒绝导出。用本项目自己的
  //     write_settings op 设置它（顺便验证了这个 op 在真实流程里可用）。
  const required = await runOperation(
    'write_settings',
    { settings: { 'rendering/textures/vram_compression/import_etc2_astc': true } },
    { project: projectDir },
  );
  record(
    '启用 ETC2 ASTC（macOS universal 导出的前置条件）',
    required.ok === true,
    required.ok ? required.data?.changed?.join(', ') : required.error,
  );

  // 4. release 导出
  const outApp = path.join(projectDir, 'dist', 'ExportGate.app');
  // 注意：runOperation 在 op 报错时会 **throw**。这里必须捕获，否则一旦 ops.gd 自述失败
  // （哪怕产物其实已经生成），验收就直接中断，看不到后面的真实结论。
  let exported;
  try {
    exported = await runOperation(
      'export_project',
      { preset: 'macOS', output_path: outApp, debug: false },
      { project: projectDir, timeoutMs: 600_000 },
    );
  } catch (error) {
    exported = { ok: false, error: `${error?.code ?? 'ERROR'}: ${String(error?.message ?? error)}` };
  }

  // 验收原则：**以文件系统为准，不信工具的自述**。
  // ops.gd 的 export_project 曾用 FileAccess.file_exists() 判断成功，而 macOS 导出物是目录，
  // 于是导出明明成功却报 "produced no output"。所以这里两边都记：
  const binary = path.join(outApp, 'Contents', 'MacOS', 'ExportGate');
  const bundleExists = await fsp.stat(binary).then(s => s.isFile()).catch(() => false);
  record('导出产物真的存在于磁盘上', bundleExists, binary);
  if (exported.ok === true && !bundleExists) {
    record('export_project 自述成功与磁盘一致', false, '工具说成功了，但磁盘上没有产物');
  }
  if (exported.ok === false && bundleExists) {
    record(
      'export_project 自述失败但产物其实存在（ops.gd 判断 bug，已另派修复）',
      true,
      `工具报：${String(exported.error).slice(0, 120)} —— 但 ${path.basename(outApp)} 确实存在，按磁盘事实继续验收`,
    );
  }
  if (!bundleExists) {
    record('导出产物存在', false, exported.ok ? '工具报成功但无产物' : String(exported.error).slice(0, 300));
    process.stdout.write('\n导出没有产物，后续门控验证无从进行。\n');
    return;
  }

  // 5. A. release 成品默认不应该开 9091
  process.stdout.write('\n=== A. release 成品：9091 应当【不监听】 ===\n');
  const baseline = await portOpen(RUNTIME_PORT);
  if (baseline) {
    record('验证前置：导出前 9091 空闲', false, '端口已被别的进程占用，无法判定归属，请先释放');
    return;
  }
  // 长驻运行，全程轮询探测（绝不用小帧数 quit-after，那会产生假阴性）
  const plain = await probeWhileRunning(
    { command: binary, args: ['--headless'] },
    { wantOpen: false, timeoutMs: 20_000 },
  );
  record(
    'release 成品长驻运行期间 9091 始终不监听',
    plain.matched === true,
    plain.sawAny
      ? '端口一度打开过（门控失效！成品会被任意本地进程执行代码）'
      : `20s 内始终未监听${plain.exitedEarly ? '（注意：进程提前退出）' : ''}`,
  );

  // 6. B. 显式 opt-in 时应当能连上（证明门控没有把功能砍坏）
  process.stdout.write('\n=== B. 显式 opt-in：9091 应当【监听】 ===\n');
  const forced = await probeWhileRunning(
    { command: binary, args: ['--headless'], env: { GODOT_MCP_RUNTIME_FORCE: '1' } },
    { wantOpen: true, timeoutMs: 25_000 },
    // 进程还活着的时候连上去执行一次 rt.eval
    async () => {
      const client = await runDetached(
        process.execPath,
        ['-e', EVAL_PROBE_JS],
        { timeoutMs: 12_000 },
      );
      return client.stdout;
    },
  );
  record('opt-in 后 release 成品 9091 监听', forced.matched === true, forced.matched ? 'listening' : '未监听（门控把功能砍坏了？）');
  // 证明 opt-in 是「可用的调试能力」而不是「端口开着但没功能」
  record(
    'opt-in 后 rt.eval 真的可执行（返回 42）',
    /"result":42/.test(forced.extra ?? ''),
    (forced.extra ?? '').slice(0, 200) || '(无响应)',
  );

  if (temporary) await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => {});
}

main()
  .catch(error => record('验收异常中断', false, String(error?.stack ?? error)))
  .finally(() => {
    const failed = results.filter(item => !item.ok);
    process.stdout.write(`\n=== 汇总 ===\n通过 ${results.length - failed.length}/${results.length}\n`);
    for (const item of failed) process.stdout.write(`  - ${item.name}: ${JSON.stringify(item.detail)}\n`);
    process.exitCode = failed.length ? 1 : 0;
  });
