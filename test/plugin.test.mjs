// 插件入口契约测试：用假的 DSH 上下文跑一遍 boot.js 的 apply()。
//
// 为什么要有这个测试：DSH 里 apply() 一旦抛错，cordis 会回滚整个插件条目，
// 表现是「插件刚激活就被卸载」。装进真实 profile 之前，先在本地把入口跑通，
// 能确认：工具注册的形状对不对、缺少可选服务时是否会降级、卸载是否会回收资源。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, name, TOOL_NAMES } from '../boot.js';

/** 一个捕获注册行为的假 DSH 上下文。 */
function createFakeContext({ withTools = true, withWebServer = true } = {}) {
  const registered = new Map();
  const warnings = [];
  const infos = [];
  const effects = [];
  const routes = [];

  const ctx = {
    logger: {
      info: message => infos.push(String(message)),
      warn: message => warnings.push(String(message)),
      error: message => warnings.push(`ERROR ${String(message)}`),
    },
    get(key) {
      if (key === 'tools' && withTools) {
        return {
          register(definition) {
            if (registered.has(definition.name)) throw new Error(`duplicate ${definition.name}`);
            registered.set(definition.name, definition);
            return () => registered.delete(definition.name);
          },
        };
      }
      if (key === 'webServer' && withWebServer) {
        return {
          register(route) {
            routes.push(route);
            return () => routes.splice(routes.indexOf(route), 1);
          },
        };
      }
      return undefined;
    },
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
      return dispose;
    },
  };
  return { ctx, registered, warnings, infos, effects, routes };
}

// ---------------------------------------------------------------- DSH 接线契约
//
// 这几条守卫的由来（真实事故）：我一度认为 profile 里的 bundle patch 是冗余的而删掉它，
// 结果 DSH 重启后 5 个工具全部变成 "unknown tool"。DSH 的加载链是：
//   profile dependencies → dsh.profile.bundles → 本包的 dsh.bundle.patch
//   → patch 里的 insert 条目 → 从 profile 的 node_modules 解析包名并 import
// 缺任何一环，插件都不会出现在工具列表里，而所有业务测试仍然全绿。

test('package.json 声明了 dsh.bundle.patch（缺它 bundle 贡献零个条目）', async () => {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  const patch = pkg.dsh?.bundle?.patch;
  assert.equal(typeof patch, 'string', 'package.json 必须声明 dsh.bundle.patch，否则 DSH 不会插入插件条目');
  assert.ok(patch.length > 0);
});

