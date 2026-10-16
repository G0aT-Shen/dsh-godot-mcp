// 按 DSH 的 mcp-client 起 server 的方式做一次真实探针：
// 干净环境（scrubbed env）+ 绝对路径命令 → initialize → tools/list。
//
// 为什么必须真起一次：配错 node 路径、配错 server 路径这类问题，光看 YAML 看不出来；
// 而 mcp-client 用 scrubbedParentEnv() 起子进程，`PATH` 里的 node 并不可依赖。
//
// 探针环境怎么才算「像 DSH」：
//   旧实现把环境固定成 `{HOME, PATH:'/usr/bin:/bin', LANG}` —— 这在 Windows 上缺
//   SystemRoot/ComSpec/TEMP，Node 根本起不来；在 POSIX 上又把父进程真实 PATH 覆盖掉，
//   于是「探针通过」既不能代表 Windows，也不能代表本机真实启动行为。
//   现在的语义是：**从父环境出发**，删掉凭据类（KEY/PASSWORD/SECRET/TOKEN）与 DSH_*，
//   再叠加 profile 里钉的 env。这才是 mcp-client 实际做的事（洗掉敏感/陈旧变量，
//   保留系统变量与代理）。

import { spawn } from 'node:child_process';
import os from 'node:os';

/** 会被洗掉的变量名模式：凭据类 + DSH 自己注入的状态。 */
export const SECRET_NAME_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
export const DSH_NAME_PATTERN = /^DSH_/i;

/**
 * Windows 环境变量名**大小写不敏感**：真实父环境里常见的写法是 `Path`，而 Node 在
 * Windows 上也允许同时看到 `Path` 与 `PATH`。只判断 `env.PATH` 会导致：
 *   · 误以为没有 PATH，于是塞一个 `C:\Windows\System32;C:\Windows` 兜底进去，
 *     真实搜索路径被顶掉；
 *   · 或者按对象键顺序只留一个变体，把真实路径丢了。
 * 所以这里统一按「大小写不敏感的同义 key」处理。
 */
export function envKeyOf(env, name, platform = process.platform) {
  if (Object.hasOwn(env, name)) return name;
  if (platform !== 'win32') return undefined;
  const wanted = name.toLowerCase();
  return Object.keys(env).find(key => key.toLowerCase() === wanted);
}

export function envValueOf(env, name, platform = process.platform) {
  const key = envKeyOf(env, name, platform);
  return key === undefined ? undefined : env[key];
}

/**
 * 构造探针环境。返回 {env, removed, kept}。
 * @param {{platform?: NodeJS.Platform, base?: Record<string,string|undefined>, extra?: Record<string,string>,
 *          home?: string, tmpdir?: string}} [options]
 */
export function buildProbeEnv(options = {}) {
  const {
    platform = process.platform,
    base = process.env,
    extra,
    home = os.homedir(),
    tmpdir = os.tmpdir(),
  } = options;
  const env = {};
  const removed = [];
  const caseInsensitive = platform === 'win32';
  const seen = new Map(); // 规范化 key -> env 里实际使用的 key
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (DSH_NAME_PATTERN.test(key) || SECRET_NAME_PATTERN.test(key)) {
      removed.push(key);
      continue;
    }
    const canonical = caseInsensitive ? key.toLowerCase() : key;
    const existing = seen.get(canonical);
    if (existing !== undefined) {
      // 同义键重复（Windows 上 Path/PATH 并存）：保留**非空**的那个值，不新增键
      if (!env[existing] && value) env[existing] = value;
      continue;
    }
    seen.set(canonical, key);
    env[key] = value;
  }

  const has = name => (caseInsensitive ? envKeyOf(env, name, platform) !== undefined : Object.hasOwn(env, name));
  const read = name => (caseInsensitive ? envValueOf(env, name, platform) : env[name]);

  if (platform === 'win32') {
    // Windows 上这几个是「能起进程」的硬前提，缺了 Node 会在加载阶段就失败。
    // 注意：这里只在**确实没有**（含大小写变体）时才兜底，绝不用假 PATH 顶掉真实 PATH。
    if (!has('SystemRoot')) env.SystemRoot = read('windir') ?? 'C:\\Windows';
    if (!has('windir')) env.windir = read('SystemRoot');
    if (!has('PATH')) env.PATH = `${read('SystemRoot')}\\System32;${read('SystemRoot')}`;
    if (!has('TEMP')) env.TEMP = read('TMP') ?? tmpdir;
    if (!has('TMP')) env.TMP = read('TEMP');
    if (!has('HOME')) env.HOME = read('USERPROFILE') ?? home;
    if (!has('USERPROFILE')) env.USERPROFILE = read('HOME');
  } else {
    // POSIX：保留父进程真实 PATH（覆盖成 /usr/bin:/bin 会让「本机 node 在哪」这件事失真）。
    if (!env.HOME) env.HOME = home;
    if (!env.PATH) env.PATH = '/usr/bin:/bin';
    if (!env.TMPDIR) env.TMPDIR = tmpdir;
  }

  // profile 里钉的 env 必须最后叠加：它是我们**有意**要传下去的东西。
  // Windows 上若已有同义键（例如 base 里是 `Path`、extra 里是 `PATH`），先删掉旧键，
  // 保证「extra 覆盖」而不是留下两个键、让 Node 自己挑。
  const extras = extra ?? {};
  for (const [key, value] of Object.entries(extras)) {
    if (caseInsensitive) {
      const existing = envKeyOf(env, key, platform);
      if (existing !== undefined && existing !== key) {
        delete env[existing];
        seen.delete(existing.toLowerCase());
      }
    }
    env[key] = value;
  }

  return { env, removed, kept: Object.keys(env).sort() };
}

