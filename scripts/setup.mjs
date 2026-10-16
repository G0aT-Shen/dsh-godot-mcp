#!/usr/bin/env node
// 一条命令把 dsh-godot-mcp 接到本机 DSH（以及顺手把该有的前置条件说清楚）。
//
//   node scripts/setup.mjs                 # 自检 + 写 DSH 接线（幂等；改动前先备份）
//   node scripts/setup.mjs --check         # 只看不写（不碰任何文件）
//   node scripts/setup.mjs --download-godot  # 缺 Godot 时自动下载 4.7.2 到 tools/
//   node scripts/setup.mjs --godot-zip <zip> # 离线：用本地已有的官方 zip 解包到 tools/
//   node scripts/setup.mjs --profile <目录>  # 指定 DSH profile（默认 ~/.dsh/profiles/desktop）
//   node scripts/setup.mjs --keep-deps       # 不动 profile package.json 里的历史 link 依赖
//
// 它做四件事：
//   1. 检查 Node 版本与绝对路径（mcp-client 用 scrubbedParentEnv 起子进程，PATH 里的 node 不可依赖）；
//   2. 找到可用的 Godot 4.7+（env → 随包 tools/ → /Applications → PATH），必要时下载/解包；
//   3. 在 DSH profile 的 cordis.patch.yml 里写入/更新 godot-mcp-client 条目（值相同则一个字节都不改）；
//   4. 用 profile 里那条命令**真的起一次 server**（initialize + tools/list），确认 5 个工具都在。
//
// 幂等：重复跑不会累积垃圾；每次改动都留 <文件>.before-setup-<时间戳> 备份。

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PINNED_GODOT_VERSION, godotStatus } from '../src/godot.mjs';
import { assertZipFile, godotAssetName, locateGodotBinary, unpackZip } from './lib/godot-install.mjs';
import { probeEnvReport, probeMcpServer } from './lib/probe-mcp.mjs';
import { ENTRY_ID, buildEntryBlock, buildHeader, patchPatchText, validatePatchText } from './lib/profile-patch.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(REPO, 'bin', 'godot-mcp.mjs');
const SERVER_NAME = 'godot';
const EXPECTED_TOOLS = ['godot', 'godot_batch', 'godot_session', 'godot_connect', 'godot_status'];
const GODOT_VERSION = PINNED_GODOT_VERSION;
const LEGACY_PACKAGE_NAMES = ['@hanyangshen/godot-mcp', 'dsh-godot-mcp'];

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = name => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const dryRun = flag('check');
const profileDir = path.resolve(
  option('profile') ?? process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop'),
);

const steps = [];
const note = (ok, title, detail) => {
  steps.push({ ok, title, detail });
  process.stdout.write(`${ok === true ? '✔' : ok === false ? '✖' : 'ℹ'} ${title}${detail === undefined ? '' : ` — ${detail}`}\n`);
};
const say = text => process.stdout.write(`${text}\n`);

// ----------------------------------------------------------------- 1. Node

async function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const node = process.execPath;
  note(major >= 20, `Node ${process.versions.node}（需要 ≥ 20）`, node);
  const absolute = path.isAbsolute(node);
  note(absolute, 'node 是绝对路径（写进 profile 的就是它）', absolute ? node : '不是绝对路径，无法写进配置');
  return { node, ok: major >= 20 && absolute };
}

// ----------------------------------------------------------------- 2. Godot

/** 官方发布资产名（按平台/架构）。实现见 scripts/lib/godot-install.mjs（可单测）。 */
function assetName() {
  return godotAssetName({ version: GODOT_VERSION });
}

async function download(url, dest, label, { accept } = {}) {
  say(`   ↓ ${label}\n     ${url}`);
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(900_000),
    headers: accept ? { Accept: accept } : undefined,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const total = Number(response.headers.get('content-length') ?? 0);
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (Date.now() - lastReport > 3000) {
      lastReport = Date.now();
      const pct = total ? ` (${Math.round((received / total) * 100)}%)` : '';
      say(`     ${(received / 1048576).toFixed(1)} MiB${pct}`);
    }
  }
  const buffer = Buffer.concat(chunks);
  // 明显不是 zip 的响应（例如被代理拦下的 HTML 页面）要在写盘之前拦下来
  if (buffer.length < 1_000_000 || buffer.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new Error(`下载内容不是 zip（${buffer.length} 字节，开头 ${JSON.stringify(buffer.subarray(0, 32).toString('latin1'))}）`);
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buffer);
  say(`     → ${dest}（${(buffer.length / 1048576).toFixed(1)} MiB）`);
  return dest;
}

