// tooling/scripts/pre-push-changed.mjs: which of CI's checks a push's changed files call for, the command each runs and
// the fix it names; which render parts a change most likely redraws; and, on a planted repo holding the real hook and the
// real script, that a red check refuses the push with its fix and a green one lets it through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatExtensions,
  partOfFile,
  pickRecordings,
  piecesOfRecording,
  piecesOfSource,
  plan,
  registriesOf,
  renderPattern,
} from './pre-push-changed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const EXTS = formatExtensions(readJson('package.json').scripts['format:check']);
const REGISTRIES = registriesOf(
  ['contracts', 'exchange-contract', 'ledger-client', 'ui'].map((d) => ({
    dir: `packages/${d}`,
    json: readJson(`packages/${d}/package.json`),
  })),
);
const all = () => true;
const ids = (changed, has = all) => plan({ changed, present: changed, formatExts: EXTS, registries: REGISTRIES, has }).map((c) => c.id);

test("format checks the extensions CI's Format job checks, on the pushed files only", () => {
  assert.ok(EXTS.includes('ts') && EXTS.includes('md') && EXTS.includes('yml'), EXTS.join(','));
  const [format] = plan({ changed: ['a.md', 'b.png'], present: ['a.md', 'b.png'], formatExts: EXTS, registries: [], has: all });
  assert.deepEqual(format.cmd, ['node_modules/.bin/prettier', '--check', 'a.md']);
  assert.equal(format.fix, 'pnpm exec prettier --write a.md');
  // A deleted file is not formatted.
  assert.deepEqual(plan({ changed: ['gone.md'], present: [], formatExts: EXTS, registries: [], has: all }), []);
});

test('each procedure registry is checked when its package source changes, with the write command its package runs', () => {
  assert.deepEqual(
    REGISTRIES.map((r) => r.name),
    ['@intafaced/contracts', '@intafaced/exchange-contract', '@intafaced/ledger-client'],
  );
  const [check] = plan({
    changed: ['packages/contracts/src/tax-procedures.ts'],
    present: [],
    formatExts: [],
    registries: REGISTRIES,
    has: all,
  }).filter((c) => c.id.startsWith('procedure registry'));
  assert.deepEqual(check.cmd, ['node', 'scripts/procedure-registry.mjs', '.', 'CONTRACT_PROCEDURES', './procedure.js', '--check']);
  assert.equal(check.cwd, 'packages/contracts');
  assert.equal(check.fix, 'pnpm --filter @intafaced/contracts procedures:write');
  assert.ok(!ids(['tooling/ci/x.yml']).some((id) => id.startsWith('procedure registry')));
});

