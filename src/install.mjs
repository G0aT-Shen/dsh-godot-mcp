// 把编辑器桥（L2）与运行时桥（L3）自动安装进任意 Godot 项目。
//
// 为什么需要它：如果装桥要靠人手工复制文件 + 手点插件开关，那「全盘控制」就是假的
// —— 我建完项目后没法自己打开编辑器去实时改场景。这个模块让整条链路可由工具完成：
//   create_project → installBridge → session(editor) → connect(editor, ...) → session(game) → connect(runtime, ...)
//
// 安装动作（幂等，可反复调用）：
//   1. 复制 godot/addon/addons/godot_mcp_bridge → <project>/addons/godot_mcp_bridge
//   2. 复制 godot/runtime/godot_mcp_runtime.gd → <project>/addons/godot_mcp_bridge/runtime/
//   3. 在 project.godot 写入：
//        [editor_plugins]  enabled=PackedStringArray("res://addons/godot_mcp_bridge/plugin.cfg")
//        [autoload]        McpRuntime="*res://addons/godot_mcp_bridge/runtime/godot_mcp_runtime.gd"
//   4. 返回一份「装了什么/下一步做什么」的说明
//
// 注意：project.godot 是 INI 格式且 **键顺序敏感度低但节重复会出错**，
// 所以这里用「按节重写」而不是「追加」，保证多次调用不产生重复节。

import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PACKAGE_ROOT } from './godot.mjs';

/** 内容指纹：用于判断项目内已装的桥是否与当前版本一致。 */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export const ADDON_RELATIVE = path.join('addons', 'godot_mcp_bridge');
export const PLUGIN_CONFIG_RES = 'res://addons/godot_mcp_bridge/plugin.cfg';
export const RUNTIME_AUTOLOAD_NAME = 'McpRuntime';
export const RUNTIME_SCRIPT_RES = 'res://addons/godot_mcp_bridge/runtime/godot_mcp_runtime.gd';

const ADDON_SOURCE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'godot', 'addon', 'addons', 'godot_mcp_bridge'),
  path.join(PACKAGE_ROOT, 'godot', 'addon', 'godot_mcp_bridge'),
  path.join(PACKAGE_ROOT, 'godot', 'addon'),
];
const RUNTIME_SOURCE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'godot', 'runtime'),
  path.join(PACKAGE_ROOT, 'godot', 'addon', 'runtime'),
];

/** 找到含 plugin.cfg 的 addon 源目录（仓库里两种布局都容忍）。 */
async function findAddonSource() {
  for (const candidate of ADDON_SOURCE_CANDIDATES) {
    if (await exists(path.join(candidate, 'plugin.cfg'))) return candidate;
  }
  return undefined;
}

