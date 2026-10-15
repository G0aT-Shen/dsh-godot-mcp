#!/usr/bin/env node
// DSH 接线自检（MCP 形态）：确认 DSH **真的会**按配置把 Godot 能力接进来。
//
// 背景：项目曾经以自写 cordis 插件形态交付，后来改成标准 stdio MCP server +
// DSH 自带的 dsh-mcp-client（原因见 verification/SUMMARY.md 第 7 节）。这份检查也随之
// 从「插件接线」改成「MCP 接线」，而且不只是看配置长得对不对 —— 它会**按配置里那条
// 命令真的把 server 起起来**做一次 initialize + tools/list。因为配错 node 路径、
// 配错 server 路径这类问题，光看 YAML 是看不出来的；而 mcp-client 用
// scrubbedParentEnv() 起子进程，`PATH` 里的 node 并不可靠，所以必须实测。
//
// 干净机器上的行为：找不到 DSH profile 时**跳过**并退出 0（这台机器可能只用
// Codex/Claude Code）；profile 存在但配置不对时才算失败。
//
// 用法：node scripts/verify-wiring.mjs [profile目录]
//   也可以用环境变量 DSH_PROFILE_DIR 指定。

import fsp from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { probeMcpServer } from './lib/probe-mcp.mjs';
import { ENTRY_ID, parseEntryLoose, validatePatchText } from './lib/profile-patch.mjs';

const CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';
const SERVER_NAME = 'godot';
const EXPECTED_TOOLS = ['godot', 'godot_batch', 'godot_session', 'godot_connect', 'godot_status'];
/** 插件形态的包名（历史名 + 现名）：两条路径同时启用会导致工具重复，必须确认它没被激活。 */
const LEGACY_PLUGIN_PACKAGES = ['@hanyangshen/godot-mcp'];

