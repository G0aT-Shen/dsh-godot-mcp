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

/**
 * 把值写成 YAML **双引号风格**标量。
 *
 * 为什么路径必须引号化：`C:\DSH #1\Godot` 这类路径在普通（plain）标量里
 * ` #` 之后会被当成注释，真实 YAML 解析器只读到 `C:\DSH`；反斜杠在双引号风格里
 * 也必须转义，否则 `\n`、`\t` 会被解析成控制字符。
 *
 * 只用双引号风格还有一个好处：YAML 规范化后**没有歧义**，不需要再猜
 * plain/single/folded 的边界情况，兜底解析器（{@link decodeYamlScalar}）
 * 与真实解析器能给出同一结果。
 *
 * @param {unknown} value
 * @returns {string} 带引号的标量（含首尾双引号）
 */
export function yamlDoubleQuote(value) {
  let out = '"';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * 解析「一个单行标量」——双引号 / 单引号 / 普通三种风格。
 * 与 {@link yamlDoubleQuote} 严格互逆（本仓库写出去的永远是双引号风格）。
 * @param {string} raw 冒号或 `- ` 之后的原始文本（可含行尾空白）
 * @returns {string}
 */
export function decodeYamlScalar(raw) {
  const text = String(raw ?? '').trim();
  if (text.startsWith('"')) {
    let out = '';
    for (let i = 1; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '"') break; // 收尾引号：其后应为注释或空
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const next = text[i + 1];
      i += 1;
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === '0') out += '\0';
      else if (next === 'x') {
        out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 3), 16) || 0);
        i += 2;
      } else if (next === 'u') {
        out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 5), 16) || 0);
        i += 4;
      } else if (next === undefined) out += '\\';
      else out += next; // \\ \" \/ 等：原样还原
    }
    return out;
  }
  if (text.startsWith("'")) {
    // 单引号风格：只有 '' 一种转义
    let body = text.slice(1);
    const closing = body.lastIndexOf("'");
    if (closing >= 0) body = body.slice(0, closing);
    return body.replace(/''/g, "'");
  }
  // 普通风格：` #` 起是注释
  const hash = text.search(/\s#/);
  return (hash >= 0 ? text.slice(0, hash) : text).trim();
}

/**
 * 判断一个值是不是绝对路径。跨平台判定，用于**校验**别的机器上写下的配置：
 *   - POSIX：`/dir/node`
 *   - Windows 盘符：`C:\dir\node.exe`、`C:\dir`、`c:/dir/node.exe`
 *   - UNC：`\\server\share\node.exe`、`//server/share/node.exe`
 * 不接受 `~`、相对路径、单独的 `\dir`（无盘符的根相对路径在 Windows 上依赖当前盘，
 * 属于「看起来像绝对路径其实不是」的坑）。
 * @param {string} value
 * @returns {boolean}
 */
export function isAbsolutePathValue(value) {
  const text = String(value ?? '');
  if (!text) return false;
  if (text.startsWith('/')) return true; // POSIX 或 UNC 的 //server/share 形态
  if (/^[A-Za-z]:[\\/]/.test(text)) return true;
  if (/^\\\\[^\\/]+[\\/][^\\/]+/.test(text)) return true; // \\server\share
  return false;
}

