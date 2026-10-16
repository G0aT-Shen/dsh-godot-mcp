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
import { randomUUID } from 'node:crypto';
import { DEFAULT_EDITOR_PORT, DEFAULT_RUNTIME_PORT } from './godot.mjs';

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
export function probePort({ host = '127.0.0.1', port, timeoutMs = 1500 } = {}) {
  return new Promise(resolve => {
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

/** 统一入口：target=editor 走 WebSocket，target=runtime 走 TCP。 */
export async function callBridge(target, op, params = {}, options = {}) {
  if (target === 'editor') return callEditor(op, params, options);
  if (target === 'runtime') return callRuntime(op, params, options);
  throw new Error(`未知的桥目标：${target}（应为 editor 或 runtime）`);
}

export { connectWebSocket, connectTcp };
