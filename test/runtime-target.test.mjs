// 运行时目标选择与 pid 语义回归（Windows 正确性优先）。
//
// 两条真实教训：
//   1. macOS 默认 keepAwake=true 会用 caffeinate 包住 Godot，`child.pid` 是 **caffeinate**
//      的 pid —— 拿它做严格 PID 校验会把正常的 L3 ready/bridge 判成 PID_MISMATCH。
//      Windows 没有 caffeinate，`child.pid` 就是引擎本身，PID 校验必须严格。
//   2. 同一个项目可能同时开着多个会话（各自不同 runtimePort）：必须**按端口**选目标，
//      不能拿「第一个会话」的 pid 顶替，否则命令会发进另一个端口上的游戏。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GodotController } from '../src/server.mjs';
import { keepAwakeCommand, trustedEnginePid } from '../src/processes.mjs';

const fakeSession = ({ id, projectPath, runtimePort, pidSource = 'direct', enginePid, childPid }) => ({
  id,
  kind: 'game',
  running: true,
  projectPath,
  runtimePort,
  pidSource,
  enginePid,
  child: { pid: childPid },
  toJSON: () => ({ id, kind: 'game', running: true, projectPath, runtimePort, pidSource }),
});

function withSessions(sessions) {
  const controller = new GodotController();
  for (const session of sessions) controller.processes.processes.set(session.id, session);
  return controller;
}

test('Windows 上 keepAwake 不包 wrapper（child.pid 必须是引擎本身）', () => {
  const win = keepAwakeCommand('C:\\Godot\\Godot_v4.7.2-stable_win64.exe', ['--path', 'C:\\proj'], true, 'win32');
  assert.equal(win.keepAwake, false, 'Windows 不允许出现 wrapper pid（否则 PID 校验失去意义）');
  assert.equal(win.command, 'C:\\Godot\\Godot_v4.7.2-stable_win64.exe');
  assert.deepEqual(win.args, ['--path', 'C:\\proj']);
  // macOS 上才可能包 wrapper
  const mac = keepAwakeCommand('/tmp/Godot', ['--path', '/proj'], true, 'darwin');
  assert.equal(typeof mac.keepAwake, 'boolean');
});

test('trustedEnginePid：wrapper 未解析出真实引擎 pid 时不冒充', () => {
  assert.equal(trustedEnginePid({ pidSource: 'direct', enginePid: 111, child: { pid: 111 } }), 111);
  assert.equal(trustedEnginePid({ pidSource: 'wrapper-resolved', enginePid: 222, child: { pid: 999 } }), 222, '必须返回真实引擎 pid，而不是 caffeinate 的 pid');
  assert.equal(trustedEnginePid({ pidSource: 'unresolved-wrapper', child: { pid: 999 } }), undefined, '解析不出来就不传 pid');
  assert.equal(trustedEnginePid(undefined), undefined);
});

test('resolveRuntimeTarget：同项目多会话按端口选目标，不拿第一个会话顶替', async () => {
  const controller = withSessions([
    fakeSession({ id: 'a', projectPath: '/work/projA', runtimePort: 9101, enginePid: 1001, childPid: 1001 }),
    fakeSession({ id: 'b', projectPath: '/work/projA', runtimePort: 9102, enginePid: 1002, childPid: 1002 }),
  ]);
  const picked = await controller.resolveRuntimeTarget({ project: '/work/projA' }, 9102);
  assert.equal(picked.pid, 1002, `必须按端口选中第二个会话：${JSON.stringify(picked)}`);
  assert.equal(picked.pidVerified, true);

  // 端口不属于任何会话：不拿别的会话的 pid 顶替
  const unmatched = await controller.resolveRuntimeTarget({ project: '/work/projA' }, 9103);
  assert.equal(unmatched.pid, undefined);
  assert.equal(unmatched.pidVerified, false);
  assert.match(String(unmatched.pidSource), /port-unmatched/);
});

