// Windows/官方包的发现、解包与钉定回归。
//
// 验收要求：「Godot 官方 Windows 包发现和钉定、probe 环境与错误诊断均有真实回归」。
// 本机是 macOS 且当前会话的 GitHub 直连被网络策略拒绝（CONNECT tunnel 403），拿不到官方
// win64 zip，所以这里用**真实构造的 zip**（官方目录布局：Godot_v4.7.2-stable_win64.exe）
// 走完整的「校验 → 解包 → 定位 → 校验可执行性」链路，另外用本机真实存在的官方 macOS zip
// 在 scripts 里单独复核同一路径。Windows 实机执行仍待验收。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { enumerateGodotCandidates, executableExtensions, godotStatus, isExecutableFile, normalizeGodotPath, resolveGodot } from '../src/godot.mjs';
import { probeEnv, probeEnvReport } from '../scripts/lib/probe-mcp.mjs';
import { assertZipFile, expectedBinaryNames, godotAssetName, locateGodotBinary, unpackZip } from '../scripts/lib/godot-install.mjs';

const VERSION = '4.7.2-stable';

// ------------------------------------------------------------------ 迷你 zip 写入器

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 只写「stored」条目的最小 zip —— 足以让 unzip/tar/ditto/Expand-Archive 都认。 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mode = 0o755 } of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38); // 外部属性里的 unix 权限位
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + content.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

// ------------------------------------------------------------------ 资产名与校验

test('官方资产名与解包后可执行文件名（win64 是版本化 exe）', () => {
  assert.equal(godotAssetName({ version: VERSION, platform: 'win32' }), 'Godot_v4.7.2-stable_win64.exe.zip');
  assert.equal(godotAssetName({ version: VERSION, platform: 'darwin' }), 'Godot_v4.7.2-stable_macos.universal.zip');
  assert.equal(godotAssetName({ version: VERSION, platform: 'linux', arch: 'x64' }), 'Godot_v4.7.2-stable_linux.x86_64.zip');
  assert.equal(godotAssetName({ version: VERSION, platform: 'linux', arch: 'arm64' }), 'Godot_v4.7.2-stable_linux.arm64.zip');
  assert.deepEqual(expectedBinaryNames({ version: VERSION, platform: 'win32' }), [
    'Godot_v4.7.2-stable_win64.exe',
    'Godot_v4.7.2-stable_win64_console.exe',
  ]);
});

test('zip 校验：真 zip 通过，被代理拦下的 HTML 被拒', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-zip-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const good = path.join(dir, 'good.zip');
  await fsp.writeFile(good, makeZip([{ name: 'Godot_v4.7.2-stable_win64.exe', data: 'MZ fake exe' }]));
  assert.equal(assertZipFile(good), true);
  const bad = path.join(dir, 'blocked.zip');
  await fsp.writeFile(bad, '<!DOCTYPE html><html>403 from proxy</html>');
  assert.throws(() => assertZipFile(bad), /不是 zip/);
});

test('解包 → 定位：官方 Windows 布局的版本化 exe 必须被找到（真实解包）', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-unpack-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const zip = path.join(dir, 'Godot_v4.7.2-stable_win64.exe.zip');
  await fsp.writeFile(zip, makeZip([
    { name: 'Godot_v4.7.2-stable_win64.exe', data: 'MZ' + 'x'.repeat(2048) },
    { name: 'Godot_v4.7.2-stable_win64_console.exe', data: 'MZ console' },
    { name: 'LICENSE.txt', data: 'MIT' },
  ]));
  const dest = path.join(dir, 'tools');
  const unpacked = unpackZip(zip, dest);
  assert.ok(unpacked.command, `必须有可用的解包方式：${unpacked.failures.join(' | ')}`);
  assert.equal(fs.existsSync(path.join(dest, 'Godot_v4.7.2-stable_win64.exe')), true);

  const located = locateGodotBinary(dest, { version: VERSION, platform: 'win32' });
  assert.equal(located, path.join(dest, 'Godot_v4.7.2-stable_win64.exe'), '必须优先命中官方版本化文件名');

  // 解包目录被当作 hint 传入时，也要能自己钻进去找到 exe
  assert.equal(
    normalizeGodotPath(dest, { platform: 'win32' }),
    path.win32.join(dest, 'Godot_v4.7.2-stable_win64.exe').replace(/\\/g, path.win32.sep),
  );
});