/** 生成条目上方那段说明注释（缩进 4 格，和 insert 子数组里的条目对齐）。 */
export function buildHeader() {
  return [
    '    # --- dsh-godot-mcp：标准 stdio MCP server（由 scripts/setup.mjs 写入/更新）---',
    '    # command 必须是绝对路径：mcp-client 用 scrubbedParentEnv() 起子进程时环境不可假定，',
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
    `      name: ${yamlDoubleQuote(CLIENT_PACKAGE)}`,
    '      config:',
    `        serverName: ${SERVER_NAME}`,
    '        transport: stdio',
    `        command: ${yamlDoubleQuote(node)}`,
    '        args:',
    `          - ${yamlDoubleQuote(serverEntry)}`,
    `        cwd: ${yamlDoubleQuote(cwd)}`,
    `        toolCallTimeoutMs: ${TOOL_CALL_TIMEOUT_MS}`,
  ];
  // 钉进 env：mcp-client 会用 scrubbedParentEnv() 起子进程（环境不可假定，我们不去猜
  // 它到底过滤了什么），所以把要用的引擎路径**显式写进配置**，不依赖继承。
  // 路径一律双引号：Windows 盘符路径里的 ` #`、反斜杠、空格、中文在普通标量下都会被解析坏。
  if (godotPath) lines.push('        env:', `          GODOT_MCP_GODOT: ${yamlDoubleQuote(godotPath)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * 判断 patch 文件是不是「空文档」。
 *
 * 真实场景：全新 profile 里 `cordis.patch.yml` 的内容是 `[]`（合法的空 YAML 数组）。
 * 旧实现只判「文本是否为空串」，于是把它当成有内容，拼成
 * `[]\n- insert:` —— 一个 flow sequence 后面跟 block sequence，**非法 YAML**，
 * DSH 直接起不来。这里把 `[]`、纯空白、纯注释、`---`/`null` 都视为空。
 */
export function isEmptyPatchDocument(text) {
  const withoutComments = String(text ?? '')
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
  const normalized = withoutComments
    .replace(/^---\s*$/gm, '')
    .replace(/^\.\.\.\s*$/gm, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  return normalized === '' || normalized === '[]' || normalized === 'null' || normalized === '~';
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
    // 空文档（空串 / 纯空白 / `[]` / 纯注释）直接整体替换，绝不在后面追加 ——
    // 往 `[]` 后面接 `- insert:` 会写出非法 YAML。
    if (isEmptyPatchDocument(text)) return { text: addition, action: 'created-insert' };
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
 *
 * 这里的判定**基于解析结果**（{@link parseEntryLoose}），不是基于「行首是不是斜杠」
 * 之类的正则 —— 旧实现要求 command 以 `/` 开头，于是完全正常的
 * `C:\Program Files\nodejs\node.exe` 会被判成「缺 command」，直接把 Windows 上的
 * 自动接线挡死。解析器与真实 YAML 读取保持一致（我们只写双引号风格标量），
 * 自检结论才等于 DSH 实际加载到的东西。
 *
 * @param {string} text
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validatePatchText(text) {
  const lines = String(text ?? '').split('\n');
  const problems = [];
  const insertIndex = lines.findIndex(line => /^- insert:\s*$/.test(line));
  if (insertIndex < 0) problems.push('缺少顶层 `- insert:`');
  const indented = lines.findIndex(line => new RegExp(`^ {4}- id: ${ENTRY_ID}\\s*$`).test(line));
  if (indented < 0) problems.push(`缺少条目 ${ENTRY_ID}（或缩进不是 4 格）`);

  const entry = parseEntryLoose(text);
  if (!entry) {
    return { ok: false, problems };
  }
  const config = { ...(entry.config ?? entry) };
  const push = message => { if (!problems.includes(message)) problems.push(message); };
  if (entry.name !== CLIENT_PACKAGE) push(`name 不是 ${CLIENT_PACKAGE}（读到 ${JSON.stringify(entry.name)}）`);
  if (config.serverName !== SERVER_NAME) push(`serverName 不是 ${SERVER_NAME}`);
  if (config.transport !== 'stdio') push('transport 不是 stdio');
  if (!config.command) push('缺 command');
  else if (!isAbsolutePathValue(config.command)) push(`command 不是绝对路径（读到 ${JSON.stringify(config.command)}）`);
  const args = config.args ?? [];
  if (!Array.isArray(args) || args.length === 0) push('args 为空');
  else if (!args.every(isAbsolutePathValue)) push(`args 里有非绝对路径：${JSON.stringify(args)}`);
  if (config.cwd !== undefined && !isAbsolutePathValue(config.cwd)) push(`cwd 不是绝对路径（读到 ${JSON.stringify(config.cwd)}）`);
  if (!Number.isFinite(config.toolCallTimeoutMs)) push('toolCallTimeoutMs 不是数字');
  if (config.env !== undefined) {
    for (const [key, value] of Object.entries(config.env)) {
      if (key === 'GODOT_MCP_GODOT' && !isAbsolutePathValue(value)) push(`env.GODOT_MCP_GODOT 不是绝对路径（读到 ${JSON.stringify(value)}）`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 没有 YAML 解析器时的兜底读取：按缩进取本条目里我们关心的那些标量与列表项。
 * 比真正的解析器弱，但足以让自检在「全新 profile 还没有 node_modules」时也能跑完。
 *
 * 标量统一交给 {@link decodeYamlScalar}：本仓库写出去的永远是双引号风格，
 * 因此兜底解析结果必须与真实 YAML 解析器**逐字符一致**（旧实现只剥首尾引号，
 * `C:\DSH #1\…` 在真解析器里是 `C:\DSH`，在兜底解析器里却还是完整字符串，
 * 于是自检说「没问题」而 DSH 实际加载到的是错的）。
 *
 * 返回值既保留扁平字段（旧调用方），也提供 `config` 子对象。
 *
 * @param {string} text
 * @returns {{id: string, name?: string, serverName?: string, transport?: string, command?: string, args: string[], cwd?: string, toolCallTimeoutMs?: number, env?: Record<string,string>, config?: object}|undefined}
 */
export function parseEntryLoose(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex(line => new RegExp(`^ {4}- id: ${ENTRY_ID}\\s*$`).test(line));
  if (start < 0) return undefined;

  // 条目范围：到下一个 4 格缩进的兄弟条目为止
  let end = start + 1;
  while (end < lines.length && !/^ {4}- /.test(lines[end])) end += 1;

  const entry = { id: ENTRY_ID, args: [] };
  const config = { args: [] };
  let section = '';
  for (const raw of lines.slice(start + 1, end)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 8 && body === 'env:') {
      section = 'env';
      entry.env = {};
      config.env = {};
      continue;
    }
    if (indent === 8 && body === 'args:') {
      section = 'args';
      continue;
    }
    if (indent === 10 && section === 'args' && body.startsWith('- ')) {
      const value = decodeYamlScalar(body.slice(2));
      entry.args.push(value);
      config.args.push(value);
      continue;
    }
    if (indent === 10 && section === 'env' && body.includes(':')) {
      const colon = body.indexOf(':');
      const key = body.slice(0, colon).trim();
      const value = decodeYamlScalar(body.slice(colon + 1));
      entry.env[key] = value;
      config.env[key] = value;
      continue;
    }
    if (indent === 6 || indent === 8) section = '';
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(body);
    if (!match) continue;
    const [, key, rest] = match;
    if (indent === 6 && key === 'name') entry.name = decodeYamlScalar(rest);
    if (indent === 6 && key === 'config') continue;
    if (indent === 8) {
      const value = decodeYamlScalar(rest);
      if (key === 'serverName') { entry.serverName = value; config.serverName = value; }
      if (key === 'transport') { entry.transport = value; config.transport = value; }
      if (key === 'command') { entry.command = value; config.command = value; }
      if (key === 'cwd') { entry.cwd = value; config.cwd = value; }
      if (key === 'toolCallTimeoutMs') {
        const number = Number(value);
        entry.toolCallTimeoutMs = number;
        config.toolCallTimeoutMs = number;
      }
    }
  }
  entry.config = config;
  return entry;
}