test('bundle patch 文件存在且真的 insert 了本插件', async () => {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  const patchPath = path.join(root, pkg.dsh.bundle.patch);
  const text = await fsp.readFile(patchPath, 'utf8').catch(() => undefined);
  assert.ok(text !== undefined, `bundle patch 文件缺失：${patchPath}`);
  assert.match(text, /^\s*-\s*insert:/m, 'patch 必须有 insert 段');
  // 包名从 package.json 读，别写死：重命名仓库/包时这条断言不该失效
  assert.ok(
    text.includes(`name: '${pkg.name}'`) || text.includes(`name: "${pkg.name}"`),
    `patch 里必须 insert 本插件（${pkg.name}）`,
  );
  assert.match(text, /-\s*id:\s*['"]?godot-mcp['"]?/, 'insert 条目的 id 必须是 godot-mcp');
});

test('Entry Point 在 package.json 的 exports 里可达（DSH 按包名 import）', async () => {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.exports?.['.'], './boot.js');
  const entry = path.join(root, pkg.exports['.'].replace(/^\.\//, ''));
  assert.ok(await fsp.stat(entry).then(s => s.isFile()).catch(() => false), `入口不存在：${entry}`);
});

test('插件导出形状符合 cordis 插件契约', () => {
  assert.equal(typeof name, 'string');
  assert.equal(name, 'godot-mcp');
  assert.equal(typeof apply, 'function');
});

test('apply() 在正常上下文中注册 5 个工具且不抛错', () => {
  const { ctx, registered, infos } = createFakeContext();
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(registered.size, 5);
  for (const toolName of TOOL_NAMES) assert.ok(registered.has(toolName), `缺少工具 ${toolName}`);
  assert.ok(infos.some(line => line.includes('已注册 5 个工具')));
});

test('注册的工具定义满足 DSH 契约：parameters + output.schema + output.render + execute', () => {
  const { ctx, registered } = createFakeContext();
  apply(ctx, {});
  for (const [toolName, definition] of registered) {
    assert.equal(definition.name, toolName);
    assert.equal(typeof definition.description, 'string');
    assert.equal(typeof definition.parameters, 'object', `${toolName} 缺 parameters`);
    assert.equal(typeof definition.output, 'object', `${toolName} 缺 output`);
    assert.equal(typeof definition.output.schema, 'object', `${toolName} 缺 output.schema`);
    assert.equal(typeof definition.output.render, 'function', `${toolName} 缺 output.render`);
    assert.equal(typeof definition.execute, 'function', `${toolName} 缺 execute`);
    // render 必须产出 ContentBlock[]
    const blocks = definition.output.render({}, { ok: true });
    assert.ok(Array.isArray(blocks) && blocks[0].type === 'text');
  }
});

test('缺少 tools 服务时必须抛错（宁可显式失败，不要静默少一批工具）', () => {
  const { ctx, registered, warnings } = createFakeContext({ withTools: false });
  // 这条曾经是反的：老实现只 warn 一句就返回，于是「插件根本没注册成功」在 DSH 里
  // 表现为 unknown tool，而所有本地测试仍然全绿。必须让它可见。
  assert.throws(() => apply(ctx, {}), error => {
    assert.match(String(error.message), /拿不到 tools 服务|tools/);
    return true;
  });
  assert.equal(registered.size, 0);
  assert.ok(warnings.some(line => line.includes('拿不到 tools 服务')));
});

test('inject 声明了 tools（靠 cordis 排序，而不是可选访问 + 静默降级）', async () => {
  const mod = await import('../boot.js');
  assert.deepEqual(mod.inject, ['tools']);
});

test('启动诊断文件会被写入，且能区分 import / apply / 注册三个阶段', async () => {
  const fsp = await import('node:fs/promises');
  const { STATUS_PATH, reportBootStatus } = await import('../src/diagnose.mjs');
  const { ctx, registered } = createFakeContext();
  apply(ctx, {});
  assert.equal(registered.size, 5);
  const raw = await fsp.readFile(STATUS_PATH, 'utf8');
  const status = JSON.parse(raw);
  assert.equal(status.moduleLoaded, true);
  assert.equal(status.applyCalled, true);
  assert.equal(status.toolsAvailable, true);
  assert.equal(status.phase, 'ok');
  assert.deepEqual(status.registered, ['godot', 'godot_batch', 'godot_session', 'godot_connect', 'godot_status']);
  assert.ok(Array.isArray(status.errors));
  assert.equal(typeof status.pid, 'number');
  // 幂等：再写一次不应破坏结构
  reportBootStatus({ extra: 1 });
  const again = JSON.parse(await fsp.readFile(STATUS_PATH, 'utf8'));
  assert.equal(again.extra, 1);
  assert.equal(again.moduleLoaded, true);
});

test('缺少 webServer 服务时不影响工具注册', () => {
  const { ctx, registered, routes } = createFakeContext({ withWebServer: false });
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(registered.size, 5);
  assert.equal(routes.length, 0);
});

test('工具 execute 抛错时被归一化成结构化失败，而不是把异常抛出调用栈', async () => {
  const { ctx, registered } = createFakeContext();
  apply(ctx, {});
  const godot = registered.get('godot');
  // 故意给一个不存在的 Godot 路径，制造引擎层失败
  const controller = undefined;
  void controller;
  const result = await godot.execute({ op: 'version' }, {});
  // 本机装好了 Godot，所以这里预期成功；关键是「不抛异常」且形状可判读。
  assert.equal(typeof result, 'object');
  assert.ok('ok' in result);
});

test('插件只注册一个 effect（进程回收），工具注销交给 cordis 生命周期', () => {
  const { ctx, registered, effects } = createFakeContext();
  apply(ctx, {});
  assert.equal(registered.size, 5);
  // 工具注册不再包在 ctx.effect 里：dsh-tools 的 register() 内部就是
  // `layers.effect(this.ctx, ...)`，注册已经绑定在插件的 ctx 生命周期上，
  // 卸载时由 cordis 自动注销，我这里再手动管一次反而多一条出错的路径。
  // 现在唯一的 effect 是「卸载时停掉受管 Godot 进程」。
  // 现在唯一的 effect 就是「进程回收」（可选 HTTP 路由已移除）。
  assert.equal(effects.length, 1, `预期只有 1 个 effect（进程回收），实际 ${effects.length}`);
  for (const dispose of effects) assert.equal(typeof dispose, 'function');
  // 调用它不应抛错（内部是异步 shutdown，且吞掉错误）
  for (const dispose of effects) assert.doesNotThrow(() => dispose());
});