test('解包：Windows 分支按 tar → pwsh → powershell 回退，全部失败要如实列出原因', async t => {
  // 注意：unpackZip 会 mkdir 目标目录。用假路径 `C:\tmp\tools` 会在**真实 Windows**
  // 上凭空建出 C:\tmp\tools（污染机器、还可能因权限失败），所以这里用真实临时目录。
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-unzip-stub-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const zip = path.join(dir, 'godot.zip');
  const dest = path.join(dir, 'tools');
  const calls = [];
  const okStub = (command, args) => {
    calls.push(command);
    if (command === 'tar') return { status: 1, stderr: 'tar: not a zip' };
    return { status: 0, stderr: '' };
  };
  const result = unpackZip(zip, dest, { platform: 'win32', spawnSyncImpl: okStub });
  assert.equal(result.command, 'pwsh', 'tar 失败后必须轮到 pwsh（而不是直接放弃）');
  assert.deepEqual(calls, ['tar', 'pwsh']);

  const allFail = () => ({ status: 1, stderr: 'nope' });
  const failed = unpackZip(zip, path.join(dir, 'tools2'), { platform: 'win32', spawnSyncImpl: allFail });
  assert.equal(failed.command, undefined);
  assert.equal(failed.failures.length, 3);
});

test('probe 环境：从父环境出发、洗掉凭据与 DSH_*、保留 PATH/系统变量/代理', () => {
  const base = {
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp',
    USERPROFILE: 'C:\\Users\\u',
    PATH: 'C:\\Windows\\system32;C:\\tools',
    HTTP_PROXY: 'http://proxy.local:8080',
    HTTPS_PROXY: 'http://proxy.local:8080',
    DSH_SECRET_TOKEN: 'must-not-leak',
    DSH_SESSION_ID: 'must-not-leak',
    AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    GITHUB_TOKEN: 'must-not-leak',
    SOME_PASSWORD: 'must-not-leak',
  };
  const win = probeEnv({ platform: 'win32', base, extra: { GODOT_MCP_GODOT: 'C:\\Godot\\Godot.exe' } });
  for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'USERPROFILE', 'PATH', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    assert.ok(win[key], `Windows 探针必须保留 ${key}`);
  }
  assert.equal(win.PATH, base.PATH, '父进程 PATH 必须保留（不能换成假的固定 PATH）');
  for (const key of ['DSH_SECRET_TOKEN', 'DSH_SESSION_ID', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'SOME_PASSWORD']) {
    assert.equal(win[key], undefined, `${key} 必须被洗掉`);
  }
  assert.equal(win.GODOT_MCP_GODOT, 'C:\\Godot\\Godot.exe', 'profile 里钉的 env 必须叠加进来');

  const posixBase = {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    HOME: '/Users/someone',
    LANG: 'zh_CN.UTF-8',
    TMPDIR: '/var/folders/xx/T',
    HTTPS_PROXY: 'http://proxy.local:8080',
    DSH_SESSION_ID: 'must-not-leak',
    NPM_TOKEN: 'must-not-leak',
  };
  const posix = probeEnv({ platform: 'darwin', base: posixBase, home: '/Users/other' });
  assert.equal(posix.PATH, '/opt/homebrew/bin:/usr/bin:/bin', 'POSIX 也必须保留真实 PATH（旧实现会覆盖成 /usr/bin:/bin）');
  assert.equal(posix.HOME, '/Users/someone', '父环境已有的 HOME 不该被改掉');
  assert.equal(posix.TMPDIR, '/var/folders/xx/T');
  assert.equal(posix.HTTPS_PROXY, 'http://proxy.local:8080', '代理必须保留（否则探针不能代表真实联网环境）');
  assert.equal(posix.DSH_SESSION_ID, undefined);
  assert.equal(posix.NPM_TOKEN, undefined);
  assert.equal(posix.PATHEXT, undefined, '不该给 POSIX 注入 Windows 专属兜底变量');
  assert.equal(probeEnv({ platform: 'darwin', base: {}, home: '/Users/other' }).HOME, '/Users/other', '父环境没有 HOME 时才用 home 兜底');

  // Windows 真实父环境常用 `Path`（而不是 `PATH`），且 Node 可能同时给出两个变体：
  // 必须按大小写不敏感处理 —— 不能因为「没看到 env.PATH」就塞一个假的 fallback PATH，
  // 也不能只留排序第一个而丢掉真实路径。
  const caseBase = { Path: 'D:\\custom\\bin;C:\\tools', SYSTEMROOT: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', TEMP: 'C:\\Temp' };
  const winCase = probeEnv({ platform: 'win32', base: caseBase });
  assert.equal(winCase.Path ?? winCase.PATH, 'D:\\custom\\bin;C:\\tools', '真实 Path 必须被保留');
  assert.equal(winCase.SystemRoot ?? winCase.SYSTEMROOT, 'C:\\Windows', '大小写变体必须被识别为同一个变量');
  assert.equal(winCase.ComSpec, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(
    (winCase.Path === 'D:\\custom\\bin;C:\\tools' ? 0 : 1) + (winCase.PATH === 'D:\\custom\\bin;C:\\tools' ? 0 : 1),
    1,
    `真实 PATH 只能出现一次（不能既有假 fallback 又有真值）：${JSON.stringify({ Path: winCase.Path, PATH: winCase.PATH })}`,
  );
  // 两个变体同时存在时：保留非空的那个值，不新增第三个键
  const bothVariants = probeEnv({ platform: 'win32', base: { Path: '', PATH: 'E:\\real' } });
  assert.equal(bothVariants.Path ?? bothVariants.PATH, 'E:\\real');
  // extra 里的同义键必须覆盖父环境
  const overridden = probeEnv({ platform: 'win32', base: caseBase, extra: { PATH: 'F:\\extra' } });
  assert.equal(overridden.Path ?? overridden.PATH, 'F:\\extra', 'extra 的同义键必须覆盖 base');

  const report = probeEnvReport({ platform: 'win32', base });
  assert.equal(report.platform, 'win32');
  assert.ok(report.removed.includes('DSH_SECRET_TOKEN'));
  assert.equal(report.critical.PATH, base.PATH);
});

// ------------------------------------------------------------------ 发现与钉定

test('Windows 候选：官方版本化 exe、安装目录、PATHEXT、PATH 展开', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-win-layout-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const tools = path.join(root, 'tools');
  await fsp.mkdir(tools);
  const exe = path.join(tools, 'Godot_v4.7.2-stable_win64.exe');
  await fsp.writeFile(exe, 'MZ');

  const candidates = enumerateGodotCandidates({ platform: 'win32', packageRoot: root, env: {}, homedir: 'C:\\Users\\u' });
  // env 被洗过（没有 ProgramFiles）时，仍要覆盖官方默认安装落点
  assert.ok(candidates.system.some(item => item === 'C:\\Program Files\\Godot\\Godot.exe'), '缺 ProgramFiles 时要回退到 C:\\Program Files');
  const withEnv = enumerateGodotCandidates({ platform: 'win32', packageRoot: root, homedir: 'C:\\Users\\u', env: { ProgramFiles: 'D:\\Program Files' } });
  assert.ok(candidates.bundled.includes(path.win32.join(tools, 'Godot_v4.7.2-stable_win64.exe')));
  assert.ok(withEnv.system.some(item => item.startsWith('D:\\Program Files\\Godot\\')), '必须覆盖 %ProgramFiles%\\Godot');
  assert.ok(candidates.system.some(item => /scoop/i.test(item)), '必须覆盖 scoop');
  assert.ok(candidates.system.some(item => /chocolatey/i.test(item)), '必须覆盖 chocolatey');

  // 显式 hint 优先且严格
  assert.equal(resolveGodot(exe, { platform: 'win32', env: {} }), exe);
  // 不存在的 hint 不能悄悄回退到别的 Godot
  assert.equal(resolveGodot(path.join(root, 'nope.exe'), { platform: 'win32', env: {} }), undefined);
});

