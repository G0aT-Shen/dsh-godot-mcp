// L2/L3 桥客户端：与编辑器插件（WebSocket 9089）和运行中游戏（TCP 9091）通信。
//
// 协议（DESIGN.md §2.2 / §2.3）：行分隔 JSON，一问一答
//   → {"id":"...","op":"editor.info","params":{...}}
//   ← {"id":"...","ok":true,"data":{...}}
//
// 关键设计：每次调用建一条新连接，用完即关。
// 原因：Godot 侧 WebSocketPeer/TCPServer 通常是单客户端模型，长连接会让
// 「编辑器重启」和「游戏重开」后的连接变成僵尸；短连接 + 明确超时能自然恢复。

import net from 'node:net';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DEFAULT_EDITOR_PORT, DEFAULT_RUNTIME_PORT } from './godot.mjs';

/** 可取消的 sleep：abort 时立刻以 ABORTED 结束，而不是睡满整个间隔。 */
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function aborted() {
  const error = new Error('桥调用已取消（已关闭连接；Godot 内已开始的操作不会回滚）');
  error.code = 'ABORTED';
  return error;
}

function cancelSocket(socket, signal, reject) {
  const onAbort = () => { socket.destroy(); reject(aborted()); };
  signal?.addEventListener('abort', onAbort, { once: true });
  socket.once('close', () => signal?.removeEventListener('abort', onAbort));
  if (signal?.aborted) onAbort();
}

/** 极简 WebSocket 客户端（只支持我们需要的：客户端发文本帧、服务端回文本帧）。 */
class MiniWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.closed = false;
    this.closeError = undefined;
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    });
    socket.on('close', () => this.#onClose());
    socket.on('error', error => {
      this.closeError = error;
      this.#onClose();
    });
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.closeError ?? new Error('连接已关闭'));
  }

  #drain() {
    for (;;) {
      const frame = this.#readFrame();
      if (!frame) return;
      if (frame.opcode === 0x1) {
        const text = frame.payload.toString('utf8');
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(text);
        else this.frames.push(text);
      } else if (frame.opcode === 0x8) {
        this.#onClose();
        return;
      } else if (frame.opcode === 0x9) {
        this.#sendFrame(0xa, frame.payload); // pong
      }
      // 0x0/0x2 等忽略：本协议只用文本帧
    }
  }

  #readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return undefined;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < offset + 2) return undefined;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return undefined;
      const big = buf.readBigUInt64BE(offset);
      if (big > 64n * 1024n * 1024n) throw new Error('WebSocket 帧过大');
      length = Number(big);
      offset += 8;
    }
    let mask;
    if (masked) {
      if (buf.length < offset + 4) return undefined;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + length) return undefined;
    const payload = Buffer.from(buf.subarray(offset, offset + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = buf.subarray(offset + length);
    if (!fin) return undefined; // 本协议消息都很小，不分片
    return { opcode, payload };
  }

  #sendFrame(opcode, payload) {
    if (this.closed) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]); // 客户端必须掩码；用固定值即可（非加密用途）
    const length = data.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    try {
      this.socket.write(Buffer.concat([header, mask, masked]));
    } catch {
      /* 写失败由 close 事件处理 */
    }
  }

  send(text) {
    this.#sendFrame(0x1, text);
  }

  receive(timeoutMs) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    if (this.closed) return Promise.reject(this.closeError ?? new Error('连接已关闭'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error(`等待响应超时（${timeoutMs}ms）`));
      }, timeoutMs);
      waiter.resolve = value => {
        clearTimeout(timer);
        resolve(value);
      };
      waiter.reject = error => {
        clearTimeout(timer);
        reject(error);
      };
      this.waiters.push(waiter);
    });
  }

  destroy() {
    try {
      this.#sendFrame(0x8, Buffer.alloc(0));
    } catch {
      /* ignore */
    }
    this.socket.destroy();
  }
}

/**
 * 连到编辑器 WebSocket 桥。
 * @param {{host?: string, port?: number, timeoutMs?: number}} [options]
 * @returns {Promise<MiniWebSocket>}
 */