async function findRuntimeSource() {
  for (const candidate of RUNTIME_SOURCE_CANDIDATES) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function exists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 安装/更新桥到目标项目。
 * @param {string} projectPath 项目根目录（含 project.godot）
 * @param {{runtime?: boolean, editor?: boolean}} [options] 默认两者都装
 * @returns {Promise<object>} 结构化安装报告；任何缺失的源文件如实报告为 missing 而不是假装成功
 */
export async function installBridge(projectPath, options = {}) {
  const wantEditor = options.editor !== false;
  const wantRuntime = options.runtime !== false;
  const report = {
    project: projectPath,
    copied: [],
    missing: [],
    settings: { editorPlugins: false, autoload: false },
    warnings: [],
  };

  const addonTarget = path.join(projectPath, ADDON_RELATIVE);
  const addonSource = await findAddonSource();
  const runtimeSource = await findRuntimeSource();

  // 1. 编辑器插件
  if (wantEditor) {
    if (addonSource) {
      await fsp.mkdir(path.dirname(addonTarget), { recursive: true });
      // 用 force:true 覆盖旧版本，保证「更新桥」与「安装」是同一条路径。
      await fsp.cp(addonSource, addonTarget, { recursive: true, force: true });
      report.copied.push({ from: addonSource, to: addonTarget });
    } else {
      report.missing.push(ADDON_SOURCE_CANDIDATES[0]);
      report.warnings.push('编辑器桥源码不存在，L2 编辑器实时控制将不可用');
    }
  }

  // 2. 运行时桥（autoload 脚本）
  //
  // 这里必须处理「已装过旧版本」的情况，而不只是「装或没装」。
  // 真实事故：运行时桥的无鉴权监听是一个安全缺陷，修复后只更新了仓库里的源文件；
  // 而**早已用 setup 装过桥的项目，其项目内副本仍是旧的、有缺陷的版本** ——
  // 直接导出就会把旧后门打进成品。所以这里对比新旧内容指纹并如实报告是否更新了旧副本。
  if (wantRuntime) {
    const runtimeFile = await findRuntimeScript(runtimeSource);
    if (runtimeFile) {
      const runtimeTarget = path.join(addonTarget, 'runtime', path.basename(runtimeFile));
      await fsp.mkdir(path.dirname(runtimeTarget), { recursive: true });
      const incoming = await fsp.readFile(runtimeFile);
      const previous = await fsp.readFile(runtimeTarget).catch(() => undefined);
      report.bridge = {
        installedSha256: sha256(incoming),
        bytes: incoming.length,
        existedBefore: previous !== undefined,
        replacedStale: previous !== undefined && sha256(previous) !== sha256(incoming),
        previousSha256: previous === undefined ? null : sha256(previous),
      };
      await fsp.writeFile(runtimeTarget, incoming);
      report.copied.push({ from: runtimeFile, to: runtimeTarget });
      if (report.bridge.replacedStale) {
        report.warnings.push(
          '项目里原本有一份**不同内容**的运行时桥，已覆盖为新版本。' +
            '如果你之前用旧版桥导出过成品，那些成品里含旧桥（旧版在 release 构建中会无条件开监听端口），请重新导出。',
        );
      }
    } else {
      report.missing.push(RUNTIME_SOURCE_CANDIDATES[0]);
      report.warnings.push('运行时桥脚本不存在，L3 运行中游戏控制将不可用');
    }
  }

  // 3. 写 project.godot
  const projectFile = path.join(projectPath, 'project.godot');
  if (!(await exists(projectFile))) {
    return {
      ok: false,
      code: 'NO_PROJECT_FILE',
      error: `${projectPath} 下没有 project.godot；先用 create_project 建项目`,
      ...report,
    };
  }

  const original = await fsp.readFile(projectFile, 'utf8');
  let updated = original;

  if (wantEditor && (await exists(path.join(addonTarget, 'plugin.cfg')))) {
    updated = upsertIniSetting(updated, 'editor_plugins', 'enabled', `PackedStringArray("${PLUGIN_CONFIG_RES}")`, {
      arrayAppendValue: PLUGIN_CONFIG_RES,
    });
    report.settings.editorPlugins = true;
  }

  const runtimeScript = await findRuntimeScript(runtimeSource);
  if (wantRuntime && runtimeScript) {
    const scriptName = path.basename(runtimeScript);
    updated = upsertIniSetting(
      updated,
      'autoload',
      RUNTIME_AUTOLOAD_NAME,
      `"*res://addons/godot_mcp_bridge/runtime/${scriptName}"`,
    );
    report.settings.autoload = true;
  }

  if (updated !== original) {
    // 备份一次原文件，便于用户对照/回滚（只在没有备份时写，避免反复覆盖好的备份）。
    const backup = `${projectFile}.before-godot-mcp`;
    if (!(await exists(backup))) await fsp.copyFile(projectFile, backup);
    await fsp.writeFile(projectFile, updated, 'utf8');
    report.projectFileUpdated = true;
  } else {
    report.projectFileUpdated = false;
  }

  return {
    ok: report.missing.length === 0,
    ...report,
    next: [
      `编辑器实时控制：用 godot_session(action="editor") 打开编辑器，桥会监听 127.0.0.1:9089`,
      `运行中游戏控制：用 godot_session(action="game") 启动游戏，桥会监听 127.0.0.1:9091`,
      `然后用 godot_connect(target="editor"|"runtime", op=...)`,
    ],
  };
}

/** 运行时脚本可能在 runtime/ 根下用不同文件名，做一次发现。 */
async function findRuntimeScript(source) {
  if (!source) return undefined;
  const direct = path.join(source, 'godot_mcp_runtime.gd');
  if (await exists(direct)) return direct;
  const entries = await fsp.readdir(source, { withFileTypes: true });
  const candidate = entries.find(entry => entry.isFile() && entry.name.endsWith('.gd'));
  return candidate ? path.join(source, candidate.name) : undefined;
}

/**
 * 在 INI 文本里设置 key=value，保持其余内容不变。
 * - 节不存在则追加到文件末尾；
 * - 键不存在则在所属节末尾插入；
 * - 键已存在则替换整行（这才是幂等的关键）。
 *
 * @param {string} text project.godot 原文
 * @param {string} section 节名，如 'autoload'
 * @param {string} key 键名
 * @param {string} value 值（已带引号/PackedStringArray 等字面量包装）
 * @param {{arrayAppendValue?: string}} [options] 若给出，则把一个值并入已有 PackedStringArray
 */
export function upsertIniSetting(text, section, key, value, options = {}) {
  const lines = text.split('\n');
  const header = `[${section}]`;
  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (trimmed === header) {
      sectionStart = index;
      for (let scan = index + 1; scan < lines.length; scan++) {
        if (/^\s*\[.+\]\s*$/.test(lines[scan])) {
          sectionEnd = scan;
          break;
        }
      }
      break;
    }
  }

  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);

  if (sectionStart === -1) {
    // 节不存在：追加新节（保留文件末尾换行习惯）
    const needsLeadingBlank = lines.length > 0 && lines[lines.length - 1].trim() !== '';
    const block = [header, `${key}=${value}`];
    if (needsLeadingBlank) lines.push('');
    lines.push(...block);
    return lines.join('\n');
  }

  for (let index = sectionStart + 1; index < sectionEnd; index++) {
    if (!keyPattern.test(lines[index])) continue;
    if (options.arrayAppendValue !== undefined) {
      lines[index] = `${key}=${mergePackedStringArray(lines[index], options.arrayAppendValue)}`;
    } else {
      lines[index] = `${key}=${value}`;
    }
    return lines.join('\n');
  }

  // 键不存在：插到该节末尾
  lines.splice(sectionEnd, 0, `${key}=${value}`);
  return lines.join('\n');
}

/**
 * 把一个值并入已有的 PackedStringArray(...) 字面量；已存在则不重复添加。
 * 解析不了时回退为只包含该值的新数组。
 */
function mergePackedStringArray(existingLine, addition) {
  const match = /PackedStringArray\((.*)\)\s*$/.exec(existingLine.trim());
  if (!match) return `PackedStringArray("${addition}")`;
  const inner = match[1].trim();
  const items = inner.length === 0 ? [] : inner.split(',').map(item => item.trim().replace(/^"|"$/g, ''));
  if (items.includes(addition)) {
    return `PackedStringArray(${items.map(item => `"${item}"`).join(', ')})`;
  }
  items.push(addition);
  return `PackedStringArray(${items.map(item => `"${item}"`).join(', ')})`;
}
