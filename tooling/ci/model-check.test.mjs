/**
 * model-check.mjs on the repo's own tree and on planted trees: every model is found, the two that were never wired
 * (ReceivedHold, RewardPay) included; a change to a modelled service, to a path a COVERS.md names, or to the check
 * itself runs every model; any other change runs none; a model no check.sh would run fails the plan by name. The last
 * test reads the workflow: every pull request gets the plan, and each model's run must show a broken version failing.
 * Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SELF, findModels, plan } from './model-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'tooling', 'ci', 'model-check.mjs');

/** A scratch git repository holding `files` ({ path: text }); a path ending in check.sh is made executable. */
function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'model-check-'));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
    if (p.endsWith('check.sh')) chmodSync(join(dir, p), 0o755);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

test("the repo's own tree: every model is found, none unwired", () => {
  const { models, errors } = findModels(ROOT);
  assert.deepEqual(errors, []);
  assert.deepEqual(models.map((m) => `${m.dir}:${m.name}`).sort(), [
    'services/svc-bank/model:CashOutLock+ReceivedHold',
    'services/svc-campaigns/model:RewardPay',
    'services/svc-trade/model:OneHold',
  ]);
});

test('a change to a modelled service runs every model', () => {
  for (const path of [
    'services/svc-bank/src/holds/received-holds.ts',
    'services/svc-campaigns/src/reward-payer.ts',
    'services/svc-trade/src/index.ts',
  ]) {
    const p = plan(ROOT, [path]);
    assert.equal(p.run, true, path);
    assert.equal(p.models.length, 3, path);
  }
});

test("a path outside the service that a model's COVERS.md names runs the models; its neighbours do not", () => {
  assert.equal(plan(ROOT, ['services/svc-matching/src/engine/book.ts']).run, true);
  assert.equal(plan(ROOT, ['services/svc-matching/README.md']).run, false);
});

test('the check itself runs the models', () => {
  for (const path of SELF) assert.equal(plan(ROOT, [path]).run, true, path);
});

test('a change that touches no modelled service runs none', () => {
  const p = plan(ROOT, ['apps/customer/src/main.tsx', 'docs/ARCHITECTURE.md', 'services/svc-identity/src/index.ts']);
  assert.equal(p.run, false);
  assert.deepEqual(p.reasons, []);
  assert.equal(plan(ROOT, []).run, false);
  assert.equal(plan(ROOT, [], { all: true }).run, true);
});

test('a new model in a new service is wired the day it lands', () => {
  const dir = scratch({ 'services/svc-new/model/New.tla': '', 'services/svc-new/model/check.sh': '', 'services/svc-new/src/a.ts': '' });
  try {
    const p = plan(dir, ['services/svc-new/src/a.ts']);
    assert.deepEqual(p.errors, []);
    assert.equal(p.run, true);
    assert.deepEqual(p.models, [
      { name: 'New', service: 'services/svc-new', dir: 'services/svc-new/model', check: 'services/svc-new/model/check.sh' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planted: a model no check.sh would run fails the plan by name', () => {
  const cases = {
    'outside a model folder': [
      { 'services/svc-a/src/A.tla': '', 'services/svc-a/model/check.sh': '' },
      /services\/svc-a\/src\/A\.tla is a model outside/,
    ],
    'no check.sh': [{ 'services/svc-a/model/A.tla': '' }, /services\/svc-a\/model\/A\.tla has no services\/svc-a\/model\/check\.sh/],
    'check.sh not executable': [{ 'services/svc-a/model/A.tla': '' }, /check\.sh is not executable/],
  };
  for (const [name, [files, error]] of Object.entries(cases)) {
    const dir = scratch(files);
    try {
      if (name === 'check.sh not executable') {
        writeFileSync(join(dir, 'services/svc-a/model/check.sh'), '');
        execFileSync('git', ['add', '-A'], { cwd: dir });
      }
      const p = plan(dir, ['services/svc-a/model/A.tla']);
      assert.equal(p.run, false, name);
      assert.match(p.errors.join('\n'), error, name);
      const cli = spawnSync('node', [SCRIPT, 'plan', '--all'], { cwd: dir, encoding: 'utf8' });
      assert.equal(cli.status, 1, `${name}: ${cli.stdout}${cli.stderr}`);
      assert.match(cli.stdout, /::error::/, name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the command line writes the matrix for the workflow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-check-out-'));
  try {
    const out = join(dir, 'out');
    writeFileSync(out, '');
    const r = spawnSync('node', [SCRIPT, 'plan'], {
      cwd: ROOT,
      input: 'services/svc-bank/src/bank-service.ts\n',
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = Object.fromEntries(
      readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    assert.equal(lines.run, 'true');
    assert.equal(JSON.parse(lines.models).length, 3);
    const none = spawnSync('node', [SCRIPT, 'plan'], {
      cwd: ROOT,
      input: 'docs/ARCHITECTURE.md\n',
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out },
    });
    assert.equal(none.status, 0, none.stdout + none.stderr);
    assert.match(readFileSync(out, 'utf8'), /\nrun=false\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the workflow plans every pull request and needs a broken version failing in each model run', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/model-check.yml'), 'utf8');
  const on = yml.slice(yml.indexOf('\non:\n'), yml.indexOf('\npermissions:'));
  assert.match(on, /\n {2}pull_request:\n {2}push:/, 'pull_request has no path filter: the plan decides');
  for (const p of ['services/**', ...SELF]) assert.ok(on.includes(`- ${p}\n`), `push to main watches ${p}`);
  assert.match(yml, /node tooling\/ci\/model-check\.mjs plan/);
  assert.match(yml, /matrix:\n\s+model: \$\{\{ fromJSON\(needs\.plan\.outputs\.models\) \}\}/);
  assert.match(yml, /violated as it should be/);
  assert.match(yml, /\n {4}name: Model check\n {4}needs: \[plan, model\]\n {4}if: always\(\)/);
});