function connectWebSocket({ host = '127.0.0.1', port = DEFAULT_EDITOR_PORT, timeoutMs = 5000, signal } = {}) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const key = Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64');
    const socket = net.connect({ host, port });
    let handshake = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接编辑器桥 ${host}:${port} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    cancelSocket(socket, signal, reject);
    socket.once('close', () => {
      clearTimeout(timer);
      reject(signal?.aborted ? aborted() : new Error('编辑器桥连接已关闭'));
    });

    const onData = chunk => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = handshake.subarray(0, end).toString('latin1');
      if (!/^HTTP\/1\.[01] 101/.test(head)) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`WebSocket 握手失败：${head.split('\r\n')[0]}`));
        return;
      }
      socket.removeListener('data', onData);
      clearTimeout(timer);
      const rest = handshake.subarray(end + 4);
      const ws = new MiniWebSocket(socket);
      if (rest.length) {
        socket.emit('data', rest);
      }
      resolve(ws);
    };

    socket.on('data', onData);
    socket.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`连接编辑器桥 ${host}:${port} 失败：${error.message}`));
    });
    socket.on('connect', () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
  });
}

/**
 * 调用编辑器桥（L2）。
 * @param {string} op
 * @param {object} [params]
 * @param {{host?: string, port?: number, timeoutMs?: number}} [options]
 */
export async function callEditor(op, params = {}, options = {}) {
  const timeoutMs = bridgeTimeoutFor(op, options.timeoutMs);
  const ws = await connectWebSocket(options);
  try {
    const id = randomUUID();
    ws.send(`${JSON.stringify({ id, op, params })}\n`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = Math.max(500, deadline - Date.now());
      let raw;
      try {
        raw = await ws.receive(remaining);
      } catch (error) {
        if (/超时/.test(String(error?.message ?? ''))) {
          const hint = new Error(timeoutHint(op, timeoutMs, params));
          hint.code = 'BRIDGE_TIMEOUT';
          throw hint;
        }
        throw error;
      }
      let message;
      try {
        message = JSON.parse(raw.trim());
      } catch {
        continue; // 忽略非 JSON 噪音（Godot 可能先推日志）
      }
      if (message.id !== id) continue;
      if (message.ok !== true) {
        const error = new Error(String(message.error ?? `编辑器桥 op ${op} 失败`));
        error.code = String(message.code ?? 'BRIDGE_ERROR');
        throw error;
      }
      return message.data ?? null;
    }
  } catch (error) {
    if (options.signal?.aborted) throw aborted();
    throw error;
  } finally {
    ws.destroy();
  }
}

/** 极简 TCP 行分隔 JSON 客户端。 */
function connectTcp({ host = '127.0.0.1', port = DEFAULT_RUNTIME_PORT, timeoutMs = 5000, signal } = {}) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接运行时桥 ${host}:${port} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    cancelSocket(socket, signal, reject);
    socket.once('close', () => {
      clearTimeout(timer);
      reject(signal?.aborted ? aborted() : new Error('运行时桥连接已关闭'));
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(new Error(`连接运行时桥 ${host}:${port} 失败：${error.message}`));
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      let buffer = '';
      const queue = [];
      const waiters = [];
      let closedError;
      socket.once('close', () => {
        closedError = signal?.aborted ? aborted() : new Error('运行时桥连接已关闭');
        for (const waiter of waiters.splice(0)) waiter.reject(closedError);
      });
      socket.on('data', chunk => {
        buffer += String(chunk);
        for (;;) {
          const index = buffer.indexOf('\n');
          if (index === -1) break;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          const waiter = waiters.shift();
          if (waiter) waiter.resolve(message);
          else queue.push(message);
        }
      });
      resolve({
        socket,
        async request(payload, perCallTimeout) {
          if (signal?.aborted) throw aborted();
          if (closedError) throw closedError;
          socket.write(`${JSON.stringify(payload)}\n`);
          const deadline = Date.now() + perCallTimeout;
          for (;;) {
            if (closedError) throw closedError;
            let message;
            if (queue.length) {
              message = queue.shift();
            } else {
              const remaining = deadline - Date.now();
              if (remaining <= 0) throw new Error(`等待运行时响应超时（${perCallTimeout}ms）`);
              message = await new Promise((res, rej) => {
                const entry = {
                  resolve: value => { clearTimeout(t); res(value); },
                  reject: error => { clearTimeout(t); rej(error); },
                };
                const t = setTimeout(() => {
                  const index = waiters.indexOf(entry);
                  if (index !== -1) waiters.splice(index, 1);
                  rej(new Error(`等待运行时响应超时（${perCallTimeout}ms）`));
                }, remaining);
                waiters.push(entry);
              });
            }
            if (message.id === payload.id) return message;
          }
        },
        destroy() {
          socket.destroy();
        },
      });
    });
  });
}