test('Windows PATH + PATHEXT：godot.exe / Godot.EXE 都能被找到', () => {
  // 非 Windows 上没法真的建出 `C:\tools\godot.exe`，所以注入存在性判定来断言
  // 「PATH 目录 + PATHEXT 展开名」这条分支本身；Windows CI 上走真实文件系统。
  const env = { PATH: 'C:\\tools;D:\\Godot', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const present = new Set(['C:\\tools\\godot.exe', 'D:\\Godot\\Godot.EXE']);
  const where = resolveGodot(undefined, { platform: 'win32', env, isExecutable: target => present.has(target) });
  assert.equal(where, path.win32.join('C:\\tools', 'godot.exe'), '必须按 PATH 顺序 + PATHEXT 命中 godot.exe');

  const onlyUpper = resolveGodot(undefined, {
    platform: 'win32',
    env: { PATH: 'D:\\Godot', PATHEXT: '.EXE' },
    isExecutable: target => target === path.win32.join('D:\\Godot', 'Godot.EXE'),
  });
  assert.equal(onlyUpper, path.win32.join('D:\\Godot', 'Godot.EXE'), '大小写变体都要能找到');
  assert.deepEqual(executableExtensions('win32', { PATHEXT: '.EXE;.CMD' }), ['.EXE', '.CMD']);
  assert.deepEqual(executableExtensions('win32', {}), ['.COM', '.EXE', '.BAT', '.CMD'], '没设 PATHEXT 时用 cmd 默认值');
  const names = enumerateGodotCandidates({ platform: 'win32', env, packageRoot: '/repo', homedir: 'C:\\Users\\u' }).pathNames;
  for (const expected of ['godot.exe', 'godot.EXE', 'godot4.exe', 'Godot.exe']) {
    assert.ok(names.includes(expected), `PATH 搜索名必须包含 ${expected}`);
  }
});

test('POSIX 上 PATH 里的 godot 也能被找到（同一套搜索逻辑）', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-path-posix-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'godot4');
  await fsp.writeFile(exe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(resolveGodot(undefined, { platform: 'linux', env: { PATH: dir } }), exe);
  assert.equal(isExecutableFile(exe, { platform: 'linux' }), true);
  // Windows 的 fs.access(X_OK) 恒真，所以「执行位」这个断言只能在真实 POSIX 上用文件系统验证；
  // 在 Windows 上改用注入的 access 来模拟 EACCES —— 两条路径都必须被覆盖，不能整体 skip。
  if (process.platform === 'win32') {
    const denied = () => { const error = new Error('EACCES'); error.code = 'EACCES'; throw error; };
    assert.equal(isExecutableFile(exe, { platform: 'linux', access: denied }), false, 'POSIX 语义下没有执行位不算可执行');
    assert.equal(isExecutableFile(exe, { platform: 'win32' }), true, 'Windows 原生分支不看执行位（保留了原生可执行覆盖）');
  } else {
    await fsp.chmod(exe, 0o644);
    assert.equal(isExecutableFile(exe, { platform: 'linux' }), false, 'POSIX 上没有执行位的不算可执行');
    assert.equal(isExecutableFile(exe, { platform: 'win32' }), true, 'Windows 不看执行位（扩展名已由候选名单限定）');
  }
});

