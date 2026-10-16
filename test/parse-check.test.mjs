// deep parse_check 的结论可信度回归（跨平台；Windows 上这条尤其关键）。
//
// Windows CI 第二轮实测：`--check-only` 在脚本**解析失败**时退出码是 **1**（macOS 是 0）。
// 旧实现把「非零退出」一律当成「检查没跑完」，于是真的语法错误被记成
//   {"check_failed": true, "line": 0, "message": "check did not complete: exit=1 ..."}
// 结果：unique 虚高（2 而不是 1）、行号丢失（0 而不是 8）、affects 丢掉依赖链、
// 「没有把被连累的文件误标成独立错误」也跟着失败。
//
// 判定规则必须是：
//   timeout/orphan/still_running            → 没跑完（check_failed）
//   exit 0 或 exit 1 且有定位诊断           → 检查完成，结论在诊断里
//   其它非零或 exit 1 无定位诊断            → 不可信，绝不当成「干净」

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { godotPath } from '../src/godot.mjs';
import { runOperation } from '../src/operations.mjs';

const ENGINE = godotPath();
const REQUIRE_GODOT = process.env.GODOT_MCP_REQUIRE_GODOT === '1';
const NO_ENGINE = ENGINE ? undefined : (REQUIRE_GODOT ? 'CI 要求真实 Godot，但没有找到可执行文件' : '没有可用的真实 Godot');

// fixture 形态与 Windows CI 上的一致：base.gd 自身有语法错，依赖文件引用它。
// 关键点：base.gd 的报错必须带**定位**（res://base.gd:3），这样判定才要求
// 「exit 1 + 定位诊断」（Windows 的 --check-only 对该情形退出码是 1）。
const BROKEN_BASE = `class_name BaseX

func broken( -> void:
	pass
`;
const DEPENDENT = `extends Node

const B := preload("res://base.gd")

func use() -> void:
	pass
`;
const CLEAN = `extends Node


func ok() -> int:
	return 42
`;

test('deep parse_check：真实语法错误必须报出真实行号，且不得被当成「检查没跑完」', { skip: NO_ENGINE && !REQUIRE_GODOT ? NO_ENGINE : false }, async t => {
  if (NO_ENGINE) assert.fail(NO_ENGINE);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-parsecheck-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="ParseCheck"\n', 'utf8');
  await fsp.writeFile(path.join(dir, 'base.gd'), BROKEN_BASE, 'utf8');
  await fsp.writeFile(path.join(dir, 'dep1.gd'), DEPENDENT, 'utf8');
  await fsp.writeFile(path.join(dir, 'clean.gd'), CLEAN, 'utf8');

  const result = await runOperation('parse_check', {
    deep: true,
    paths: ['res://base.gd', 'res://dep1.gd', 'res://clean.gd'],
  }, { project: dir, timeoutMs: 300_000 });
  const data = result.data ?? {};
  t.diagnostic(`parse_check: ${JSON.stringify({ checked: data.checked, unique: data.unique_errors, failed: data.checks_failed, incomplete: data.incomplete, errors: data.errors })}`);

  // 1) 关键回归：真语法错误不能被当成「检查没跑完」（Windows 上 --check-only 退出码是 1）
  assert.equal(data.incomplete, false, `不得把真语法错误判成 incomplete：${JSON.stringify(data.errors)}`);
  assert.equal(data.checks_failed, 0, `不得把真语法错误判成 check_failed：${JSON.stringify(data.errors)}`);
  assert.equal(data.checked, 3, '三个请求文件都必须被真编译');
  const baseErrors = (data.errors ?? []).filter(entry => entry.origin === 'res://base.gd' && !entry.cascade);
  assert.equal(baseErrors.length, 1, `base.gd 的主错误必须且只有一条：${JSON.stringify(data.errors)}`);
  const main = baseErrors[0];
  assert.notEqual(main.check_failed, true, '真语法错误不得带 check_failed 标记');
  assert.ok(main.line > 0, `必须报出真实行号（不是 0）：${JSON.stringify(main)}`);
  assert.match(String(main.message), /Parse Error/i, `消息里必须有解析错误：${JSON.stringify(main)}`);
  // base.gd 的 `func broken( -> void:` 在第 3 行
  assert.equal(main.line, 3, `行号应当是 3：${JSON.stringify(main)}`);
  // 被连累的依赖文件不得被标成「检查没跑完」
  assert.equal((data.errors ?? []).some(entry => entry.check_failed === true), false,
    `任何条目都不该是 check_failed：${JSON.stringify(data.errors)}`);
});

test('check_verdict 判定表：负例（exit137+ParseError / exit1 无定位 / timeout / orphan / 杀树失败）必须判为不可信', { skip: NO_ENGINE && !REQUIRE_GODOT ? NO_ENGINE : false }, async t => {
  if (NO_ENGINE) assert.fail(NO_ENGINE);
  const { execFileSync } = await import('node:child_process');
  // 注意：不能直接用 new URL(...).pathname —— 本仓库路径含中文，会被百分号编码，
  // execFileSync 会找不到脚本。必须用 fileURLToPath 解码。
  const verdictScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'godot', 'check_verdict.gd');
  const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gmcp-verdict-'));
  t.after(() => fsp.rm(workdir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(workdir, 'project.godot'), 'config_version=5\n', 'utf8');

  // 判定逻辑是**生产同一份文件**（ops.gd 也 load 它），这里直接跑它的判定表：
  // 全部符合期望 → 退出 0；任一条不符 → 退出 1 并把失败项打进 marker。
  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync(ENGINE, ['--headless', '--path', workdir, '--script', verdictScript], { encoding: 'utf8', timeout: 120_000 });
  } catch (error) {
    exitCode = error?.status ?? 1;
    output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`;
  }
  const marker = output.split('\n').find(line => line.includes('@@CHECK_VERDICT@@'));
  assert.ok(marker, `必须输出判定表结果：${output.slice(-600)}`);
  const report = JSON.parse(marker.slice(marker.indexOf('@@CHECK_VERDICT@@') + '@@CHECK_VERDICT@@'.length));
  t.diagnostic(`check_verdict: ${JSON.stringify(report)}`);
  assert.equal(exitCode, 0, `判定表必须全部通过，实际退出码 ${exitCode}：${JSON.stringify(report.failures)}`);
  assert.equal(report.ok, true, `负例必须被判为不可信：${JSON.stringify(report.failures)}`);
  assert.ok(report.total >= 10, `判定表要覆盖足够多的分支：${report.total}`);
});