/**
 * 桥的默认超时。有的 op 天生就该给更宽的预算，否则调用方会看到「等待响应超时」
 * 这种毫无指向性的错误 —— 而真正的原因是「这个 op 本来就慢」。
 * 实测：一个 await 两次定时器的 rt.eval 就会顶穿 15s，报出来的错完全不提补救办法。
 */
const BRIDGE_TIMEOUT_MS = 15_000;
const BRIDGE_TIMEOUT_BY_OP = {
  'rt.eval': 30_000,
  // rt.step 按帧推进，本身就可能跑满 30s（服务端上限），客户端必须更宽
  'rt.step': 45_000,
  'rt.screenshot': 20_000,
  'editor.execute': 30_000,
  'editor.run': 30_000,
};

export function bridgeTimeoutFor(op, explicit) {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  return BRIDGE_TIMEOUT_BY_OP[op] ?? BRIDGE_TIMEOUT_MS;
}

/**
 * 把「等待响应超时」这种无指向性的错误改写成可执行的补救说明。
 * 超时是这套工具里最难自查的失败：调用方看到的只是「没响应」，
 * 既可能是 op 真的慢，也可能是它内部还 await 了别的东西。
 */
function timeoutHint(op, timeoutMs, params) {
  const parts = [
    `${op} 在 ${timeoutMs}ms 内没有响应（桥仍然连着，是这一条请求没回来）。`,
    `加大超时：godot_connect 传 timeoutMs`,
    `（例如 ${Math.max(timeoutMs * 3, 60_000)}）`,
  ];
  if (op === 'rt.eval' || op === 'editor.execute') {
    if (params?.timeout_ms === undefined) {
      parts.push('；脚本内部还有自己的预算，可同时传 params.timeout_ms');
    }
    parts.push('。注意 await 渲染信号（RenderingServer.frame_post_draw）在 headless 下永不触发，会一直挂到超时');
  } else if (op === 'rt.screenshot') {
    parts.push('；rt.screenshot 需要真实显示驱动，headless 运行没有帧缓冲');
  } else {
    parts.push('');
  }
  return parts.join('');
}

/**
 * 调用运行中游戏桥（L3）。
 * @param {string} op
 * @param {object} [params]
 * @param {{host?: string, port?: number, timeoutMs?: number}} [options]
 */
export async function callRuntime(op, params = {}, options = {}) {
  const timeoutMs = bridgeTimeoutFor(op, options.timeoutMs);
  const client = await connectTcp(options);
  try {
    const id = randomUUID();
    let message;
    try {
      message = await client.request({ id, op, params }, timeoutMs);
    } catch (error) {
      if (error?.code === 'TIMEOUT' || /超时/.test(String(error?.message ?? ''))) {
        const hint = new Error(timeoutHint(op, timeoutMs, params));
        hint.code = 'BRIDGE_TIMEOUT';
        throw hint;
      }
      throw error;
    }
    if (message.ok !== true) {
      const error = new Error(String(message.error ?? `运行时桥 op ${op} 失败`));
      error.code = String(message.code ?? 'BRIDGE_ERROR');
      throw error;
    }
    return message.data ?? null;
  } finally {
    client.destroy();
  }
}

