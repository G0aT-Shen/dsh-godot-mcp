// profile 补丁逻辑的单测。
//
// 为什么单独守这块：setup.mjs 会去改**别人的 DSH 配置**（cordis.patch.yml）。
// 缩进错一格、把别人的条目吃掉、把 insert 块插到错误的位置，后果都是「DSH 起不来」，
// 而且很难和「我改了插件」联系起来。所以这里用真实文件形态做回归。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  ENTRY_ID,
  buildEntryBlock,
  buildHeader,
  parseEntryLoose,
  patchPatchText,
  validatePatchText,
} from '../scripts/lib/profile-patch.mjs';

const BLOCK = buildEntryBlock({
  node: '/usr/local/bin/node',
  serverEntry: '/repos/dsh-godot-mcp/bin/godot-mcp.mjs',
  cwd: '/home/someone',
});

/** 一份贴近真实的 profile：顶层是数组，中间那个元素带 insert 子数组。 */
const REALISTIC = `- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
- insert:
    - id: codex-shared
      name: "@hanyangshen/codex-shared"
      config: {}
    - id: codex-shared-mcp-lms
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: codex_lms
        transport: stdio
        command: /usr/bin/lms
        args:
          - mcp
- id: hmr
  name: "@deepseek-ai/dsh-hmr"
  config:
    root:
      - /repos/dsh-codex-bridge
`;