test('resolveRuntimeTarget：caffeinate 未解析出引擎 pid 时只校验项目（pidVerified=false）', async () => {
  const controller = withSessions([
    fakeSession({ id: 'a', projectPath: '/work/projA', runtimePort: 9101, pidSource: 'unresolved-wrapper', childPid: 4242 }),
  ]);
  const target = await controller.resolveRuntimeTarget({ project: '/work/projA' }, 9101);
  assert.equal(target.project, '/work/projA');
  assert.equal(target.pid, undefined, '不能把 caffeinate 的 pid 当成引擎 pid');
  assert.equal(target.pidVerified, false);
  assert.equal(target.pidSource, 'unresolved-wrapper');

  const resolved = withSessions([
    fakeSession({ id: 'a', projectPath: '/work/projA', runtimePort: 9101, pidSource: 'wrapper-resolved', enginePid: 777, childPid: 4242 }),
  ]);
  const target2 = await resolved.resolveRuntimeTarget({ project: '/work/projA' }, 9101);
  assert.equal(target2.pid, 777, '解析到真实引擎 pid 时必须用它做严格校验');
  assert.equal(target2.pidVerified, true);
});

test('resolveRuntimeTarget：多个项目且未指定 project → AMBIGUOUS_PROJECT', async () => {
  const controller = withSessions([
    fakeSession({ id: 'a', projectPath: '/work/one', runtimePort: 9101, enginePid: 11, childPid: 11 }),
    fakeSession({ id: 'b', projectPath: '/work/two', runtimePort: 9102, enginePid: 22, childPid: 22 }),
  ]);
  const target = await controller.resolveRuntimeTarget({}, 9101);
  assert.equal(target.error.code, 'AMBIGUOUS_PROJECT');
});

test('resolveRuntimeTarget：斜杠/盘符大小写/realpath 别名都要认出同一个项目并选中 knownPID', async t => {
  // 1) 末尾斜杠（斜杠形式差异）
  const slash = withSessions([
    fakeSession({ id: 'a', projectPath: '/work/projA/', runtimePort: 9101, enginePid: 1001, childPid: 1001 }),
  ]);
  const picked = await slash.resolveRuntimeTarget({ project: '/work/projA' }, 9101);
  assert.equal(picked.pid, 1001, `斜杠差异不该丢掉 knownPID：${JSON.stringify(picked)}`);

  // 2) Windows 盘符大小写 + 正反斜杠（用注入的 platform 让断言在 macOS 上也能确定复现）
  const win = new GodotController({ identityOptions: { platform: 'win32' } });
  win.processes.processes.set('a', fakeSession({
    id: 'a', projectPath: 'C:\\Games\\MyProj', runtimePort: 9102, enginePid: 2002, childPid: 2002,
  }));
  const winPicked = await win.resolveRuntimeTarget({ project: 'c:/games/myproj' }, 9102);
  assert.equal(winPicked.pid, 2002, `盘符大小写/斜杠差异不该丢掉 knownPID：${JSON.stringify(winPicked)}`);

  // 3) realpath 别名（symlink/junction）：真实目录 + 链接，两边都要认成同一个项目
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-alias-'));
  const link = `${dir}-link`;
  let linked = false;
  try {
    await fsp.symlink(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch {
    linked = false;
  }
  t.after(async () => {
    if (linked) await fsp.rm(link, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  });
  if (!linked) {
    t.diagnostic('本平台无法创建目录链接（需要权限），跳过 realpath 别名那一段');
    return;
  }
  const alias = withSessions([
    fakeSession({ id: 'a', projectPath: dir, runtimePort: 9103, enginePid: 3003, childPid: 3003 }),
  ]);
  const viaLink = await alias.resolveRuntimeTarget({ project: link }, 9103);
  assert.equal(viaLink.pid, 3003, `realpath 别名不该丢掉 knownPID：${JSON.stringify(viaLink)}`);
  const realPath = await fsp.realpath(dir);
  const viaReal = await alias.resolveRuntimeTarget({ project: realPath }, 9103);
  assert.equal(viaReal.pid, 3003);

  // 4) 别名不能让「多项目」判定失真：同一项目的两个别名仍然只是一个项目
  const twice = withSessions([
    fakeSession({ id: 'a', projectPath: dir, runtimePort: 9101, enginePid: 11, childPid: 11 }),
    fakeSession({ id: 'b', projectPath: link, runtimePort: 9102, enginePid: 22, childPid: 22 }),
  ]);
  const grouped = await twice.resolveRuntimeTarget({}, 9102);
  assert.equal(grouped.error, undefined, `同一项目的别名不能被当成两个项目：${JSON.stringify(grouped)}`);
  assert.equal(grouped.pid, 22, '归并后仍要按端口选中正确的会话');
});