/** 探测端口是否可连（用于「编辑器/游戏是否已启动」判断）。 */
export function probePort({ host = '127.0.0.1', port, timeoutMs = 1500 } = {}) {  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = value => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/**
 * 严格校验运行时桥的身份回执。
 *
 * 缺字段、类型不对、协议不对、nonce 不匹配、项目不匹配、pid 不是当前目标 —— 全部拒绝。
 * 「对面没报身份」不能当成通过：那正是老版本桥或外来服务占端口的典型样子。
 *
 * @param {object} info rt.ping 的 data
 * @param {{nonce?: string, expectedProject?: string, expectedPid?: number,
 *          platform?: NodeJS.Platform, realpath?: (target: string) => string}} expectations
 * @returns {{ok: true, ownership: object} | {ok: false, code: string, error: string}}
 */
export function validateRuntimeIdentity(info, expectations = {}) {
  const { nonce, expectedProject, expectedPid, platform = process.platform, realpath } = expectations;
  if (!info || typeof info !== 'object') {
    return { ok: false, code: 'IDENTITY_MISSING', error: '运行时桥没有返回身份信息' };
  }
  if (info.protocol !== 'godot-mcp-runtime/1') {
    return { ok: false, code: 'NOT_RUNTIME_BRIDGE', error: `端口上回的不是 Godot MCP 运行时协议（protocol=${JSON.stringify(info.protocol)}）` };
  }
  if (info.pong !== true) {
    return { ok: false, code: 'NOT_RUNTIME_BRIDGE', error: 'rt.ping 没有返回 pong=true' };
  }
  if (nonce !== undefined && info.nonce !== nonce) {
    return { ok: false, code: 'STALE_NONCE', error: '收到的 nonce 与本次请求不一致（可能是迟到的旧回包）' };
  }
  if (!Number.isInteger(info.pid) || info.pid <= 0) {
    return { ok: false, code: 'IDENTITY_INCOMPLETE', error: `运行时桥没有上报有效的 pid（收到 ${JSON.stringify(info.pid)}）` };
  }
  if (expectedPid !== undefined && info.pid !== expectedPid) {
    return {
      ok: false,
      code: 'PID_MISMATCH',
      remotePid: info.pid,
      remoteProject: typeof info.project === 'string' ? info.project : undefined,
      expectedPid,
      error: `端口后面的进程 pid=${info.pid}，而当前目标是 pid=${expectedPid}：可能连到了别的游戏实例（或旧实例还没退出）。`,
    };
  }
  const remoteRaw = typeof info.project === 'string' ? info.project : '';
  let remote;
  if (expectedProject) {
    if (!remoteRaw) {
      return {
        ok: false,
        code: 'PROJECT_UNVERIFIED',
        remotePid: info.pid,
        error: `运行时桥没有上报项目路径（pid=${info.pid}），无法确认它属于 ${expectedProject}；拒绝在未校验的连接上执行操作。`,
      };
    }
    const identity = projectIdentity(expectedProject, { platform, ...(realpath ? { realpath } : {}) });
    if (!identity.ok) return { ok: false, code: identity.code, error: identity.error };
    remote = projectIdentity(remoteRaw, { platform, ...(realpath ? { realpath } : {}) });
    if (!remote.ok) return { ok: false, code: remote.code, error: remote.error };
    if (remote.comparison !== identity.comparison) {
      return {
        ok: false,
        code: 'PROJECT_MISMATCH',
        remotePid: info.pid,
        remoteProject: remote.path,
        error: `端口上跑的是另一个项目：${remote.path}（期望 ${identity.path}）。同一端口只能被一个游戏的运行时桥占用；请给会话指定不同的 runtimePort，或先停掉另一个游戏。`,
      };
    }
    return { ok: true, ownership: { verified: true, expectedProject: identity.path, remoteProject: remote.path, pid: info.pid, port: info.port, viaRealPath: remote.viaRealPath || identity.viaRealPath } };
  }
  remote = remoteRaw ? projectIdentity(remoteRaw, { platform, ...(realpath ? { realpath } : {}) }) : undefined;
  return { ok: true, ownership: { verified: false, reason: 'no-expected-target', remoteProject: remote?.ok ? remote.path : undefined, pid: info.pid, port: info.port } };
}

/**
 * 在**同一条连接**上先做身份校验（rt.ping + nonce + 项目 + pid），再执行真正的 op。
 *
 * 为什么要同连接：先连一次校验、再连一次执行的话，两次之间端口可能被另一个游戏接管
 * （TOCTOU）—— 校验过的是 A，命令发给了 B。写操作发错进程比连不上危险得多。
 *
 * @returns {Promise<{data: unknown, ownership: object}>}
 */
export async function callRuntimeVerified(op, params = {}, options = {}) {
  const { expectedProject, expectedPid } = options;
  const client = await connectTcp(options);
  try {
    const nonce = randomUUID();
    let pingMessage;
    try {
      // 注意：client.request 解析的是**整条消息**（{id, ok, data}），身份字段在 data 里。
      pingMessage = await client.request({ id: randomUUID(), op: 'rt.ping', params: { nonce } }, Math.min(options.pingTimeoutMs ?? 5000, options.timeoutMs ?? 5000));
    } catch (error) {
      if (error?.code === 'ABORTED' || options.signal?.aborted) throw aborted();
      const wrapped = new Error(`身份校验（rt.ping）失败：${String(error?.message ?? error)}`);
      wrapped.code = 'IDENTITY_PING_FAILED';
      throw wrapped;
    }
    if (pingMessage?.ok !== true) {
      const error = new Error(`身份校验（rt.ping）失败：${String(pingMessage?.error ?? '未返回 ok')}`);
      error.code = 'IDENTITY_PING_FAILED';
      throw error;
    }
    const verdict = validateRuntimeIdentity(pingMessage.data, {
      nonce,
      expectedProject,
      expectedPid,
      platform: options.platform,
      realpath: options.realpath,
    });
    if (!verdict.ok) {
      const error = new Error(verdict.error);
      error.code = verdict.code;
      error.ownership = verdict;
      throw error;
    }
    // op 本身就是 rt.ping 时，校验用的那一次往返就是结果 —— 不再多发一条。
    const message = op === 'rt.ping'
      ? pingMessage
      : await client.request({ id: randomUUID(), op, params }, options.timeoutMs ?? 15_000);
    if (message.ok !== true) {
      const error = new Error(String(message.error ?? `运行时桥 op ${op} 失败`));
      error.code = String(message.code ?? 'BRIDGE_ERROR');
      throw error;
    }
    return { data: message.data ?? null, ownership: verdict.ownership };
  } finally {
    client.destroy();
  }
}

/** 统一入口：target=editor 走 WebSocket，target=runtime 走 TCP。 */
export async function callBridge(target, op, params = {}, options = {}) {
  if (target === 'editor') return callEditor(op, params, options);
  if (target === 'runtime') return callRuntime(op, params, options);
  throw new Error(`未知的桥目标：${target}（应为 editor 或 runtime）`);
}

/**
 * 归一化项目路径，用于「这个端口后面的游戏是不是我要的项目」的比较。
 * Windows 路径大小写不敏感、两种分隔符都可能出现，末尾分隔符没有意义。
 *
 * 注意：这个函数**只用于比较**，不用于回传或写盘 —— 把真实路径小写化再拿去写文件，
 * 在大小写敏感的文件系统上会指向错误的目录。
 * @param {string} value
 * @param {NodeJS.Platform} [platform]
 */
export function normalizeProjectPath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const text = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? text.toLowerCase() : text;
}