/** 真实 YAML 解析器：仓库 devDependency 优先，其次本机 DSH profile。 */
function loadYaml() {
  for (const base of [path.join(process.cwd(), 'package.json'), path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json')]) {
    try {
      return createRequire(base)('yaml');
    } catch { /* 试下一个来源 */ }
  }
  return undefined;
}

test('条目块的结构与关键字段齐全', () => {
  const valid = validatePatchText(`- insert:\n${BLOCK}`);
  assert.deepEqual(valid.problems, []);
  assert.equal(valid.ok, true);
  assert.match(BLOCK, new RegExp(`^ {4}- id: ${ENTRY_ID}$`, 'm'));
  assert.match(BLOCK, /^ {8}transport: stdio$/m);
  assert.match(BLOCK, /^ {8}toolCallTimeoutMs: 900000$/m);
  // Godot 路径是可选的，但给了就必须是 env.GODOT_MCP_GODOT
  const pinned = buildEntryBlock({
    node: '/usr/local/bin/node',
    serverEntry: '/repos/x/bin/godot-mcp.mjs',
    cwd: '/home/someone',
    godotPath: '/Applications/Godot.app/Contents/MacOS/Godot',
  });
  assert.match(pinned, /^ {8}env:$/m);
  assert.match(pinned, /^ {10}GODOT_MCP_GODOT: "\/Applications\/Godot\.app\/Contents\/MacOS\/Godot"$/m);
});

test('把条目插进已有的 insert 子数组，且不碰别人任何一行', () => {
  const result = patchPatchText(REALISTIC, BLOCK);
  assert.equal(result.action, 'inserted');
  assert.deepEqual(validatePatchText(result.text).problems, []);

  // 别人的条目与后续顶层条目都还在
  assert.match(result.text, /- id: codex-shared\n/);
  assert.match(result.text, /- id: codex-shared-mcp-lms\n/);
  assert.match(result.text, /- id: hmr\n/);
  assert.match(result.text, /root:\n {6}- \/repos\/dsh-codex-bridge\n/);

  // 条目必须落在 insert 块内部：在 - id: hmr 之前，且在 lms 条目之后
  const entryAt = result.text.indexOf(`- id: ${ENTRY_ID}`);
  assert.ok(entryAt > result.text.indexOf('- id: codex-shared-mcp-lms'));
  assert.ok(entryAt < result.text.indexOf('- id: hmr'));

  // 逐字节等于「原文 + 在 insert 块末尾插入的注释与条目」—— 保证没碰别人任何一行、也没多出空行
  const expected = REALISTIC.replace(
    '- id: hmr\n',
    `${buildHeader()}\n${BLOCK.trimEnd()}\n- id: hmr\n`,
  );
  assert.equal(result.text, expected);
});

test('幂等：同一份内容再写一次不改任何字节', () => {
  const once = patchPatchText(REALISTIC, BLOCK);
  const twice = patchPatchText(once.text, BLOCK);
  assert.equal(twice.action, 'unchanged');
  assert.equal(twice.text, once.text);
});

test('已存在的旧条目会被就地替换（含它上面的注释），位置不变', () => {
  const withStale = REALISTIC.replace(
    '    - id: codex-shared-mcp-lms',
    `    # 旧注释：上一版写的\n    - id: ${ENTRY_ID}\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: godot\n        transport: stdio\n        command: /old/node\n        args:\n          - /old/path/godot-mcp.mjs\n        toolCallTimeoutMs: 60000\n    - id: codex-shared-mcp-lms`,
  );
  const result = patchPatchText(withStale, BLOCK);
  assert.equal(result.action, 'updated');
  assert.deepEqual(validatePatchText(result.text).problems, []);
  assert.equal(result.text.includes('/old/node'), false);
  assert.equal(result.text.includes('旧注释'), false, '旧注释应被一起替换，不该越堆越多');
  assert.match(result.text, /toolCallTimeoutMs: 900000/);
  // 顺序没乱
  assert.ok(result.text.indexOf(`- id: ${ENTRY_ID}`) < result.text.indexOf('- id: codex-shared-mcp-lms'));
  assert.match(result.text, /- id: hmr\n/);
});

test('文件里没有 insert 块时，新建一个只含本条的 insert（原内容保持在前）', () => {
  const withoutInsert = '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n';
  const result = patchPatchText(withoutInsert, BLOCK);
  assert.equal(result.action, 'created-insert');
  assert.deepEqual(validatePatchText(result.text).problems, []);
  assert.ok(result.text.startsWith(withoutInsert.trimEnd()));
  assert.match(result.text, /^- insert:$/m);
});

test('空文件（profile 里还没有 cordis.patch.yml）也能写出合法结构', () => {
  const result = patchPatchText('', BLOCK);
  assert.equal(result.action, 'created-insert');
  assert.deepEqual(validatePatchText(result.text).problems, []);
  // 顶层必须是数组：第一行就是 - insert:
  assert.equal(result.text.split('\n').filter(line => /^- insert:$/.test(line)).length, 1);
});

test('结构自检能抓出缩进错与缺字段（防止把坏 YAML 写进别人的配置）', () => {
  assert.equal(validatePatchText(`- insert:\n  - id: ${ENTRY_ID}\n`).ok, false, '缩进 2 格必须被判为不合格');
  assert.equal(validatePatchText(`- insert:\n${BLOCK.replace('        transport: stdio\n', '')}`).ok, false, '缺字段必须被判为不合格');
  assert.equal(validatePatchText('- id: ui-chat\n').ok, false, '没有 insert 必须被判为不合格');
});

test('本机有真实 YAML 解析器时，交叉验证生成结果是合法 YAML 且条目可读', async t => {
  const YAML = loadYaml();
  if (!YAML) {
    assert.notEqual(process.env.GODOT_MCP_REQUIRE_YAML, '1', '要求真实 YAML 解析器（GODOT_MCP_REQUIRE_YAML=1）但一个都找不到');
    t.diagnostic('本机没有可用的 yaml 包，跳过交叉验证（结构自检仍已覆盖）');
    return;
  }
  const result = patchPatchText(REALISTIC, BLOCK);
  const doc = YAML.parse(result.text);
  assert.ok(Array.isArray(doc), '顶层必须是数组');
  const entries = doc.flatMap(item => (Array.isArray(item?.insert) ? item.insert : []));
  const entry = entries.find(item => item?.id === ENTRY_ID);
  assert.ok(entry, 'insert 里必须有 godot-mcp-client');
  assert.equal(entry.name, '@deepseek-ai/dsh-mcp-client');
  assert.equal(entry.config.serverName, 'godot');
  assert.equal(entry.config.transport, 'stdio');
  assert.equal(entry.config.toolCallTimeoutMs, 900000);
  assert.ok(path.isAbsolute(entry.config.command));
  assert.ok(path.isAbsolute(entry.config.args[0]));
  // 别人的条目没被弄坏
  assert.ok(entries.some(item => item?.id === 'codex-shared-mcp-lms'));
  assert.ok(doc.some(item => item?.id === 'hmr'));

  // 也验证「没有 insert 块」的写入路径
  const fresh = YAML.parse(patchPatchText('', BLOCK).text);
  assert.ok(Array.isArray(fresh) && fresh[0].insert.length === 1);
});

test('生成的条目块能被写进临时目录后再读回（round-trip 不丢换行）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-patch-'));
  try {
    const file = path.join(dir, 'cordis.patch.yml');
    const result = patchPatchText(REALISTIC, BLOCK);
    await fsp.writeFile(file, result.text, 'utf8');
    const read = await fsp.readFile(file, 'utf8');
    assert.equal(read, result.text);
    assert.equal(patchPatchText(read, BLOCK).action, 'unchanged');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('没有 YAML 解析器时的兜底读取（全新 profile 还没装 node_modules）', () => {
  const text = patchPatchText(REALISTIC, BLOCK).text;
  const entry = parseEntryLoose(text);
  assert.ok(entry, '必须能从文本里按缩进读出条目');
  assert.equal(entry.id, 'godot-mcp-client');
  assert.equal(entry.name, '@deepseek-ai/dsh-mcp-client');
  assert.equal(entry.serverName, 'godot');
  assert.equal(entry.transport, 'stdio');
  assert.equal(entry.command, '/usr/local/bin/node');
  assert.deepEqual(entry.args, ['/repos/dsh-godot-mcp/bin/godot-mcp.mjs']);
  assert.equal(entry.cwd, '/home/someone');
  assert.equal(entry.toolCallTimeoutMs, 900000);
  // 别人的条目不受影响：读到的必须是本条目，而不是它前面的 lms 条目
  assert.notEqual(entry.serverName, 'codex_lms');
});

test('兜底读取也能拿到 env 里的 Godot 路径（钉定时）', () => {
  const pinned = buildEntryBlock({
    node: '/usr/local/bin/node',
    serverEntry: '/repos/x/bin/godot-mcp.mjs',
    cwd: '/home/someone',
    godotPath: '/Applications/Godot.app/Contents/MacOS/Godot',
  });
  const entry = parseEntryLoose(`- insert:\n${pinned}`);
  assert.equal(entry.env?.GODOT_MCP_GODOT, '/Applications/Godot.app/Contents/MacOS/Godot');
});

test('新建文件时注释头必须落在 `- insert:` 之后（缩进 4 格）', () => {
  const text = patchPatchText('', BLOCK).text;
  const lines = text.split('\n');
  const insertAt = lines.findIndex(line => line === '- insert:');
  const headerAt = lines.findIndex(line => line.startsWith('    # --- dsh-godot-mcp'));
  assert.ok(insertAt >= 0 && headerAt >= 0, '两者都要存在');
  assert.ok(headerAt > insertAt, '注释是 insert 子数组的一员，必须排在 - insert: 之后');
  assert.equal(parseEntryLoose(text)?.serverName, 'godot');
});