test("the registry check is CI's own: it passes on this checkout and fails a planted stale registry", () => {
  const r = REGISTRIES[0];
  const ok = spawnSync('node', [r.script, ...r.args, '--check'], { cwd: join(ROOT, r.dir), encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const A_CALL = defineProcedure({});\n');
    writeFileSync(join(dir, 'src', 'procedure-registry.ts'), '// stale\n');
    const stale = spawnSync('node', [join(ROOT, r.dir, r.script), dir, 'CONTRACT_PROCEDURES', './procedure.js', '--check'], {
      cwd: join(ROOT, r.dir),
      encoding: 'utf8',
    });
    assert.equal(stale.status, 1, stale.stdout + stale.stderr);
    assert.match(stale.stderr, /stale: run `procedures:write`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the test checks run only on the changes they read, and none without the install', () => {
  assert.deepEqual(ids(['apps/customer/src/screens/pay/index.tsx']), [
    'format',
    'dead-code',
    'volt count',
    'recorded calls',
    'ui tokens',
    'render record',
  ]);
  assert.deepEqual(ids(['services/svc-quant/src/routes/health.ts']), ['format', 'dead-code', 'ops-desk catalog']);
  assert.deepEqual(ids(['services/svc-quant/src/engine.ts']), ['format', 'dead-code']);
  assert.deepEqual(ids(['crates/svc-ledger/src/lib.rs']), []);
  // A journey test reaches none of the Customer app's test checks; the routes file its render sweep reads does.
  assert.deepEqual(ids(['apps/customer/tests/real-app/J-pay-01.pw.mjs']), ['format', 'dead-code']);
  assert.deepEqual(ids(['apps/customer/tests/real-app/routes.mjs']), ['format', 'dead-code', 'render record']);
  assert.deepEqual(ids(['apps/customer/render-record/root.html']), ['volt count', 'recorded calls', 'render record']);
  assert.deepEqual(
    ids(['apps/customer/src/screens/pay/index.tsx'], (f) => !f.startsWith('node_modules/')),
    [],
  );
});

test('every refusal names its fix command', () => {
  const checks = plan({
    changed: ['apps/customer/src/a.tsx', 'packages/contracts/src/b.ts', 'apps/admin/src/lib/c.ts'],
    present: ['apps/customer/src/a.tsx'],
    formatExts: EXTS,
    registries: REGISTRIES,
    has: all,
  });
  for (const c of checks) assert.match(c.fix, /pnpm |node /, c.id);
  assert.match(checks.find((c) => c.id === 'render record').fix, /^pnpm --filter @intafaced\/customer render:record/);
});

test('a recording names its part as render.compare names it', () => {
  assert.equal(partOfFile('root.html'), '/');
  assert.equal(partOfFile('trade__spot__BTC-USDT.html'), '/trade/spot/BTC-USDT');
  assert.equal(partOfFile('bank__transfers--standing-order-revision-0.html'), '/bank/transfers#standing-order-revision-0');
  assert.equal(partOfFile('bank--network-down.html'), '/bank#network-down');
  const re = new RegExp(renderPattern(['/pay', '/bank#network-down']));
  assert.match('the Customer app renders what main recorded, part by part /pay', re);
  assert.match('the Customer app renders what main recorded, part by part /bank#network-down', re);
  assert.doesNotMatch('the Customer app renders what main recorded, part by part /pay/bills', re);
  assert.match('the Customer app renders what main recorded, part by part records no part that no longer exists', re);
});

test('the parts picked are those that show what the change touches, rarer pieces first, never the shell alone', () => {
  const shell = '<div class="if-app"><header class="tb">Home</header>';
  const recordings = new Map(
    [
      ['pay.html', `${shell}<h1 class="pay-head">Send money</h1></div>`],
      ['trade__orders.html', `${shell}<table data-testid="order-table"><td>Open orders</td></table></div>`],
      ['uc__entrust__current.html', `${shell}<table data-testid="order-table"><td>Current entrusts</td></table></div>`],
      ['bank.html', `${shell}<p>Bank</p></div>`],
    ].map(([f, html]) => [f, piecesOfRecording(html.replace(/></g, '>\n<'))]),
  );
  const source = piecesOfSource(`export const T = () => <table data-testid="order-table"><td>Open orders</td></table>;`);
  const picked = pickRecordings({ recordings, changedPieces: source, filePieces: new Set() });
  assert.deepEqual(picked, ['trade__orders.html', 'uc__entrust__current.html']);
  assert.deepEqual(pickRecordings({ recordings, changedPieces: piecesOfSource(`className="if-app"`), filePieces: new Set() }), []);
  assert.equal(pickRecordings({ recordings, changedPieces: source, filePieces: new Set() }, 1).length, 1);
});

// The real hook and the real script on a planted repo, pushing to a local bare remote; prettier planted.
const BUILDER = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CI', 'GITHUB_ACTIONS', 'NODE_TEST_CONTEXT'].includes(k)));
function plant(prettier) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-changed-'));
  const work = join(dir, 'work');
  const git = (...a) => execFileSync('git', a, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '-q', '--bare', join(dir, 'remote.git')]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  for (const f of ['.githooks/pre-push', 'tooling/scripts/pre-push-changed.mjs']) {
    mkdirSync(dirname(join(work, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(work, f));
  }
  chmodSync(join(work, '.githooks/pre-push'), 0o755);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ scripts: { 'format:check': 'prettier --check "**/*.{ts,md}"' } }));
  writeFileSync(join(work, '.gitignore'), 'node_modules\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('remote', 'add', 'origin', join(dir, 'remote.git'));
  git('push', '-q', 'origin', 'main');
  git('fetch', '-q', 'origin');
  git('config', 'core.hooksPath', '.githooks');
  mkdirSync(join(work, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(work, 'node_modules', '.bin', 'prettier'), `#!/bin/sh\n${prettier}\n`);
  chmodSync(join(work, 'node_modules', '.bin', 'prettier'), 0o755);
  git('checkout', '-q', '-b', 'feat');
  writeFileSync(join(work, 'notes.md'), '# notes\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const push = () => {
    const r = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/feat'], { cwd: work, encoding: 'utf8', env: BUILDER });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { push, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('an unformatted pushed file refuses the push, named, with the command that formats it; a formatted one goes through', () => {
  const red = plant('echo "[warn] $2"; exit 1');
  try {
    const r = red.push();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[warn\] notes\.md/);
    assert.match(r.out, /Fix: pnpm exec prettier --write notes\.md/);
    assert.match(r.out, /- format\n/);
  } finally {
    red.done();
  }
  const green = plant('exit 0');
  try {
    const r = green.push();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /changed-file checks: format pass/);
  } finally {
    green.done();
  }
});