/** 判断 UNC 路径（`\\server\share` 或 `//server/share`）。 */
export function isUncPath(value) {
  return /^\\\\[^\\/]/.test(String(value ?? '')) || /^\/\/[^\/]/.test(String(value ?? ''));
}

/**
 * 项目身份解析：把路径变成「可以安全比较、且用于操作时不会走错目录」的形式。
 *
 * 三个真实坑：
 *   1. macOS 上 `/var/...` 与 `/private/var/...` 是同一目录（临时目录都在 /var 下），
 *      字符串比较会把同一个项目判成不同项目；
 *   2. Windows 上 junction / 盘符大小写 / `\\?\` 前缀都会让比较失败；
 *   3. UNC 路径（`\\server\share`）在本版本**不支持**：写文件、加 autoload 都要经过
 *      它，一旦判断错误就可能写到别人的共享目录里 —— 宁可直接拒绝，也不冒误写的风险。
 *
 * @param {string} value
 * @param {{platform?: NodeJS.Platform, realpath?: (target: string) => string}} [options]
 * @returns {{ok: true, path: string, comparison: string, viaRealPath: boolean, raw: string}
 *          | {ok: false, code: string, error: string, raw: string}}
 */
export function projectIdentity(value, options = {}) {
  const { platform = process.platform, realpath = fs.realpathSync.native } = options;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return { ok: false, code: 'EMPTY_PROJECT', error: '项目路径为空，无法确认端口归属', raw };
  }
  if (isUncPath(raw)) {
    return {
      ok: false,
      code: 'UNC_UNSUPPORTED',
      error: `不支持 UNC 路径（${raw}）：无法可靠判断项目归属，写配置还可能落到共享目录里的其他副本上。请改用本机绝对路径。`,
      raw,
    };
  }
  let resolved = raw;
  let viaRealPath = false;
  try {
    const real = realpath(raw);
    if (real) {
      resolved = real;
      viaRealPath = normalizeProjectPath(real, platform) !== normalizeProjectPath(raw, platform);
    }
  } catch { /* 目录还不存在（例如 create_project 之前）：退化为字符串比较 */ }
  return { ok: true, path: resolved, comparison: normalizeProjectPath(resolved, platform), viaRealPath, raw };
}