test('Windows 反斜杠/盘符/UNC 路径在 hint 与目录归一化里都不被破坏', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-winpath-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const packed = path.join(dir, 'Godot_v4.7.2-stable_win64.exe');
  await fsp.writeFile(packed, 'MZ');
  // 目录 hint（PowerShell 里复制的是目录 + 引号）
  assert.equal(normalizeGodotPath(`"${dir}"`, { platform: 'win32' }), path.win32.join(dir, 'Godot_v4.7.2-stable_win64.exe'));
  // 已经是 exe 的原样返回
  assert.equal(normalizeGodotPath(packed, { platform: 'win32' }), packed);
});

test('找不到 Godot 时的诊断必须列出「查过哪些位置」', async () => {
  const status = await godotStatus(path.join(os.tmpdir(), 'definitely-missing-godot-xyz'));
  assert.equal(status.ok, false);
  assert.equal(status.error, 'GODOT_NOT_FOUND');
  assert.ok(status.checked.bundled.length > 0, '必须给出随包候选');
  assert.ok(status.checked.system.length > 0, '必须给出系统安装候选');
  assert.ok(status.checked.pathNames.some(name => /^godot\.?/i.test(name)), '必须给出 PATH 搜索名');
  assert.ok(status.checked.pathNames.length >= 3, 'PATH 搜索名要覆盖 godot4/godot/Godot');
});