/** GitHub 直链下不动时，改走 API 资产端点（本机实测过这条路）。 */
async function downloadViaApi(dest) {
  const asset = assetName();
  const releaseUrl = `https://api.github.com/repos/godotengine/godot/releases/tags/${GODOT_VERSION}`;
  const release = await fetch(releaseUrl, { signal: AbortSignal.timeout(120_000), headers: { Accept: 'application/vnd.github+json' } });
  if (!release.ok) throw new Error(`GitHub API ${release.status}`);
  const body = await release.json();
  const found = (body.assets ?? []).find(item => item.name === asset);
  if (!found) throw new Error(`release ${GODOT_VERSION} 里没有资产 ${asset}`);
  return download(`https://api.github.com/repos/godotengine/godot/releases/assets/${found.id}`, dest, `GitHub API 资产 #${found.id}`, {
    accept: 'application/octet-stream',
  });
}

async function ensureGodot() {
  const directHint = process.env.GODOT_MCP_GODOT ?? process.env.GODOT_PATH ?? process.env.GODOT4 ?? process.env.GODOT;
  let status = await godotStatus(undefined);
  if (status.ok) {
    // 来源只影响一件事：如果这次是靠环境变量找到的，就必须把它钉进 profile 的 env ——
    // 因为 DSH 起子进程时用的是 scrubbedParentEnv，环境变量不会传下去。
    const source = status.path.startsWith(path.join(REPO, 'tools')) ? 'bundled' : directHint ? 'env' : 'system';
    note(true, `找到 Godot ${status.version ?? ''}`.trim(), `${status.path}（来源：${source}）`);
    // 一律把选中的绝对路径钉进 profile：DSH 起 server 用 scrubbedParentEnv，
    // 环境变量不会传下去；Windows 上「PATH 里有 godot」尤其不可依赖。
    return { ok: true, path: status.path, source, pinEnv: true };
  }

  if (flag('download-godot') || option('godot-zip')) {
    const zip = option('godot-zip') ? path.resolve(option('godot-zip')) : path.join(REPO, 'tools', assetName());
    if (option('godot-zip')) {
      note(null, '使用本地 zip 解包（离线模式）', zip);
    } else if (existsSync(zip)) {
      note(null, '已经下载过，直接解包', zip);
    } else {
      try {
        await download(
          `https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}/${assetName()}`,
          zip,
          `Godot ${GODOT_VERSION}（直链）`,
        );
      } catch (error) {
        note(false, '直链下载失败，改走 GitHub API 资产端点', String(error.message).slice(0, 160));
        await downloadViaApi(zip);
      }
    }
    try {
      assertZipFile(zip);
    } catch (error) {
      note(false, 'zip 校验失败，不解包', String(error.message).slice(0, 200));
      return { ok: false };
    }
    const unpacked = unpackZip(zip, path.join(REPO, 'tools'));
    if (!unpacked.command) {
      note(false, '解包失败：所有解包方式都不可用', unpacked.failures.join(' | '));
      say('  Windows 上可用：tar（Win10+ 自带）或 PowerShell：Expand-Archive -LiteralPath <zip> -DestinationPath tools -Force');
      return { ok: false };
    }
    note(null, `解包完成（${unpacked.command}）`, path.join(REPO, 'tools'));

    // 解包成功 ≠ 能用：官方 Windows zip 解出来是**版本化文件名**
    // （Godot_v4.7.2-stable_win64.exe），旧实现解完包又走一遍通用 resolver，
    // 结果在 Windows 上找不到刚解出来的 exe。这里显式定位 + **真跑一次 --version** 校验，
    // 再把绝对路径钉进 profile。
    const toolsDir = path.join(REPO, 'tools');
    const located = locateGodotBinary(toolsDir, { version: GODOT_VERSION });
    if (!located) {
      note(false, '解包后没有在 tools/ 下找到 Godot 可执行文件', toolsDir);
      return { ok: false };
    }
    // 注意：`located` 在 macOS 上是 Godot.app/Contents/MacOS/Godot 这样的**完整路径**，
    // 早先把它 basename 之后再 join 回 tools/，等于把 .app 结构压扁成一个不存在的文件，
    // 于是「解包成功却报跑不起来」。直接拿完整路径去校验。
    const verified = await godotStatus(located);
    if (!verified.ok) {
      note(false, `解包后的 Godot 跑不起来：${path.basename(located)}`, String(verified.error ?? '').slice(0, 200));
      return { ok: false };
    }
    note(true, `解包并校验通过：Godot ${verified.version}`, verified.path);
    return { ok: true, path: verified.path, source: 'bundled', pinEnv: true };
  }

  note(false, '没找到可用的 Godot 4.7+', status.error ?? '');
  const checked = status.checked;
  if (checked) {
    say('\n  找过这些位置（用于判断是「没装」还是「装了但没被认出来」）：');
    for (const candidate of [...(checked.bundled ?? []), ...(checked.system ?? [])].slice(0, 14)) say(`    - ${candidate}`);
    say(`    PATH 里找过：${(checked.pathNames ?? []).slice(0, 8).join(', ')}`);
    for (const note_ of checked.notes ?? []) say(`    ${note_}`);
  }
  say(
    '\n  请任选一种：\n' +
      '    a) 装官方 Godot 4.7+：Windows 下载 zip 解到任意目录后设置绝对路径（见 README 的 PowerShell 步骤）\n' +
      `       下载页：https://github.com/godotengine/godot/releases/tag/${GODOT_VERSION}\n` +
      '    b) 让本脚本下载并解包到 tools/：node scripts/setup.mjs --download-godot\n' +
      `       已有官方 zip 时离线解包：node scripts/setup.mjs --godot-zip <Godot_v${GODOT_VERSION}_win64.exe.zip>\n` +
      '    c) 直接指定路径（同时写进 DSH 配置的 env，避免被 scrubbed env 洗掉）：\n' +
      '       Windows PowerShell：$env:GODOT_MCP_GODOT="C:\\Godot\\Godot_v4.7.2-stable_win64.exe"; node scripts/setup.mjs\n',
  );
  return { ok: false };
}