/**
 * 判断两个项目路径是不是**同一个项目**（用于选中 managed 会话拿 knownPID）。
 *
 * 不能直接字符串比较：
 *   · Windows 上 `C:/Games` 与 `C:\Games`、`c:\games` 与 `C:\Games` 是同一目录；
 *   · junction / symlink 的别名与真实路径指向同一目录（realpath 归一）；
 *   · 末尾分隔符、`\\?\` 前缀之类也不该导致「找不到同一个项目」。
 * 判断不成立（空值、UNC 等无法规范化）时返回 false —— 宁可不匹配，也不把别的项目当目标。
 *
 * @param {string} a
 * @param {string} b
 * @param {{platform?: NodeJS.Platform, realpath?: (target: string) => string}} [options]
 */
export function sameProjectPath(a, b, options = {}) {
  const left = projectIdentity(a, options);
  const right = projectIdentity(b, options);
  if (!left.ok || !right.ok) return false;
  return left.comparison === right.comparison;
}

/** 项目路径的「比较键」（无法规范化时返回 undefined）。 */
export function projectComparisonKey(value, options = {}) {
  const identity = projectIdentity(value, options);
  return identity.ok ? identity.comparison : undefined;
}

/**
 * 有期限的运行时就绪探测 + **项目归属校验**。
 *
 * 为什么需要它：
 *   * 游戏启动到监听端口之间有时间差，第一次 connection refused 不能当成「不兼容」；
 *   * 端口可能被**别的进程**占用（占用者根本不说我们的协议）；
 *   * 同机多项目时端口可能属于**另一个项目**的游戏 —— 直接连上去会把命令发进错的进程，
 *     这比连不上危险得多。
 *
 * 判定顺序：连得上 → 回的是不是本协议 → `rt.ping` 的 nonce 是否一致 → 项目是否匹配。
 * 任何一步不成立都返回结构化错误码，调用方据此给出可诊断的失败，而不是假装成功。
 *
 * 取消语义：signal 一 abort 就**立刻**抛出 ABORTED（不吞掉、不当成「还没就绪」继续重试）。
 *
 * @param {{host?: string, port: number, project?: string, timeoutMs?: number, pollMs?: number,
 *          signal?: AbortSignal, platform?: NodeJS.Platform,
 *          realpath?: (target: string) => string}} options
 * @returns {Promise<{ok: boolean, port: number, code?: string, error?: string, project?: string,
 *          pid?: number, expectedProject?: string, lastError?: string, info?: object}>}
 */
