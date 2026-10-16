// Windows 路径 / YAML 标量 / 跨平台配置回归。
//
// 背景：`setup.mjs` 会把绝对路径写进**别人的 DSH 配置**（cordis.patch.yml）。
// 旧实现有两个能直接挡住 Windows 的缺陷：
//   1. `validatePatchText` 用「command 必须以 / 开头」判绝对路径 → 正常的
//      `C:\Program Files\nodejs\node.exe` 被判成「缺 command」，自动接线直接失败；
//   2. 路径当普通 YAML 标量输出 → `C:\DSH #1\...` 里的 ` #` 被真实解析器当注释，
//      `C:\DSH` 之后全被截断，而兜底解析器却返回完整字符串（自检与实载不一致）。
// 所以这里既做「真实 YAML 解析器交叉验证」，也做「兜底解析器必须与之一致」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  buildEntryBlock,
  decodeYamlScalar,
  isAbsolutePathValue,
  parseEntryLoose,
  patchPatchText,
  validatePatchText,
  yamlDoubleQuote,
} from '../scripts/lib/profile-patch.mjs';

/**
 * 真实 YAML 解析器。顺序：
 *   1. 仓库自己的 devDependency（CI 里 `npm install` 之后必定可用，不再依赖桌面 profile）；
 *   2. 本机 DSH profile 里的 yaml（本地开发机常见）；
 *   3. python + PyYAML。
 * 都找不到且 GODOT_MCP_REQUIRE_YAML=1 时由调用方断言失败 —— 不允许「没有解析器」静默变成通过。
 */
