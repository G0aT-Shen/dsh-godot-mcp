// 在 DSH profile 的 cordis.patch.yml 里写入/更新「godot-mcp-client」条目。
//
// 纯文本变换 + 纯函数：不碰文件系统，便于单测覆盖（改的是别人的 DSH 配置，必须有守卫）。
//
// 文件形态（顶层是 YAML 数组，其中一个元素带 `insert:`，它的值又是数组）：
//
//   - id: ui-chat
//     ...
//   - insert:
//       - id: codex-shared
//         ...
//       - id: godot-mcp-client
//         name: "@deepseek-ai/dsh-mcp-client"
//         config: { ... }
//   - id: hmr
//     ...
//
// 所以条目必须插在 `- insert:` 之后、缩进 4 格的那个子数组里；写错缩进会让 DSH 起不来。

export const ENTRY_ID = 'godot-mcp-client';
export const CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';
export const SERVER_NAME = 'godot';
export const TOOL_CALL_TIMEOUT_MS = 900000;

/** 生成条目上方那段说明注释（缩进 4 格，和 insert 子数组里的条目对齐）。 */
export function buildHeader() {
  return [
    '    # --- dsh-godot-mcp：标准 stdio MCP server（由 scripts/setup.mjs 写入/更新）---',
    '    # command 必须是绝对路径：mcp-client 用 scrubbedParentEnv() 起子进程，PATH 里的 node 不可依赖。',
    `    # toolCallTimeoutMs 放宽到 ${TOOL_CALL_TIMEOUT_MS}：默认 60s 对 run_project / export_project 不够。`,
  ].join('\n');
}

/**
 * 生成 `    - id: godot-mcp-client` 整个条目块（含结尾换行）。
 * @param {{node: string, serverEntry: string, cwd: string, godotPath?: string}} options
 */
export function buildEntryBlock({ node, serverEntry, cwd, godotPath }) {
  const lines = [
    `    - id: ${ENTRY_ID}`,
    `      name: "${CLIENT_PACKAGE}"`,
    '      config:',
    `        serverName: ${SERVER_NAME}`,
    '        transport: stdio',
    `        command: ${node}`,
    '        args:',
    `          - ${serverEntry}`,
    `        cwd: ${cwd}`,
    `        toolCallTimeoutMs: ${TOOL_CALL_TIMEOUT_MS}`,
  ];
  // 只有「靠环境变量才找到 Godot」时才钉进 env —— DSH 起子进程用 scrubbedParentEnv，
  // 环境变量不会传下去，不钉就会在运行时找不到引擎。
  if (godotPath) lines.push('        env:', `          GODOT_MCP_GODOT: ${godotPath}`);
  return `${lines.join('\n')}\n`;
}

/**
 * 把条目写进 patch 文本。
 * @param {string} text 现有文件内容（文件不存在时传空串）
 * @param {string} block {@link buildEntryBlock} 的结果
 * @returns {{text: string, action: 'unchanged'|'updated'|'inserted'|'created-insert'}}
 */