const profileDir = path.resolve(
  process.argv[2] ?? process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop'),
);
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${detail === undefined ? '' : ` — ${detail}`}\n`);
}
function info(text) {
  process.stdout.write(`ℹ ${text}\n`);
}
const exists = async target => {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  process.stdout.write(`profile: ${profileDir}\n形态: 标准 stdio MCP（经 ${CLIENT_PACKAGE}）\n\n`);

  if (!existsSync(profileDir)) {
    info(`没有这个 DSH profile（${profileDir}）—— 本机可能只用 Codex / Claude Code / Cursor。`);
    info('跳过 DSH 接线检查；要接 DSH 就跑：node scripts/setup.mjs');
    return;
  }

  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const patchText = await fsp.readFile(patchPath, 'utf8').catch(() => undefined);
  if (patchText === undefined) {
    check('profile 的 cordis.patch.yml 可读', false, `${patchPath} 不存在（先跑 node scripts/setup.mjs）`);
    return;
  }

  // 1. 优先用真实 YAML 解析器（正则看不出缩进/引号这类会让 DSH 加载失败的问题）；
  //    没有的话退回结构自检（同一个模块在单测里被覆盖）。
  const { createRequire } = await import('node:module');
  const require_ = createRequire(path.join(profileDir, 'package.json'));
  let YAML;
  try {
    YAML = require_('yaml');
  } catch {
    info('profile 里找不到 yaml 包，改用结构自检（缩进/字段仍然会查）');
  }

  let doc;
  let entry;
  let inserted = [];
  if (YAML) {
    doc = YAML.parse(patchText);
    check('profile patch 是合法 YAML 数组', Array.isArray(doc));
    inserted = Array.isArray(doc) ? doc.flatMap(item => (Array.isArray(item?.insert) ? item.insert : [])) : [];
    entry = inserted.find(item => item?.id === ENTRY_ID);
  } else {
    // 没有 yaml 包（全新 profile、还没装 node_modules）时的兜底：结构自检 + 按缩进读条目
    const structural = validatePatchText(patchText);
    check('profile patch 结构自检通过（含缩进与字段）', structural.ok, structural.problems.join('; '));
    entry = parseEntryLoose(patchText);
  }

  check(
    `patch 的 insert 里有 ${ENTRY_ID}`,
    Boolean(entry),
    entry
      ? JSON.stringify(entry.config ?? { serverName: entry.serverName, command: entry.command }).slice(0, 120)
      : `实际条目：${inserted.map(i => i.id).join(', ') || '(未解析)'}`,
  );
  if (!entry) return;

  const config = entry.config ?? entry;
  check('用的是 DSH 自带的 MCP 客户端', entry.name === CLIENT_PACKAGE, entry.name);
  check(`serverName 是 "${SERVER_NAME}"`, config.serverName === SERVER_NAME, config.serverName);
  check('transport 是 stdio', config.transport === 'stdio', config.transport);

  // 2. command 必须是绝对路径且可执行（PATH 里的 node 不可依赖）
  const command = config.command;
  check('command 是绝对路径', typeof command === 'string' && path.isAbsolute(command), command);
  let commandOk = false;
  if (typeof command === 'string' && path.isAbsolute(command)) {
    try {
      const stat = await fsp.stat(command);
      await fsp.access(command, FS.X_OK);
      commandOk = stat.isFile();
    } catch {
      commandOk = false;
    }
  }
  check('command 存在且可执行', commandOk, command);

  // 3. server 入口存在，且确实在本仓库内（避免"改了另一份代码"）
  const serverArg = Array.isArray(config.args) ? config.args[0] : undefined;
  check('args[0] 指向本项目 server 入口', typeof serverArg === 'string' && (await exists(serverArg)), serverArg);
  check(
    'server 入口就在本仓库内',
    typeof serverArg === 'string' && path.resolve(serverArg).startsWith(repoDir),
    serverArg,
  );

  // 4. 超时必须放宽：默认 60s 对 run_project / export_project 不够
  check(
    'toolCallTimeoutMs 足够长（> 60000）',
    typeof config.toolCallTimeoutMs === 'number' && config.toolCallTimeoutMs > 60_000,
    String(config.toolCallTimeoutMs),
  );

  // 5. 插件形态必须保持关闭，否则工具会出现重复的两套
  const profilePkg = await fsp
    .readFile(path.join(profileDir, 'package.json'), 'utf8')
    .then(text => JSON.parse(text))
    .catch(() => undefined);
  const repoPackageName = JSON.parse(await fsp.readFile(path.join(repoDir, 'package.json'), 'utf8')).name;
  const pluginNames = [repoPackageName, ...LEGACY_PLUGIN_PACKAGES];
  if (profilePkg === undefined) {
    info('profile 里没有 package.json（全新 profile？）—— 跳过「插件形态是否激活」这一项');
  } else {
    const bundles = profilePkg.dsh?.profile?.bundles ?? [];
    const activated = pluginNames.filter(name => bundles.includes(name));
    check(
      '插件形态未激活（bundles 不含本包）',
      activated.length === 0,
      activated.length ? `${activated.join(', ')} 在 bundles 里 —— 两条路径同时启用会导致工具重复` : '未激活',
    );
  }

  // 6. 决定性一步：按配置里那条命令真的起一次 server 并 tools/list
  if (!commandOk || typeof serverArg !== 'string') {
    check('按配置启动 server 并 tools/list', false, '命令或入口不可用，跳过');
    return;
  }
  const probe = await probeMcpServer({
    command,
    args: config.args,
    cwd: config.cwd ?? undefined,
    env: config.env,
    timeoutMs: 90_000,
  });
  check('按配置启动 server 并完成 initialize + tools/list', probe.ok === true, probe.error ?? `tools=${(probe.tools ?? []).length}`);
  if (probe.ok) {
    const missing = EXPECTED_TOOLS.filter(tool => !(probe.tools ?? []).includes(tool));
    check(
      '5 个工具都能列出（MCP 原始名）',
      missing.length === 0,
      missing.length ? `缺少 ${missing.join(', ')}` : (probe.tools ?? []).join(', '),
    );
  }
  // 构建指纹要能从握手看到：没有它就没法判断「DSH 里跑的是不是旧代码」
  check(
    'initialize 里带构建指纹（serverInfo.build）',
    typeof probe.serverInfo?.build === 'string' && /^[0-9a-f]{8,}$/.test(probe.serverInfo.build),
    probe.serverInfo?.build ?? '(缺)',
  );
  check('server 启动时没有 stderr 噪音', !probe.stderr?.trim(), probe.stderr?.trim().slice(0, 200));
}

main()
  .catch(error => check('接线自检异常中断', false, String(error?.stack ?? error)))
  .finally(() => {
    const failed = results.filter(item => !item.ok);
    process.stdout.write(`\n=== 汇总 ===\n通过 ${results.length - failed.length}/${results.length}\n`);
    if (!results.length) {
      process.stdout.write('结论：本机没有 DSH profile，跳过（不算通过也不算失败）。\n');
    } else if (failed.length) {
      process.stdout.write('结论：DSH 侧接线有问题，请修复上面的失败项（配置改动后 mcp-client 会重连）。\n');
    } else {
      process.stdout.write(`结论：接线完整。工具会以 mcp__${SERVER_NAME}__<name> 暴露。\n`);
    }
    process.exitCode = failed.length ? 1 : 0;
  });
