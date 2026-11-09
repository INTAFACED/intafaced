/**
 * The planted check for fail-fast-retries.mjs: real Playwright runs fixture journeys with one retry, as on main, and
 * the report shows that a test that fails fast runs once (its red unchanged), that a pass on its first attempt still
 * counts as a pass, and that every other test keeps its retry: an ordinary test, a test of an unbuilt step that passed
 * in a run read, and a test in a serial file. With the fail-fast plan off, every failed test is retried.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = path.join(ROOT, 'tooling/scripts/fixtures/fail-fast-retries/fixture.playwright.config.mjs');
const CLI = createRequire(path.join(ROOT, 'package.json')).resolve('@playwright/test/cli');
const PLAN = JSON.stringify({
  steps: ['J-fx-01#2', 'J-fx-01#3', 'J-fx-01#4', 'J-fx-02#1'],
  passed: ['J-fx-01 #4 a test of an unbuilt step that passed in a run read'],
});

/** Each test's [status, attempts] by title, from a run of the fixture journeys under `env`. */
function run(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-fast-retries-'));
  try {
    const report = path.join(dir, 'report.json');
    const r = spawnSync(process.execPath, [CLI, 'test', '--config', CONFIG], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CI: '', FIXTURE_REPORT: report, FIXTURE_OUT: path.join(dir, 'out'), ...env },
      timeout: 120_000,
    });
    assert.ok(fs.existsSync(report), `no report; playwright said:\n${r.stdout}\n${r.stderr}`);
    const out = {};
    const walk = (s) => {
      for (const spec of s.specs ?? []) for (const t of spec.tests) out[spec.title] = [t.status, t.results.length];
      for (const c of s.suites ?? []) walk(c);
    };
    for (const s of JSON.parse(fs.readFileSync(report, 'utf8')).suites) walk(s);
    return { out, stdout: r.stdout };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a test that fails fast runs once; a first-attempt pass counts; every other test keeps its retry', () => {
  const { out, stdout } = run({ JOURNEY_FAIL_FAST: '1', JOURNEY_FAIL_FAST_PLAN: PLAN });
  assert.deepEqual(out, {
    'J-fx-01 #1 an ordinary test that fails': ['unexpected', 2],
    'J-fx-01 #2 fails fast and fails': ['unexpected', 1],
    'J-fx-01 #3 fails fast and passes on its first attempt': ['expected', 1],
    'J-fx-01 #4 a test of an unbuilt step that passed in a run read': ['unexpected', 2],
    'J-fx-02 #1 fails fast in a serial file': ['unexpected', 2],
  });
  assert.match(stdout, /fail fast: 2 test\(s\) of steps the plan expects to fail run once/);
});

test('with the plan off, every failed test is retried', () => {
  const { out } = run({ JOURNEY_FAIL_FAST: '0', JOURNEY_FAIL_FAST_PLAN: PLAN });
  assert.deepEqual(out['J-fx-01 #2 fails fast and fails'], ['unexpected', 2]);
  assert.deepEqual(out['J-fx-01 #3 fails fast and passes on its first attempt'], ['expected', 1]);
});