export function patchPatchText(text, block) {
  const lines = text.length ? text.split('\n') : [];
  const header = buildHeader();
  const insertIndex = lines.findIndex(line => /^- insert:\s*$/.test(line));

  if (insertIndex < 0) {
    // 注释头必须写在 `- insert:` **之后**（它缩进 4 格，是 insert 子数组里的一员）
    const addition = ['- insert:', header, block.trimEnd(), ''].join('\n');
    const base = text.replace(/\s*$/, '');
    return { text: base.length ? `${base}\n${addition}` : addition, action: 'created-insert' };
  }

  // insert 子数组的范围：从 `- insert:` 下一行起，直到出现下一个顶层条目（缩进 < 4 的非空非注释行）
  let regionEnd = insertIndex + 1;
  while (regionEnd < lines.length) {
    const line = lines[regionEnd];
    if (line.trim() === '' || /^\s{4,}/.test(line) || /^\s*#/.test(line)) {
      regionEnd += 1;
      continue;
    }
    break;
  }

  const entryStart = lines.findIndex(
    (line, index) => index > insertIndex && index < regionEnd && new RegExp(`^ {4}- id: ${ENTRY_ID}\\s*$`).test(line),
  );
  const blockLines = block.trimEnd().split('\n');

  if (entryStart >= 0) {
    let entryEnd = entryStart + 1;
    while (entryEnd < regionEnd && !/^ {4}- /.test(lines[entryEnd])) entryEnd += 1;
    // 条目尾部若带着空行（上一版写进来的），回退掉 —— 否则 `existing` 永远不等于 block，
    // 每次跑都会判成「需要更新」，幂等性就没了。
    while (entryEnd > entryStart + 1 && lines[entryEnd - 1].trim() === '') entryEnd -= 1;
    if (lines.slice(entryStart, entryEnd).join('\n').trimEnd() === block.trimEnd()) {
      return { text, action: 'unchanged' };
    }
    // 条目上方若已有连着写的注释块（旧的或本脚本写的），一并替换，避免注释越堆越多
    let commentStart = entryStart;
    while (commentStart > insertIndex + 1 && /^\s*#/.test(lines[commentStart - 1])) commentStart -= 1;
    const next = [...lines.slice(0, commentStart), ...header.split('\n'), ...blockLines, ...lines.slice(entryEnd)];
    return { text: next.join('\n'), action: 'updated' };
  }

  // 追加到 insert 块末尾：注释头一起写进去，别人的文件排版保持原样（不多插空行）
  const next = [...lines.slice(0, regionEnd), ...header.split('\n'), ...blockLines, ...lines.slice(regionEnd)];
  return { text: next.join('\n'), action: 'inserted' };
}

/**
 * 结构自检：确认文本里确实有指向本仓库、且关键字段齐全的条目。
 * 不依赖 YAML 解析器（仓库存放时零依赖），但会检查缩进与字段。
 * @param {string} text
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validatePatchText(text) {  const lines = text.split('\n');
  const problems = [];
  const insertIndex = lines.findIndex(line => /^- insert:\s*$/.test(line));
  if (insertIndex < 0) problems.push('缺少顶层 `- insert:`');
  const entryIndex = lines.findIndex(line => new RegExp(`^ {4}- id: ${ENTRY_ID}\\s*$`).test(line));
  if (entryIndex < 0) problems.push(`缺少条目 ${ENTRY_ID}（或缩进不是 4 格）`);
  const slice = entryIndex >= 0 ? lines.slice(entryIndex, entryIndex + 14).join('\n') : '';
  for (const [label, pattern] of [
    ['name', new RegExp(`^ {6}name: "?${CLIENT_PACKAGE.replace(/[/@]/g, m => `\\${m}`)}"?`, 'm')],
    ['serverName', new RegExp(`^ {8}serverName: ${SERVER_NAME}$`, 'm')],
    ['transport', /^ {8}transport: stdio$/m],
    ['command', /^ {8}command: \//m],
    ['args', /^ {8}args:$/m],
    ['toolCallTimeoutMs', /^ {8}toolCallTimeoutMs: \d+$/m],
  ]) {
    if (!pattern.test(slice)) problems.push(`条目里缺 ${label}（或缩进不对）`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 没有 YAML 解析器时的兜底读取：只按缩进取本条目里我们关心的那几个标量/列表项。
 * 比真正的解析器弱，但足以让自检在「全新 profile 还没有 node_modules」时也能跑完。
 * @param {string} text
 * @returns {{id: string, name?: string, serverName?: string, transport?: string, command?: string, args: string[], cwd?: string, toolCallTimeoutMs?: number, env?: Record<string,string>}|undefined}
 */
export function parseEntryLoose(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => new RegExp(`^ {4}- id: ${ENTRY_ID}\\s*$`).test(line));
  if (start < 0) return undefined;

  // 条目范围：到下一个 4 格缩进的兄弟条目为止
  let end = start + 1;
  while (end < lines.length && !/^ {4}- /.test(lines[end])) end += 1;

  const entry = { id: ENTRY_ID, args: [] };
  let section = '';
  for (const raw of lines.slice(start + 1, end)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 8 && body === 'env:') {
      section = 'env';
      entry.env = {};
      continue;
    }
    if (indent === 8 && body === 'args:') {
      section = 'args';
      continue;
    }
    if (indent === 10 && section === 'args' && body.startsWith('- ')) {
      entry.args.push(body.slice(2).trim());
      continue;
    }
    if (indent === 10 && section === 'env' && body.includes(':')) {
      const [key, ...rest] = body.split(':');
      entry.env[key.trim()] = rest.join(':').trim();
      continue;
    }
    if (indent === 6 || indent === 8) section = '';
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(body);
    if (!match) continue;
    const [, key, value] = match;
    const clean = value.replace(/^["']|["']$/g, '');
    if (indent === 6 && key === 'name') entry.name = clean;
    if (indent === 8 && key === 'serverName') entry.serverName = clean;
    if (indent === 8 && key === 'transport') entry.transport = clean;
    if (indent === 8 && key === 'command') entry.command = clean;
    if (indent === 8 && key === 'cwd') entry.cwd = clean;
    if (indent === 8 && key === 'toolCallTimeoutMs') entry.toolCallTimeoutMs = Number(clean);
  }
  return entry;
}