function loadRealYaml() {
  for (const [name, base] of [
    ['npm:repo-yaml', path.join(process.cwd(), 'package.json')],
    ['npm:dsh-profile-yaml', path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json')],
  ]) {
    try {
      const YAML = createRequire(base)('yaml');
      return { name, parse: text => YAML.parse(text) };
    } catch { /* 试下一个来源 */ }
  }
  for (const python of ['python3', 'python']) {
    try {
      execFileSync(python, ['-c', 'import yaml'], { stdio: 'ignore' });
      return {
        name: `python:${python}+pyyaml`,
        parse: text => JSON.parse(execFileSync(python, ['-c', 'import json,sys,yaml;json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout)'], { input: text, encoding: 'utf8' })),
      };
    } catch { /* 试下一个 */ }
  }
  return undefined;
}

/** 会让普通 YAML 标量解析坏掉的路径集合（平台无关，仅做字符串层面的真实解析）。 */
const TRICKY = [
  ['Windows 盘符 + 空格 + 中文', 'C:\\DSH Tools\\Godot 中文\\node.exe'],
  ['Windows 盘符 + ` #`（普通标量会截断）', 'C:\\DSH #1\\Godot\\node.exe'],
  ['Windows 盘符 + 单引号', "C:\\Users\\O'Brien\\nodejs\\node.exe"],
  ['Windows 盘符 + 冒号', 'C:\\tools\\a:b\\node.exe'],
  ['Windows 盘符 + 反斜杠结尾目录', 'C:\\Program Files\\nodejs\\'],
  ['UNC 共享 + 空格 + `#`', '\\\\build-server\\dsh tools #2\\node.exe'],
  ['POSIX 空格 + 中文 + `#`', '/Users/测 试/dsh #1/node'],
  ['POSIX 单引号 + 双引号', '/Users/o\'brien/"quoted"/node'],
  ['POSIX 反斜杠当普通字符', '/Users/a\\b/node'],
];

test('所有诡异路径都能被双引号标量无损往返（emit → decode）', () => {
  for (const [label, value] of TRICKY) {
    assert.equal(decodeYamlScalar(yamlDoubleQuote(value)), value, label);
  }
  assert.equal(decodeYamlScalar('"a\\nb"'), 'a\nb');
  assert.equal(decodeYamlScalar('"a\\\\b"'), 'a\\b');
  assert.equal(decodeYamlScalar("'it''s'"), "it's");
  assert.equal(decodeYamlScalar('plain   '), 'plain');
  assert.equal(decodeYamlScalar('plain # not a comment-in-value'), 'plain', '普通标量的 ` #` 之后是注释');
});

test('isAbsolutePathValue：盘符 / UNC / POSIX 通过，根相对与相对路径拒绝', () => {
  for (const value of [
    '/usr/local/bin/node',
    'C:\\Program Files\\nodejs\\node.exe',
    'c:/tools/node.exe',
    '\\\\server\\share\\node.exe',
    '//server/share/node.exe',
  ]) {
    assert.equal(isAbsolutePathValue(value), true, value);
  }
  for (const value of ['', 'node', './node', '~/.local/bin/node', '\\Windows\\System32\\cmd.exe', 'C:', 'CH:']) {
    assert.equal(isAbsolutePathValue(value), false, value);
  }
});

test('Windows 盘符路径的条目能通过写入前自检（旧实现会误判缺 command）', () => {
  const block = buildEntryBlock({
    node: 'C:\\Program Files\\nodejs\\node.exe',
    serverEntry: 'C:\\Users\\测 试\\dsh-godot-mcp\\bin\\godot-mcp.mjs',
    cwd: 'C:\\Users\\测 试',
    godotPath: 'C:\\DSH #1\\Godot\\Godot_v4.7.2-stable_win64.exe',
  });
  const valid = validatePatchText(`- insert:\n${block}`);
  assert.deepEqual(valid.problems, []);
  assert.equal(valid.ok, true);

  const unc = buildEntryBlock({
    node: '\\\\build-server\\dsh tools #2\\node.exe',
    serverEntry: '\\\\build-server\\dsh tools #2\\repo\\bin\\godot-mcp.mjs',
    cwd: '\\\\build-server\\dsh tools #2\\repo',
  });
  assert.equal(validatePatchText(`- insert:\n${unc}`).ok, true, 'UNC 路径也必须通过');
});

test('自检仍然抓得住真正的问题（相对路径 / 缺字段 / 缩进错）', () => {
  const bad = buildEntryBlock({ node: 'node', serverEntry: './bin/godot-mcp.mjs', cwd: 'C:\\work' });
  const problems = validatePatchText(`- insert:\n${bad}`).problems.join('; ');
  assert.match(problems, /command 不是绝对路径/);
  assert.match(problems, /args 里有非绝对路径/);
  assert.equal(validatePatchText(`- insert:\n  - id: godot-mcp-client\n`).ok, false, '缩进 2 格必须不合格');
  assert.equal(validatePatchText('- id: ui-chat\n').ok, false, '没有 insert 必须不合格');
});

test('兜底解析器与真实 YAML 解析结果逐字段一致（含诡异路径）', async t => {
  const YAML = loadRealYaml();
  if (!YAML) {
    assert.notEqual(process.env.GODOT_MCP_REQUIRE_YAML, '1', '要求真实 YAML 解析器（GODOT_MCP_REQUIRE_YAML=1）但一个都找不到');
    t.diagnostic('本机与 CI 都没有可用的 YAML 解析器，跳过交叉验证');
    return;
  }
  t.diagnostic(`使用 ${YAML.name} 做交叉验证`);
  for (const [label, value] of TRICKY) {
    const text = `- insert:\n${buildEntryBlock({ node: value, serverEntry: value, cwd: value, godotPath: value })}`;
    const doc = YAML.parse(text);
    const entry = doc.flatMap(item => (Array.isArray(item?.insert) ? item.insert : [])).find(item => item?.id === 'godot-mcp-client');
    assert.ok(entry, `${label}: insert 里必须有条目`);
    assert.equal(entry.config.command, value, `${label}: 真实解析器的 command 必须原样`);
    assert.equal(entry.config.args[0], value, `${label}: 真实解析器的 args[0] 必须原样`);
    assert.equal(entry.config.cwd, value, `${label}: 真实解析器的 cwd 必须原样`);
    assert.equal(entry.config.env.GODOT_MCP_GODOT, value, `${label}: 真实解析器的 env 必须原样`);
    const loose = parseEntryLoose(text);
    assert.equal(loose.command, value, `${label}: 兜底解析器 command 必须与真实解析器一致`);
    assert.equal(loose.env.GODOT_MCP_GODOT, value, `${label}: 兜底解析器 env 必须与真实解析器一致`);
  }
});

test('把 Windows 条目插进真实 profile 文本后，真实解析器看到的仍是完整路径', async t => {
  const YAML = loadRealYaml();
  const realistic = `- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n- insert:\n    - id: codex-shared\n      name: "@hanyangshen/codex-shared"\n      config: {}\n- id: hmr\n  name: "@deepseek-ai/dsh-hmr"\n`;
  const block = buildEntryBlock({
    node: 'C:\\Program Files\\nodejs\\node.exe',
    serverEntry: 'C:\\DSH #1\\repo\\bin\\godot-mcp.mjs',
    cwd: 'C:\\Users\\测 试',
    godotPath: 'C:\\DSH #1\\Godot\\Godot_v4.7.2-stable_win64.exe',
  });
  const result = patchPatchText(realistic, block);
  assert.equal(result.action, 'inserted');
  assert.equal(validatePatchText(result.text).ok, true);
  // 幂等：再写一次不该改动任何字节
  assert.equal(patchPatchText(result.text, block).action, 'unchanged');
  if (!YAML) {
    assert.notEqual(process.env.GODOT_MCP_REQUIRE_YAML, '1');
    t.diagnostic('没有真实 YAML 解析器，只验证了结构自检');
    return;
  }
  const entries = YAML.parse(result.text).flatMap(item => (Array.isArray(item?.insert) ? item.insert : []));
  const entry = entries.find(item => item?.id === 'godot-mcp-client');
  assert.equal(entry.config.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(entry.config.args[0], 'C:\\DSH #1\\repo\\bin\\godot-mcp.mjs');
  assert.equal(entry.config.env.GODOT_MCP_GODOT, 'C:\\DSH #1\\Godot\\Godot_v4.7.2-stable_win64.exe');
});

test('旧实现写下的未引号条目仍能被兜底解析器读出来（向后兼容）', () => {
  const legacy = [
    '- insert:',
    '    - id: godot-mcp-client',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: godot',
    '        transport: stdio',
    '        command: /usr/bin/node',
    '        args:',
    '          - /repo/bin/godot-mcp.mjs',
    '        cwd: /home/someone',
    '        toolCallTimeoutMs: 900000',
    '        env:',
    '          GODOT_MCP_GODOT: /Applications/Godot.app/Contents/MacOS/Godot',
    '',
  ].join('\n');
  const entry = parseEntryLoose(legacy);
  assert.equal(entry.command, '/usr/bin/node');
  assert.deepEqual(entry.args, ['/repo/bin/godot-mcp.mjs']);
  assert.equal(entry.env.GODOT_MCP_GODOT, '/Applications/Godot.app/Contents/MacOS/Godot');
  assert.equal(validatePatchText(legacy).ok, true, '旧格式（含普通标量）也必须判为合格，升级不能反过来拒绝已有配置');
});

test('全新 profile 的 `[]` 空 patch 必须被正确替换（不能拼出非法 YAML）', async t => {
  const block = buildEntryBlock({
    node: 'C:\\Program Files\\nodejs\\node.exe',
    serverEntry: 'C:\\repo\\bin\\godot-mcp.mjs',
    cwd: 'C:\\Users\\测 试',
    godotPath: 'C:\\Godot\\Godot_v4.7.2-stable_win64.exe',
  });
  for (const initial of ['[]', '[]\n', '  []  \n', '', '   \n', '# 只有注释\n', '---\n', 'null\n']) {
    const result = patchPatchText(initial, block);
    assert.equal(result.action, 'created-insert', JSON.stringify(initial));
    assert.equal(/^\s*\[\]\s*$/m.test(result.text), false, `不能在 [] 后面追加：${JSON.stringify(result.text.slice(0, 40))}`);
    assert.equal(validatePatchText(result.text).ok, true, `结构自检必须通过：${JSON.stringify(initial)}`);
    const YAML = loadRealYaml();
    if (YAML) {
      const doc = YAML.parse(result.text);
      assert.ok(Array.isArray(doc), `真实解析器必须看到数组：${JSON.stringify(initial)} → ${JSON.stringify(doc)}`);
      const entry = doc.flatMap(item => (Array.isArray(item?.insert) ? item.insert : [])).find(item => item?.id === 'godot-mcp-client');
      assert.ok(entry, `insert 条目必须存在：${JSON.stringify(initial)}`);
      assert.equal(entry.config.command, 'C:\\Program Files\\nodejs\\node.exe');
    }
  }
  // 幂等：写完再写一次不改变任何字节
  const once = patchPatchText('[]', block);
  assert.equal(patchPatchText(once.text, block).action, 'unchanged');
});
