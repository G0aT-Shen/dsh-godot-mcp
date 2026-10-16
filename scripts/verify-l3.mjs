#!/usr/bin/env node
// L3 运行时桥集成测试：启动真实 Godot 游戏，用本项目 Node TCP 客户端控制它。
//
// 与 L2 同样的理由：bridge-layer 用自己的客户端验证过 addon，这里要确认
// src/bridge.mjs 的 TCP 客户端（callRuntime）与真实游戏里的 autoload 能通。
//
// 默认带窗口启动（rt.screenshot 需要真实帧缓冲）；--headless 可切成无头，
// 此时截图能力会明确失败，脚本会如实记录而不是判失败。
//
// 用法：node scripts/verify-l3.mjs [--headless]

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { GodotController } from '../src/server.mjs';
import { installBridge } from '../src/install.mjs';
import { probePort } from '../src/bridge.mjs';
import { existsSync } from 'node:fs';

const headless = process.argv.includes('--headless');
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}\n`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPort(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort({ port, timeoutMs: 1000 })) return true;
    await sleep(500);
  }
  return false;
}

/** 一个会被 MCP 调用的测试游戏：暴露可观测状态，供 rt.* 读写。 */
const GAME_SCRIPT = `extends Node2D

var counter: int = 0
var last_key: String = ""
var label: Label
var runner: Marker2D
var frames: int = 0
var elapsed: float = 0.0
var clicks: int = 0
var typed: String = ""
var button: Button
var name_box: LineEdit

func _ready() -> void:
	label = Label.new()
	label.name = "Hud"
	label.text = "counter=0"
	add_child(label)
	runner = Marker2D.new()
	runner.name = "Runner"
	runner.add_to_group("runner")
	add_child(runner)
	button = Button.new()
	button.name = "StartBtn"
	button.text = "Start"
	# 注意：headless 下 dummy DisplayServer 给根视口只有 64x64，
	# 落在视口外的点击不会被 GUI 派发。所以测试按钮放在这个范围内，
	# 这样同一套断言在带窗口与无头两种模式下都成立。
	button.position = Vector2(8, 8)
	button.size = Vector2(40, 28)
	button.pressed.connect(_on_start_pressed)
	add_child(button)
	name_box = LineEdit.new()
	name_box.name = "NameBox"
	name_box.position = Vector2(8, 40)
	name_box.size = Vector2(48, 16)
	name_box.text_changed.connect(func(value: String): typed = value)
	add_child(name_box)
	print("GAME_READY")

func _on_start_pressed() -> void:
	clicks += 1

## 故意制造一个真实的脚本运行时错误，用于验证错误捕获链路。
func raise_error() -> void:
	var empty: Array = []
	var _ignored = empty[2]

func raise_warning() -> void:
	push_warning("L3VERIFY_WARNING")

## 置 1 之后，下一次 _process 会抛一个真实运行时错误 ——
## 这样错误才发生在 rt.step 的窗口**内部**，而不是之前某次调用里。
var error_bomb: int = 0

func _process(delta: float) -> void:
	frames += 1
	elapsed += delta
	if runner != null:
		runner.position.x += 100.0 * delta
	if error_bomb > 0:
		error_bomb -= 1
		var empty: Array = []
		var _boom = empty[0]

func bump(amount: int = 1) -> int:
	counter += amount
	label.text = "counter=%d" % counter
	return counter

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed:
		last_key = OS.get_keycode_string(event.keycode)
		print("KEY:", last_key)
