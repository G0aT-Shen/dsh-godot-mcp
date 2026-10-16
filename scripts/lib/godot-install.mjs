// 安装期纯逻辑：官方资产名、zip 校验、解包回退链、解包后可执行文件定位。
//
// 抽成独立模块的原因：这些分支（Windows 的 tar/Expand-Archive、macOS 的 unzip/ditto、
// 官方版本化文件名 `Godot_v4.7.2-stable_win64.exe`）原来埋在 setup.mjs 里，
// 只能靠「真的装一遍」验证，Windows 上更是没法测。抽出来之后可以用真实构造的 zip
// 在任意平台上跑，也正是「解包后必须校验并钉定实际 exe」这条要求的落点。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 官方发布资产名（按平台/架构）。 */
export function godotAssetName({ version, platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'darwin') return `Godot_v${version}_macos.universal.zip`;
  if (platform === 'win32') return `Godot_v${version}_win64.exe.zip`;
  if (arch === 'arm64') return `Godot_v${version}_linux.arm64.zip`;
  return `Godot_v${version}_linux.x86_64.zip`;
}

/** 官方 zip 解开后的可执行文件名（Windows 是版本化 exe，macOS 是 .app）。 */
export function expectedBinaryNames({ version, platform = process.platform } = {}) {
  if (platform === 'darwin') return [`Godot.app/Contents/MacOS/Godot`, `Godot_v${version}_macos.universal/Godot.app/Contents/MacOS/Godot`];
  if (platform === 'win32') return [`Godot_v${version}_win64.exe`, `Godot_v${version}_win64_console.exe`];
  return [`Godot_v${version}_linux.x86_64`, `Godot_v${version}_linux.arm64`];
}

/** zip 头校验：明显不是 zip（代理拦下的 HTML、半截下载）要在解包前拦下来。 */
export function assertZipFile(zipPath) {
  const handle = fs.openSync(zipPath, 'r');
  try {
    const buffer = Buffer.alloc(4);
    fs.readSync(handle, buffer, 0, 4, 0);
    if (buffer.subarray(0, 2).toString('latin1') !== 'PK') {
      throw new Error(`${zipPath} 不是 zip（开头 ${JSON.stringify(buffer.toString('latin1'))}）`);
    }
  } finally {
    fs.closeSync(handle);
  }
  return true;
}

/** PowerShell 的 Expand-Archive 命令（单引号按 PS 规则用两个单引号转义）。 */
export function expandArchiveCommand(zipPath, destDir) {
  const quote = value => `'${String(value).replace(/'/g, "''")}'`;
  return `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destDir)} -Force`;
}

/**
 * 解包回退链。Windows：tar（Win10+ 自带）→ pwsh → powershell；
 * POSIX：unzip → tar → ditto。每一步失败都记录下来一起报，避免「静默没解包」。
 * @returns {{command?: string, failures: string[]}}
 */
export function unpackZip(zipPath, destDir, options = {}) {
  const {
    platform = process.platform,
    spawnSyncImpl = spawnSync,
  } = options;
  fs.mkdirSync(destDir, { recursive: true });
  const attempts = platform === 'win32'
    ? [
        ['tar', ['-xf', zipPath, '-C', destDir]],
        ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', expandArchiveCommand(zipPath, destDir)]],
        ['powershell', ['-NoProfile', '-NonInteractive', '-Command', expandArchiveCommand(zipPath, destDir)]],
      ]
    : [
        ['unzip', ['-q', '-o', zipPath, '-d', destDir]],
        ['tar', ['-xf', zipPath, '-C', destDir]],
        ['ditto', ['-x', '-k', zipPath, destDir]],
      ];
  const failures = [];
  for (const [command, args] of attempts) {
    const result = spawnSyncImpl(command, args, { stdio: 'pipe' });
    if (result.error?.code === 'ENOENT') {
      failures.push(`${command}: 不可用`);
      continue;
    }
    if (result.status === 0) return { command, failures };
    failures.push(`${command}: exit ${result.status} ${String(result.stderr ?? '').slice(0, 200)}`);
  }
  return { command: undefined, failures };
}

/**
 * 解包后定位可执行文件。
 *
 * 顺序有讲究：先按**官方期望的版本化文件名**找（Windows 的
 * `Godot_v4.7.2-stable_win64.exe`），再退到宽松匹配（任何 `Godot*`）。
 * 旧实现解包后重新走通用 resolver，官方版本化 exe 在 Windows 上就没被认出来。
 *
 * @param {string} dir 解包目录
 * @param {{version?: string, platform?: NodeJS.Platform, readdir?: (dir: string) => string[],
 *          exists?: (target: string) => boolean}} [options]
 * @returns {string|undefined}
 */
export function locateGodotBinary(dir, options = {}) {
  const {
    version,
    platform = process.platform,
    readdir = target => fs.readdirSync(target),
    exists = target => fs.existsSync(target),
  } = options;
  const candidates = [];
  if (platform === 'darwin') candidates.push(path.join(dir, 'Godot.app', 'Contents', 'MacOS', 'Godot'));
  if (version) {
    for (const name of expectedBinaryNames({ version, platform })) candidates.push(path.join(dir, name));
  }
  let entries = [];
  try {
    entries = readdir(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (/^Godot.*\.exe$/i.test(entry) || /^Godot_v.*/.test(entry) || /^Godot$/i.test(entry)) {
      candidates.push(path.join(dir, entry));
    }
    if (platform === 'darwin' && /^Godot.*\.app$/i.test(entry)) {
      candidates.push(path.join(dir, entry, 'Contents', 'MacOS', 'Godot'));
    }
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}