// ----------------------------------------------------------------- 3. profile

/** 生成写进 profile 的条目块（含 Godot 路径钉定逻辑）。 */
function entryBlock({ node, godot, pinGodot }) {
  return buildEntryBlock({
    node,
    serverEntry: SERVER_ENTRY,
    cwd: os.homedir(),
    godotPath: pinGodot && godot?.path ? godot.path : undefined,
  });
}

async function wireProfile({ node, godot, pinGodot }) {
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const profileExists = existsSync(profileDir);
  if (!profileExists) {
    note(
      null,
      '没检测到 DSH profile：跳过自动接线',
      `${profileDir} 不存在（DSH 还没跑过一次？或用 --profile 指定）`,
    );
    say(
      '\n  手动接入：把下面这段加进 profile 的 cordis.patch.yml（顶层数组里的 `- insert:` 下），然后重启 DSH：\n\n' +
        ['- insert:', buildHeader(), entryBlock({ node, godot, pinGodot }).trimEnd()].join('\n') +
        '\n\n  其它 MCP 客户端（Codex / Claude Code / Cursor）可直接：\n' +
        `    codex mcp add godot -- ${node} ${SERVER_ENTRY}\n`,
    );
    return { wired: false, reason: 'no-profile' };
  }

  const before = await fsp.readFile(patchPath, 'utf8').catch(() => undefined);
  const existed = before !== undefined;
  const result = patchPatchText(before ?? '', entryBlock({ node, godot, pinGodot }));
  if (result.action === 'unchanged') {
    note(true, 'DSH 接线已是最新（未改动文件）', patchPath);
    return { wired: true, changed: false, patchPath };
  }
  if (dryRun) {
    note(null, `--check：将要 ${result.action === 'updated' ? '更新' : result.action === 'inserted' ? '插入' : '新建'} 接线条目`, patchPath);
    return { wired: true, changed: false, patchPath, planned: result.action };
  }
  // 写进别人的 DSH 配置之前先结构自检：缩进写错会让 DSH 起不来，宁可拒绝写
  const valid = validatePatchText(result.text);
  if (!valid.ok) {
    note(false, '写入前结构自检未通过，已放弃写入（原文件未改动）', valid.problems.join('; '));
    return { wired: false, reason: 'invalid-patch' };
  }
  const backupPath = `${patchPath}.before-setup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (existed) await fsp.copyFile(patchPath, backupPath);
  await fsp.writeFile(patchPath, result.text, 'utf8');
  note(true, `DSH 接线已${result.action === 'updated' ? '更新' : result.action === 'inserted' ? '插入' : '写入新文件'}`, patchPath);
  if (existed) note(null, '原文件已备份', backupPath);
  return { wired: true, changed: true, patchPath, action: result.action };
}

/** profile 里指向本仓库的历史 link 依赖：MCP 形态不需要它，留着会让别的机器 pnpm install 失败。 */
async function checkStaleDeps() {
  const pkgPath = path.join(profileDir, 'package.json');
  if (!existsSync(pkgPath)) return;
  const raw = await fsp.readFile(pkgPath, 'utf8').catch(() => undefined);
  if (raw === undefined) return;
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    note(false, 'profile 的 package.json 不是合法 JSON，跳过依赖检查', pkgPath);
    return;
  }
  const stale = Object.entries(pkg.dependencies ?? {}).filter(([name, spec]) =>
    LEGACY_PACKAGE_NAMES.includes(name) || (typeof spec === 'string' && spec.startsWith('link:') && /godot-mcp$/.test(spec)),
  );
  if (!stale.length) {
    note(true, 'profile 依赖里没有历史遗留的 godot-mcp link', '干净');
    return;
  }
  if (flag('keep-deps') || dryRun) {
    note(null, `profile 里有历史遗留依赖（--check/--keep-deps 不动它）`, stale.map(([name, spec]) => `${name}=${spec}`).join(', '));
    return;
  }
  const backupPath = `${pkgPath}.before-setup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await fsp.copyFile(pkgPath, backupPath);
  for (const [name] of stale) delete pkg.dependencies[name];
  await fsp.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  note(true, '已移除 profile 里不需要的历史 link 依赖（MCP 形态不走包解析）', `${stale.map(([n]) => n).join(', ')} → 备份 ${path.basename(backupPath)}`);
}