`;

async function main() {
  const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-l3-'));
  await fsp.writeFile(
    path.join(projectDir, 'project.godot'),
    'config_version=5\n\n[application]\n\nconfig/name="L3Verify"\nrun/main_scene="res://main.tscn"\n\n[display]\n\nwindow/size/viewport_width=640\nwindow/size/viewport_height=360\n',
    'utf8',
  );
  await fsp.writeFile(
    path.join(projectDir, 'main.tscn'),
    '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://game.gd" id="1_g"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1_g")\n',
    'utf8',
  );
  await fsp.writeFile(path.join(projectDir, 'game.gd'), GAME_SCRIPT, 'utf8');

  const controller = new GodotController({ cwd: projectDir });
  process.stdout.write(`项目：${projectDir}\n模式：${headless ? 'headless' : '带窗口'}\n\n`);

  process.stdout.write('=== 安装桥 ===\n');
  const install = await installBridge(projectDir);
  record('installBridge 成功', install.ok === true, `copied=${install.copied?.length ?? 0}`);
  record('autoload 已写入', install.settings?.autoload === true);

  process.stdout.write('\n=== 启动游戏 ===\n');
  const session = await controller.session('game', { project: projectDir, headless });
  record('游戏会话已启动', session.ok === true, session.session?.id);
  if (!session.ok) return;

  const port = controller.runtimePort;
  const up = await waitForPort(port);
  record(`运行时桥监听 ${port}`, up, up ? 'listening' : '超时未监听');
  if (!up) {
    const logs = await controller.session('logs', { id: session.session.id, limit: 30_000 });
    process.stdout.write(`\n游戏日志：\n${logs?.text?.slice(-3000) ?? '(无)'}\n`);
    return;
  }

  process.stdout.write('\n=== 通过本项目 Node TCP 客户端调用 L3 ===\n');
  const info = await controller.bridge('runtime', 'rt.info');
  record('rt.info', info.ok === true, info.ok ? JSON.stringify(info.data).slice(0, 200) : info.error);

  const tree = await controller.bridge('runtime', 'rt.scene_tree', {});
  record('rt.scene_tree 能看到 Main/Hud', tree.ok === true && JSON.stringify(tree.data).includes('Hud'), tree.ok ? 'found' : tree.error);

  const called = await controller.bridge('runtime', 'rt.call_method', { node_path: 'Main', method: 'bump', args: [7] });
  record('rt.call_method bump(7) 返回 7', called.ok === true && JSON.stringify(called.data).includes('7'), called.ok ? JSON.stringify(called.data).slice(0, 160) : called.error);

  const prop = await controller.bridge('runtime', 'rt.get_property', { node_path: 'Main', property: 'counter' });
  record('rt.get_property counter 被副作用改成 7', prop.ok === true && JSON.stringify(prop.data).includes('7'), prop.ok ? JSON.stringify(prop.data).slice(0, 160) : prop.error);

  const set = await controller.bridge('runtime', 'rt.set_property', { node_path: 'Main', property: 'counter', value: 42 });
  record('rt.set_property counter=42', set.ok === true, set.ok ? JSON.stringify(set.data).slice(0, 160) : set.error);
  const prop2 = await controller.bridge('runtime', 'rt.get_property', { node_path: 'Main', property: 'counter' });
  record('rt.get_property 读回 42', prop2.ok === true && JSON.stringify(prop2.data).includes('42'), JSON.stringify(prop2.data ?? prop2.error).slice(0, 120));

  const input = await controller.bridge('runtime', 'rt.input', { type: 'key', key: 'SPACE' });
  record('rt.input 注入按键', input.ok === true, input.ok ? JSON.stringify(input.data).slice(0, 160) : input.error);
  await sleep(600);
  const keyState = await controller.bridge('runtime', 'rt.get_property', { node_path: 'Main', property: 'last_key' });
  record('注入的按键在游戏内可观测（last_key=Space）', keyState.ok === true && JSON.stringify(keyState.data).includes('Space'), keyState.ok ? JSON.stringify(keyState.data).slice(0, 120) : keyState.error);

  const evaluated = await controller.bridge('runtime', 'rt.eval', { source: 'return 6 * 7\n' });
  record('rt.eval 逃生舱返回 42', evaluated.ok === true && JSON.stringify(evaluated.data).includes('42'), evaluated.ok ? JSON.stringify(evaluated.data).slice(0, 160) : evaluated.error);

  process.stdout.write('\n=== 截图 ===\n');
  const shot = await controller.bridge('runtime', 'rt.screenshot', {});
  if (shot.ok) {
    // 回归守卫：截图只应回一个 base64 字段。曾经同时回 base64/png_base64/data_uri，
    // 同一份数据写三遍，在工具结果里等于三倍 token。
    const base64Fields = Object.keys(shot.data ?? {}).filter(key => /base64|data_uri/i.test(key));
    record(
      'rt.screenshot 只回一个 base64 字段（避免同一张图重复编码）',
      base64Fields.length === 1 && base64Fields[0] === 'png_base64',
      `实际字段：${JSON.stringify(base64Fields)}`,
    );
    const base64 = shot.data?.png_base64 ?? '';
    record('rt.screenshot 返回 PNG', base64.length > 100, `base64 长度 ${base64.length}`);
    if (base64.length > 100) {
      const buffer = Buffer.from(base64, 'base64');
      const isPng = buffer[0] === 0x89 && buffer.subarray(1, 4).toString() === 'PNG';
      const out = path.join(process.cwd(), 'verification', 'l3-screenshot.png');
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await fsp.writeFile(out, buffer);
      record('截图是合法 PNG 并已落盘', isPng, `${out} (${buffer.length} 字节)`);
    }

    // 给了 path 就落盘，并且默认不再回 base64 —— 一张截图动辄上千 token，
    // 而调用方通常只需要一个能直接打开的文件路径。
    const directPath = path.join(projectDir, 'shot-direct.png');
    const direct = await controller.bridge('runtime', 'rt.screenshot', { path: directPath });
    if (direct.ok) {
      const wrote = await fsp.readFile(directPath).catch(() => undefined);
      record(
        'rt.screenshot{path} 直接把 PNG 写到磁盘',
        wrote !== undefined && wrote[0] === 0x89 && wrote.subarray(1, 4).toString() === 'PNG',
        `saved=${direct.data?.saved} bytes=${wrote?.length}`,
      );
      record(
        'rt.screenshot{path} 默认不回 base64（省上下文）',
        direct.data?.png_base64 === undefined && /base64|data_uri/i.test(JSON.stringify(Object.keys(direct.data ?? {}))) === false,
        `字段：${JSON.stringify(Object.keys(direct.data ?? {}))}`,
      );
      record(
        '落盘截图仍然报告尺寸与模式',
        direct.data?.width > 0 && direct.data?.height > 0 && direct.data?.headless === false,
        `${direct.data?.width}x${direct.data?.height} headless=${direct.data?.headless}`,
      );
    } else {
      record('rt.screenshot{path} 应成功', false, direct.error);
    }

    // inline:true 与 path 同时给时，两边都要满足
    const both = await controller.bridge('runtime', 'rt.screenshot', { path: path.join(projectDir, 'shot-inline.png'), inline: true });
    record(
      'path + inline:true 同时落盘并回 base64',
      both.ok === true && both.data?.png_base64?.length > 100 && both.data?.saved !== undefined,
      both.ok ? `bytes=${both.data?.bytes} saved=${Boolean(both.data?.saved)}` : both.error,
    );

    // 两次独立截图必须真的不一样：曾经因为帧同步不到位，
    // 连拍两张拿到字节完全相同的图（画面早变了），看起来却像「渲染没变」。
    const again = await controller.bridge('runtime', 'rt.screenshot', {});
    record(
      '连拍两张得到的是不同帧（帧同步没有返回陈旧缓冲）',
      again.ok === true && again.data?.captured_frame !== shot.data?.captured_frame,
      `frame ${shot.data?.captured_frame} → ${again.data?.captured_frame}`,
    );
  } else if (headless) {
    record('rt.screenshot 在 headless 下如实报错（预期行为）', /dummy|帧缓冲|framebuffer|headless/i.test(String(shot.error)), String(shot.error).slice(0, 160));
  } else {
    record('rt.screenshot 带窗口时应成功', false, shot.error);
  }

  process.stdout.write('\n=== 错误路径 ===\n');
  const bad = await controller.bridge('runtime', 'rt.get_property', { node_path: 'Main', property: 'no_such_property_xyz' });
  record('读不存在的属性返回 ok:false', bad.ok === false, String(bad.error).slice(0, 120));

  process.stdout.write('\n=== 确定性时间控制 ===\n');
  const framesOf = async () => (await controller.bridge('runtime', 'rt.get_property', { node_path: 'Main', property: 'frames' })).data?.value;
  const runnerX = async () => (await controller.bridge('runtime', 'rt.digest', { groups: ['runner'] })).data?.nodes?.[0]?.position?.x;

  const frozen = await controller.bridge('runtime', 'rt.freeze', {});
  record(
    'rt.freeze 硬冻结（time_scale=0 且 paused=true）',
    frozen.ok === true && frozen.data?.time_scale === 0 && frozen.data?.paused === true,
    frozen.ok ? `time_scale=${frozen.data?.time_scale} paused=${frozen.data?.paused}` : frozen.error,
  );

  // 关键性质：冻结期间连 _process 都不再被调用 —— 这才是「观察不和推进抢跑」
  const frozenFramesA = await framesOf();
  await sleep(700);
  const frozenFramesB = await framesOf();
  record(
    '冻结期间 _process 完全停止（帧计数不增长）',
    frozenFramesA === frozenFramesB && typeof frozenFramesA === 'number',
    `frames ${frozenFramesA} → ${frozenFramesB}（真实等待 700ms）`,
  );

  const posBefore = await runnerX();
  const stepped = await controller.bridge('runtime', 'rt.step', { frames: 30 });
  const posAfter = await runnerX();
  record(
    'rt.step{frames:30} 精确推进 30 帧且游戏确实前进了',
    stepped.ok === true && stepped.data?.frames === 30 && posAfter > posBefore,
    stepped.ok ? `frames=${stepped.data?.frames} ms=${stepped.data?.ms} x ${Number(posBefore).toFixed(1)}→${Number(posAfter).toFixed(1)}` : stepped.error,
  );

  const untilRes = await controller.bridge('runtime', 'rt.step', {
    until: 'node.get_tree().current_scene.runner.position.x >= 200.0',
    max_frames: 400,
  });
  record(
    'rt.step{until} 条件达成即停（不是跑满预算）',
    untilRes.ok === true && untilRes.data?.satisfied === true && untilRes.data?.frames < 400,
    untilRes.ok ? `satisfied=${untilRes.data?.satisfied} frames=${untilRes.data?.frames}` : untilRes.error,
  );

  const never = await controller.bridge('runtime', 'rt.step', { until: 'false', max_frames: 12 });
  record(
    '条件永不成立时如实回 satisfied=false 且耗尽预算（不假装成功）',
    never.ok === true && never.data?.satisfied === false && never.data?.frames === 12,
    never.ok ? `satisfied=${never.data?.satisfied} frames=${never.data?.frames}` : never.error,
  );

  const tooBig = await controller.bridge('runtime', 'rt.step', { frames: 99_999 });
  record('超出步进上限被明确拒绝', tooBig.ok === false && /上限/.test(String(tooBig.error)), String(tooBig.error).slice(0, 90));

  const resumed = await controller.bridge('runtime', 'rt.resume', {});
  record(
    'rt.resume 把 time_scale 与 paused 都还原',
    resumed.ok === true && resumed.data?.frozen === false && resumed.data?.time_scale === 1 && resumed.data?.paused === false,
    resumed.ok ? JSON.stringify(resumed.data) : resumed.error,
  );

  process.stdout.write('\n=== 结构化状态 digest ===\n');
  const dig = await controller.bridge('runtime', 'rt.digest', { groups: ['runner'] });
  record(
    'rt.digest 按 group 选中节点并带出结构化字段',
    dig.ok === true && dig.data?.count === 1 && dig.data?.nodes?.[0]?.class === 'Marker2D' && typeof dig.data?.nodes?.[0]?.position?.x === 'number',
    dig.ok ? JSON.stringify(dig.data?.nodes?.[0]).slice(0, 150) : dig.error,
  );
  const byClass = await controller.bridge('runtime', 'rt.digest', { classes: ['Label'], props: ['text'] });
  record(
    'rt.digest 支持按 class 选节点和追加自定义属性',
    byClass.ok === true && byClass.data?.count >= 1 && typeof byClass.data?.nodes?.[0]?.text === 'string',
    byClass.ok ? JSON.stringify(byClass.data?.nodes?.[0]).slice(0, 150) : byClass.error,
  );
  const missingGroup = await controller.bridge('runtime', 'rt.digest', { groups: ['no_such_group_xyz'] });
  record(
    '不存在的 group 如实回报 missing_groups（不静默返回空）',
    missingGroup.ok === true && missingGroup.data?.missing_groups?.[0] === 'no_such_group_xyz',
    missingGroup.ok ? JSON.stringify(missingGroup.data?.missing_groups) : missingGroup.error,
  );

  process.stdout.write('\n=== 控件清单 rt.ui ===\n');
  const ui = await controller.bridge('runtime', 'rt.ui', {});
  const uiButton = (ui.data?.controls ?? []).find(c => c.name === 'StartBtn');
  const uiBox = (ui.data?.controls ?? []).find(c => c.name === 'NameBox');
  record(
    'rt.ui 列出可见 Control（含矩形与文本）',
    ui.ok === true && uiButton !== undefined && uiButton.text === 'Start' && uiButton.rect?.w > 0,
    ui.ok ? `count=${ui.data?.count} btn=${JSON.stringify(uiButton && { text: uiButton.text, rect: uiButton.rect })}` : ui.error,
  );
  record(
    'rt.ui 带出 mouse_filter / disabled 这类交互属性',
    uiButton?.mouse_filter !== undefined && uiButton?.disabled === false,
    uiButton ? `mouse_filter=${uiButton.mouse_filter} disabled=${uiButton.disabled}` : '(未找到按钮)',
  );

  process.stdout.write('\n=== 输入序列 rt.act ===\n');
  const clicksBefore = (await controller.bridge('runtime', 'rt.get_property', { node_path: 'Main', property: 'clicks' })).data?.value ?? 0;
  const act = await controller.bridge('runtime', 'rt.act', {
    watch: ['/root/Main'],
    watch_props: ['clicks'],
    steps: [
      { type: 'click', node: '/root/Main/StartBtn' },
      { type: 'tap', action: 'ui_accept' },
      { type: 'wait', frames: 3 },
    ],
  });
  record('rt.act 执行完整序列', act.ok === true && act.data?.executed === 3 && act.data?.aborted === false, act.ok ? `executed=${act.data?.executed}/${act.data?.planned} frames=${act.data?.frames}` : act.error);
  const clickStep = act.data?.steps?.[0];
  record(
    '每一步回报「点到了哪个 Control」',
    clickStep?.hit?.path === '/root/Main/StartBtn' && clickStep.hit.class === 'Button',
    clickStep?.hit ? `${clickStep.hit.path} [${clickStep.hit.class}] "${clickStep.hit.text}"` : JSON.stringify(clickStep),
  );
  const clicksAfter = (await controller.bridge('runtime', 'rt.get_property', { node_path: 'Main', property: 'clicks' })).data?.value;
  record(
    '注入的点击真的触发了按钮（clicks 增加）',
    clicksAfter === clicksBefore + 1,
    `clicks ${clicksBefore} → ${clicksAfter}`,
  );
  record(
    '每一步回报「这一步之后被观察节点的状态」',
    act.data?.initial?.[0]?.clicks === clicksBefore && act.data?.steps?.[0]?.after?.[0]?.clicks === clicksAfter,
    `initial.clicks=${act.data?.initial?.[0]?.clicks} step0.after.clicks=${act.data?.steps?.[0]?.after?.[0]?.clicks}`,
  );
  const badStep = await controller.bridge('runtime', 'rt.act', {
    steps: [{ type: 'tap', action: 'ui_accept' }, { type: 'click', node: '/root/Main/DoesNotExist' }, { type: 'tap', action: 'ui_accept' }],
  });
  record(
    '坏步骤如实报错并中止（不假装跑完）',
    badStep.ok === true && badStep.data?.aborted === true && badStep.data?.executed === 2 && badStep.data?.steps?.[1]?.ok === false,
    `executed=${badStep.data?.executed}/${badStep.data?.planned} error=${badStep.data?.steps?.[1]?.error}`,
  );
  const continued = await controller.bridge('runtime', 'rt.act', {
    continue_on_error: true,
    steps: [{ type: 'click', node: '/root/Main/DoesNotExist' }, { type: 'tap', action: 'ui_accept' }],
  });
  record(
    'continue_on_error=true 时继续跑后面的步骤',
    continued.ok === true && continued.data?.executed === 2 && continued.data?.aborted === false,
    `executed=${continued.data?.executed} aborted=${continued.data?.aborted}`,
  );
  const badType = await controller.bridge('runtime', 'rt.act', { steps: [{ type: 'no_such_action' }] });
  record('未知步骤类型被明确拒绝', badType.ok === true && badType.data?.steps?.[0]?.ok === false, badType.data?.steps?.[0]?.error);

  process.stdout.write('\n=== 运行时错误捕获 rt.errors ===\n');
  const errorsBefore = (await controller.bridge('runtime', 'rt.errors', {})).data;
  record('错误记录器已装上', errorsBefore?.recorder === true, `recorder=${errorsBefore?.recorder} total=${errorsBefore?.total}`);
  await controller.bridge('runtime', 'rt.act', {
    steps: [{ type: 'call', node: '/root/Main', method: 'raise_error' }, { type: 'call', node: '/root/Main', method: 'raise_warning' }],
  });
  const errorsAfter = (await controller.bridge('runtime', 'rt.errors', {})).data;
  const scriptError = errorsAfter?.errors?.find(e => e.type === 'script' && /index|bounds/i.test(String(e.code)));
  const warning = errorsAfter?.errors?.find(e => e.type === 'warning' && String(e.code).includes('L3VERIFY_WARNING'));
  record('捕获真实脚本运行时错误', scriptError !== undefined, scriptError ? String(scriptError.code).slice(0, 80) : JSON.stringify(errorsAfter?.errors?.map(e => e.code)));
  record(
    '错误定位到用户脚本（而不是引擎内部的 variant_utility.cpp）',
    String(scriptError?.file).startsWith('res://') && Number(scriptError?.line) > 0 && scriptError?.function === 'raise_error',
    scriptError ? `${scriptError.file}:${scriptError.line} in ${scriptError.function}()` : '(无)',
  );
  record(
    '带调用链 backtrace，且首帧就是出错的那一行',
    Array.isArray(scriptError?.backtrace) && scriptError.backtrace.length >= 1 && scriptError.backtrace[0]?.file === 'res://game.gd',
    scriptError ? JSON.stringify(scriptError.backtrace.slice(0, 2)) : '(无)',
  );
  record('push_warning 也被捕获并归类为 warning', warning !== undefined, warning ? String(warning.code) : '(无)');
  const incremental = await controller.bridge('runtime', 'rt.errors', { since: errorsAfter.total - 1 });
  record(
    '支持 since 增量读取（不重复拉全量）',
    incremental.ok === true && incremental.data?.returned === 0 && incremental.data?.next_since === errorsAfter.total - 1,
    `returned=${incremental.data?.returned} next_since=${incremental.data?.next_since}`,
  );
  const onlyWarn = await controller.bridge('runtime', 'rt.errors', { type: 'warning' });
  record(
    '支持按类型过滤',
    onlyWarn.ok === true && onlyWarn.data.errors.length >= 1 && onlyWarn.data.errors.every(e => e.type === 'warning'),
    `returned=${onlyWarn.data?.returned}`,
  );

  process.stdout.write('\n=== 改坏代码后 rt.step 顺带汇报 ===\n');
  await controller.bridge('runtime', 'rt.errors', { clear: true });
  await controller.bridge('runtime', 'rt.freeze', {});
  // 先埋一颗「下一帧就炸」的雷：错误必须发生在 step 的窗口内部才算数
  await controller.bridge('runtime', 'rt.set_property', { node_path: 'Main', property: 'error_bomb', value: 1 });
  const stepWithErrors = await controller.bridge('runtime', 'rt.step', { frames: 8 });
  await controller.bridge('runtime', 'rt.resume', {});
  record(
    'rt.step 汇报窗口内新增的错误数（改完代码立刻知道有没有炸）',
    stepWithErrors.ok === true && stepWithErrors.data?.errors_new >= 1,
    `errors_new=${stepWithErrors.data?.errors_new} errors_total=${stepWithErrors.data?.errors_total}`,
  );
  const stepClean = await controller.bridge('runtime', 'rt.step', { frames: 4 });
  record('没有新错误时如实回 errors_new=0', stepClean.data?.errors_new === 0, `errors_new=${stepClean.data?.errors_new}`);
  const cleared = await controller.bridge('runtime', 'rt.errors', { clear: true });
  record('rt.errors{clear} 清空缓冲', cleared.ok === true && (await controller.bridge('runtime', 'rt.errors', {})).data?.returned === 0, `cleared=${cleared.data?.cleared}`);

  process.stdout.write('\n=== 收尾 ===\n');
  const quit = await controller.bridge('runtime', 'rt.quit', {});
  record('rt.quit 生效', quit.ok === true, quit.ok ? JSON.stringify(quit.data).slice(0, 120) : quit.error);
  await sleep(1200);
  await controller.session('stop', { kind: 'game' });

  const logs = controller.processes.list();
  const last = logs[logs.length - 1];
  record('游戏进程已退出', last?.running === false, `exitCode=${last?.exitCode}`);

  // ---------------------------------------------------------------- 零足迹注入
  //
  // 这一节故意起一个**全新项目**：不跑 setup、不装 addon，验证「用一次运行时工具
  // 必须往用户仓库里提交一个桥」这件事真的被去掉了。
  process.stdout.write('\n=== 零足迹注入 ===\n');
  const cleanDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-zero-'));
  const cleanProjectFile = path.join(cleanDir, 'project.godot');
  const cleanProjectText = 'config_version=5\n\n[application]\n\nconfig/name="ZeroFootprint"\nrun/main_scene="res://main.tscn"\n\n[display]\n\nwindow/size/viewport_width=320\nwindow/size/viewport_height=180\n';
  await fsp.writeFile(cleanProjectFile, cleanProjectText, 'utf8');
  await fsp.writeFile(
    path.join(cleanDir, 'main.tscn'),
    '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://game.gd" id="1_g"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1_g")\n',
    'utf8',
  );
  await fsp.writeFile(path.join(cleanDir, 'game.gd'), GAME_SCRIPT, 'utf8');

  const zeroSession = await controller.session('game', { project: cleanDir, headless });
  record(
    'auto 模式在未安装桥的项目上选到 transient（不需要先 setup）',
    zeroSession.session?.bridge?.mode === 'transient',
    zeroSession.session?.bridge?.mode ?? zeroSession.error,
  );
  const overridePath = path.join(cleanDir, 'override.cfg');
  const scriptPath = path.join(cleanDir, '.godot', 'mcp_bridge', 'godot_mcp_runtime.gd');
  record(
    '只多出 override.cfg 与 .godot/ 下的脚本',
    existsSync(overridePath) && existsSync(scriptPath),
    `override=${existsSync(overridePath)} script=${existsSync(scriptPath)}`,
  );
  record(
    'project.godot 全程一个字节都没变',
    (await fsp.readFile(cleanProjectFile, 'utf8')) === cleanProjectText,
    '与写入时逐字节比较',
  );
  const zeroUp = await waitForPort(9091, 60_000);
  record('零足迹注入的游戏把 9091 监听起来', zeroUp, zeroUp ? 'listening' : '60s 内未监听');
  const zeroInfo = await controller.bridge('runtime', 'rt.info', {});
  record('零足迹注入的桥真的可用', zeroInfo.ok === true && typeof zeroInfo.data?.frame === 'number', zeroInfo.ok ? `frame=${zeroInfo.data?.frame}` : zeroInfo.error);

  const zeroStop = await controller.session('stop', { id: zeroSession.session?.id });
  record(
    'stop 后 override.cfg 与脚本目录都被清掉',
    zeroStop.bridgeCleanup?.removedOverride === true && zeroStop.bridgeCleanup?.removedScript === true,
    zeroStop,
  );
  record(
    'stop 后项目目录恢复原状（只剩原有三个文件）',
    JSON.stringify((await fsp.readdir(cleanDir)).sort()) === JSON.stringify(['.godot', 'game.gd', 'main.tscn', 'project.godot']),
    JSON.stringify((await fsp.readdir(cleanDir)).sort()),
  );

  process.stdout.write('\n=== 注入生命周期回归 ===\n');
  const ownOverride = '[application]\n\nconfig/name="UserOverride"\n';
  await fsp.writeFile(overridePath, ownOverride);
  const exitingSession = await controller.session('game', { project: cleanDir, headless });
  if (!exitingSession.ok) throw new Error(exitingSession.error);
  await waitForPort(9091, 60_000);
  const naturalQuit = await controller.bridge('runtime', 'rt.quit', {});
  const exitingProcess = controller.processes.get(exitingSession.session.id);
  const exitDeadline = Date.now() + 10_000;
  while (exitingProcess.running && Date.now() < exitDeadline) await sleep(25);
  await exitingProcess.bridgeCleanup;
  record('自然退出无需 stop 就清理运行时脚本', naturalQuit.ok && !exitingProcess.running && !existsSync(scriptPath), {quit: naturalQuit, process: exitingProcess.toJSON(), cleanup: await exitingProcess.bridgeCleanup});
  record('自然退出后用户 override.cfg 逐字节还原', (await fsp.readFile(overridePath, 'utf8')) === ownOverride);

  const kindSession = await controller.session('game', { project: cleanDir, headless });
  if (!kindSession.ok) throw new Error(kindSession.error);
  await waitForPort(9091, 60_000);
  const kindStop = await controller.session('stop', { kind: 'game' });
  record('按 kind 停止也等待注入清理', kindStop.ok && !existsSync(scriptPath) && !controller.processes.get(kindSession.session.id).running, kindStop);
  record('重复启动并按 kind 停止后用户配置仍完整', (await fsp.readFile(overridePath, 'utf8')) === ownOverride);

  // ---------------------------------------------------------------- attach / detach
  //
  // 场景：游戏不是你启动的（CI、手动 godot --path .、外部调试器）。
  // attach 只注入桥不启动；之后那台游戏一跑起来就能被接管。
  process.stdout.write('\n=== attach / detach ===\n');
  const attachDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-attach-'));
  const attachProjectText = 'config_version=5\n\n[application]\n\nconfig/name="AttachMe"\nrun/main_scene="res://main.tscn"\n\n[display]\n\nwindow/size/viewport_width=320\nwindow/size/viewport_height=180\n';
  await fsp.writeFile(path.join(attachDir, 'project.godot'), attachProjectText, 'utf8');
  await fsp.writeFile(
    path.join(attachDir, 'main.tscn'),
    '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://game.gd" id="1_g"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1_g")\n',
    'utf8',
  );
  await fsp.writeFile(path.join(attachDir, 'game.gd'), GAME_SCRIPT, 'utf8');

  const attached = await controller.session('attach', { project: attachDir });
  record(
    'attach 只注入不启动（项目里出现 override.cfg，没有新进程）',
    attached.ok === true && existsSync(path.join(attachDir, 'override.cfg')) && attached.session === undefined,
    attached.ok ? `id=${attached.id} mode=${attached.bridge?.mode}` : attached.error,
  );
  record('attach 不动 project.godot', (await fsp.readFile(path.join(attachDir, 'project.godot'), 'utf8')) === attachProjectText, '逐字节比较');
  const listed = await controller.session('list', {});
  record(
    'attach 条目出现在 session(list) 里（可发现、可撤销）',
    listed.sessions?.some(item => item.kind === 'attached' && item.projectPath === attachDir),
    JSON.stringify(listed.sessions?.filter(i => i.kind === 'attached').map(i => i.id)),
  );

  // 模拟「外部」启动：bridge:'none' 表示 MCP 不注入，游戏靠已存在的 override.cfg 起来
  const externalGame = await controller.processes.startGame({ project: attachDir, bridge: 'none' });
  const attachUp = await waitForPort(9091, 60_000);
  record('外部启动的游戏被 attach 注入的桥接上', attachUp, attachUp ? 'listening' : '60s 内未监听');
  const attachedInfo = await controller.bridge('runtime', 'rt.info', {});
  record(
    'attach 后的游戏可被运行时工具控制，且 bridge 报 none（是它自己带起来的桥）',
    attachedInfo.ok === true && externalGame.bridge?.mode === 'none',
    attachedInfo.ok ? `frame=${attachedInfo.data?.frame}` : attachedInfo.error,
  );

  await controller.session('stop', { id: externalGame.id });
  const detached = await controller.session('detach', { project: attachDir });
  record(
    'detach 撤掉注入并把 project.godot 还原',
    detached.ok === true && existsSync(path.join(attachDir, 'override.cfg')) === false &&
      (await fsp.readFile(path.join(attachDir, 'project.godot'), 'utf8')) === attachProjectText,
    JSON.stringify({ removedOverride: detached.removedOverride, removedScript: detached.removedScript }),
  );
  await fsp.rm(attachDir, { recursive: true, force: true }).catch(() => {});

  await fsp.rm(cleanDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => {});
}

main()
  .catch(error => record('链路异常中断', false, String(error?.stack ?? error)))
  .finally(() => {
    const failed = results.filter(result => !result.ok);
    process.stdout.write(`\n=== 汇总 ===\n通过 ${results.length - failed.length}/${results.length}\n`);
    for (const item of failed) process.stdout.write(`  - ${item.name}: ${JSON.stringify(item.detail)}\n`);
    process.exitCode = failed.length ? 1 : 0;
  });