export async function waitForRuntime(options = {}) {
  const {
    host = '127.0.0.1',
    port,
    project,
    pid,
    timeoutMs = 15_000,
    pollMs = 250,
    signal,
    platform = process.platform,
    realpath,
  } = options;

  if (signal?.aborted) {
    const error = aborted();
    error.port = port;
    throw error;
  }

  // 期望项目先做身份解析：UNC 之类不支持的形态必须在连接之前就拒绝。
  let expected;
  if (project) {
    const identity = projectIdentity(project, { platform, ...(realpath ? { realpath } : {}) });
    if (!identity.ok) {
      return { ok: false, port, code: identity.code, error: identity.error, expectedProject: project };
    }
    expected = identity;
  }
  if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) {
    return { ok: false, port, code: 'BAD_EXPECTED_PID', error: `期望的 pid 非法：${JSON.stringify(pid)}` };
  }

  const deadline = Date.now() + timeoutMs;
  let lastError;
  let lastCode;
  let sawForeignService = false;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      // 同一条连接上完成「rt.ping 身份校验」——校验逻辑与真正执行 op 时完全一致。
      // 每次尝试最多吃掉剩余预算的一半（上限 2.5s）：既不给剩余时间设 500ms 下限
      // （那会让快到期的一次尝试反过来超时），也不允许一次尝试吃光整个窗口 ——
      // 否则「连得上但一直不说话」的外来服务会被误判成「还没起来」。
      const attemptBudget = Math.max(1, Math.min(2500, Math.floor(remaining / 2)));
      const { ownership } = await callRuntimeVerified('rt.ping', { nonce: randomUUID() }, {
        host,
        port,
        timeoutMs: attemptBudget,
        pingTimeoutMs: attemptBudget,
        signal,
        expectedProject: expected?.path,
        expectedPid: pid,
        platform,
        realpath,
      });
      return {
        ok: true,
        port,
        // pid：远端上报的 pid（旧契约）；expectedPid：本次校验的目标 pid
        pid: ownership.pid,
        remotePid: ownership.pid,
        expectedPid: pid,
        project: ownership.remoteProject ?? expected?.path,
        expectedProject: expected?.path,
        verified: ownership.verified === true,
        ownership,
        info: ownership,
      };
    } catch (error) {
      if (error?.code === 'ABORTED' || error?.name === 'AbortError' || signal?.aborted) {
        const cancelled = aborted();
        cancelled.port = port;
        throw cancelled;
      }
      lastError = String(error?.message ?? error);
      lastCode = error?.code;
      // 「端口上有东西但不是我们的桥 / 身份不对」= 不是「还没起来」，直接判定
      if (['NOT_RUNTIME_BRIDGE', 'PID_MISMATCH', 'PROJECT_MISMATCH', 'PROJECT_UNVERIFIED', 'UNC_UNSUPPORTED', 'IDENTITY_INCOMPLETE'].includes(lastCode)) {
        const verdict = error?.ownership ?? {};
        return {
          ok: false,
          port,
          code: lastCode,
          error: lastError,
          expectedProject: expected?.path,
          expectedPid: pid,
          remotePid: verdict.remotePid,
          project: verdict.remoteProject,
        };
      }
      // 用「TCP 连得上吗」区分两种失败，而不是猜错误文案；探测同样受剩余时间约束且可取消。
      const probeBudget = Math.max(1, Math.min(500, deadline - Date.now()));
      if (probeBudget > 0 && await probePort({ host, port, timeoutMs: probeBudget, signal })) sawForeignService = true;
    }
    if (Date.now() >= deadline) break;
    // 可取消的等待：abort 时立刻结束，而不是睡满 pollMs 才反应过来。
    await sleep(Math.max(0, Math.min(pollMs, deadline - Date.now())), signal);
  }

  return {
    ok: false,
    port,
    code: sawForeignService ? 'PORT_OCCUPIED' : 'RUNTIME_NOT_READY',
    expectedProject: expected?.path,
    expectedPid: pid,
    lastError,
    error: sawForeignService
      ? `端口 ${port} 已被占用，但它不是 Godot MCP 运行时桥（${lastError}）。换一个端口或停掉占用者。`
      : `等待运行时桥就绪超时（${timeoutMs}ms，127.0.0.1:${port}）：${lastError ?? '端口没有响应'}。` +
        '游戏可能还没启动完、被安全门禁挡住（release 导出默认不监听），或端口配置不一致。',
  };
}

export { connectWebSocket, connectTcp };