// ----------------------------------------------------------------- 4. 自检

async function selfCheck({ node, godot, pinGodot }) {
  const env = pinGodot && godot?.path ? { GODOT_MCP_GODOT: godot.path } : undefined;
  const probe = await probeMcpServer({ command: node, args: [SERVER_ENTRY], cwd: os.homedir(), env, timeoutMs: 90_000 });
  if (!probe.ok) {
    note(false, '按配置起 server 失败', probe.error ?? '');
    return false;
  }
  const missing = EXPECTED_TOOLS.filter(tool => !probe.tools.includes(tool));
  note(
    missing.length === 0,
    `${probe.tools.length} 个工具都能列出（MCP 原始名）`,
    missing.length ? `缺少 ${missing.join(', ')}` : probe.tools.join(', '),
  );
  note(!probe.stderr?.trim(), 'server 启动时没有 stderr 噪音', probe.stderr?.trim().slice(0, 160) ?? '');
  note(null, `server 构建指纹 ${probe.serverInfo?.build ?? '(未上报)'}`, `协议版本 ${probe.protocolVersion ?? '?'}`);
  return missing.length === 0;
}

// ----------------------------------------------------------------- main

async function main() {
  say(`dsh-godot-mcp 安装自检${dryRun ? '（--check：不会写任何文件）' : ''}`);
  say(`仓库：${REPO}`);
  say(`profile：${profileDir}\n`);

  if (flag('help')) {
    say('用法：node scripts/setup.mjs [--check] [--download-godot] [--godot-zip <zip>] [--profile <目录>] [--keep-deps]');
    return;
  }

  const node = await checkNode();
  if (!node.ok) {
    say('\nNode 不满足要求，先装 Node 20+ 再来。');
    process.exitCode = 1;
    return;
  }

  const godot = await ensureGodot();
  // pinGodot：把选中的 Godot 绝对路径写进 profile 的 env.GODOT_MCP_GODOT。
  // 只要定位到了真实可执行文件就钉 —— 这是 Windows 上「首次安装后 DSH 一定找得到引擎」的关键。
  const pinGodot = godot.ok === true && Boolean(godot.path);
  if (godot.ok !== true) process.exitCode = 1;

  say('');
  const wiring = await wireProfile({ node: node.node, godot, pinGodot });
  await checkStaleDeps();

  say('\n自检');
  const envReport = probeEnvReport();
  note(null, `探针环境（${envReport.platform}）`, `${envReport.note}；保留 ${envReport.keys.length} 个变量`);
  const serverOk = await selfCheck({ node: node.node, godot, pinGodot });

  say('\n=== 结果 ===');
  const failed = steps.filter(step => step.ok === false);
  say(`通过 ${steps.filter(step => step.ok === true).length}，未就绪 ${failed.length}`);
  for (const step of failed) say(`  ✖ ${step.title}${step.detail ? ` — ${step.detail}` : ''}`);

  if (serverOk && wiring.wired) {
    say('\n下一步：');
    if (dryRun && wiring.planned) say('  1. 接线还差一次真实写入：node scripts/setup.mjs（去掉 --check）；');
    else if (wiring.changed) say('  1. 重启 DSH（或等 mcp-client 热重连），让新条目生效；');
    else say('  1. DSH 接线没变，无需重启；');
    say('  2. 在 DSH 里让 agent 调用 mcp__godot__godot_status，应当看到 godot / opsEngine / bridges 三段；');
    say('  3. 想顺手跑一遍完整验收：node scripts/verify-wiring.mjs && node scripts/verify-mcp.mjs');
  }
  if (!wiring.wired && serverOk) {
    say('\nserver 本身可用（Codex / Claude Code / Cursor 都能接），上面给了手动写 DSH 配置的片段。');
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(error => {
  process.stdout.write(`\n安装自检异常中断：${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