/**
 * 探针用的环境（向后兼容的简单形态）。
 * @returns {Record<string,string>}
 */
export function probeEnv(options = {}) {
  return buildProbeEnv(options).env;
}

/** 探针环境诊断（写进 setup 输出，便于排查平台差异）。 */
export function probeEnvReport(options = {}) {
  const platform = options.platform ?? process.platform;
  const { env, removed, kept } = buildProbeEnv(options);
  return {
    platform,
    keys: kept,
    removed,
    count: kept.length,
    // 出错时最该看的就是这几个：node 路径、PATH、平台根目录
    critical: {
      PATH: env.PATH,
      ...(platform === 'win32' ? { SystemRoot: env.SystemRoot, TEMP: env.TEMP, PATHEXT: env.PATHEXT } : { HOME: env.HOME, TMPDIR: env.TMPDIR }),
    },
    note:
      platform === 'win32'
        ? 'Windows：从父环境出发，保留 SystemRoot/ComSpec/PATHEXT/TEMP/PATH 与代理，洗掉 *KEY|PASSWORD|SECRET|TOKEN* 与 DSH_*'
        : 'POSIX：从父环境出发，保留真实 PATH/HOME/TMPDIR 与代理，洗掉 *KEY|PASSWORD|SECRET|TOKEN* 与 DSH_*',
  };
}

/**
 * @param {{command: string, args?: string[], cwd?: string, env?: Record<string,string>, timeoutMs?: number,
 *          platform?: NodeJS.Platform, baseEnv?: Record<string,string|undefined>}} options
 * @returns {Promise<{ok: boolean, tools?: string[], serverInfo?: object, protocolVersion?: string, error?: string,
 *          stderr?: string, command?: string, args?: string[], env?: Record<string,string>}>}
 */
export function probeMcpServer({ command, args = [], cwd, env, timeoutMs = 90_000, platform = process.platform, baseEnv = process.env }) {
  const { env: probeEnvironment } = buildProbeEnv({ platform, base: baseEnv, extra: env });
  const context = { command, args, env: probeEnvironment };
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: probeEnvironment,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // 起不来时把「用什么命令、什么环境」一起回给调用方：只回一句 ENOENT 没法排查。
      resolve({ ok: false, error: `启动 ${command} 失败：${String(error?.message ?? error)}`, ...context });
      return;
    }
    let buffer = '';
    let stderr = '';
    let settled = false;
    let initResult;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      resolve({ ...value, ...context });
    };
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      settled = true;
      resolve({
        ok: false,
        error: `探针超时（${timeoutMs}ms）：${command} ${args.join(' ')} 没有回 initialize/tools/list`,
        stderr,
        ...context,
      });
    }, timeoutMs);

    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          if (initResult === undefined) initResult = message.result;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          if (message.error) {
            finish({ ok: false, error: `tools/list 失败：${JSON.stringify(message.error)}`, stderr });
            continue;
          }
          finish({
            ok: true,
            tools: (message.result?.tools ?? []).map(tool => tool.name),
            serverInfo: initResult?.serverInfo,
            protocolVersion: initResult?.protocolVersion,
            stderr,
          });
        }
      }
    });
    child.on('error', error => {
      finish({ ok: false, error: `启动 ${command} 失败：${String(error.message)}`, stderr });
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe-mcp', version: '1' } },
    });
  });
}
