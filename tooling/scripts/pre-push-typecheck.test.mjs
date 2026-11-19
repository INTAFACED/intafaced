// The pre-push typecheck (pre-push-typecheck.mjs) on planted repos: a push with no TypeScript change pays under 2 seconds
// and runs nothing; a planted slow typecheck prints TIMEOUT, is stopped, and the push goes; a type error refuses with the
// compiler's line. Each repo holds the real script, a planted ci-affected.mjs and a planted `pnpm` first on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { touchesTypes } from './pre-push-typecheck.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function plant({ change, pnpm }) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-typecheck-'));
  const work = join(dir, 'work');
  const bin = join(dir, 'bin');
  const write = (f, body, mode) => {
    mkdirSync(dirname(join(work, f)), { recursive: true });
    writeFileSync(join(work, f), body);
    if (mode) chmodSync(join(work, f), mode);
  };
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 't@example.invalid');
  git(work, 'config', 'user.name', 't');
  mkdirSync(join(work, 'tooling', 'scripts'), { recursive: true });
  copyFileSync(join(ROOT, 'tooling', 'scripts', 'pre-push-typecheck.mjs'), join(work, 'tooling', 'scripts', 'pre-push-typecheck.mjs'));
  write(
    'tooling/ci/ci-affected.mjs',
    'export const readEdges = () => ({});\nexport const affectedFilters = (_f, _e, base) => [`...[${base}]`];\n',
  );
  write('.gitignore', 'node_modules\n');
  write('README.md', 'base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  write('node_modules/.bin/turbo', '#!/bin/sh\n', 0o755);
  for (const [f, body] of Object.entries(change)) write(f, body);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'change');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\necho "pnpm $*" > '${join(dir, 'ran')}'\n${pnpm}\n`);
  chmodSync(join(bin, 'pnpm'), 0o755);
  const run = (...args) => {
    const t = Date.now();
    const r = spawnSync('node', ['tooling/scripts/pre-push-typecheck.mjs', ...args], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t };
  };
  return { run, ran: () => existsSync(join(dir, 'ran')), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('what counts as a TypeScript change', () => {
  assert.equal(touchesTypes(['README.md', 'docs/x.md', 'apps/customer/tests/real-app/J-x.pw.mjs', 'src/a.ts']), false);
  assert.equal(touchesTypes(['services/svc-trade/src/venue/venue-adl-acks.sql.test.ts']), true);
  assert.equal(touchesTypes(['apps/customer/src/App.tsx']), true);
  assert.equal(touchesTypes(['packages/ui/tsconfig.json']), true);
  assert.equal(touchesTypes(['services/svc-bank/package.json']), true);
  assert.equal(touchesTypes(['tsconfig.base.json']), true);
});

test('a push that touches no TypeScript package pays under 2 seconds and runs no typecheck', () => {
  const p = plant({ change: { 'README.md': 'changed\n', 'apps/customer/tests/real-app/J-x.pw.mjs': '// step\n' }, pnpm: 'exit 1' });
  try {
    const r = p.run();
    assert.equal(r.code, 0, r.out);
    assert.ok(r.ms < 2000, `took ${r.ms} ms`);
    assert.equal(p.ran(), false);
  } finally {
    p.done();
  }
});

test('a planted slow typecheck prints TIMEOUT, is stopped at the limit, and the push goes', () => {
  const p = plant({ change: { 'services/svc-x/src/a.ts': 'export const a = 1;\n' }, pnpm: 'sleep 30' });
  try {
    const r = p.run('--limit', '1');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /TIMEOUT after 1s/);
    assert.ok(r.ms < 10000, `took ${r.ms} ms: the slow typecheck was not stopped`);
    assert.equal(p.ran(), true);
  } finally {
    p.done();
  }
});

test("a type error refuses the push with the compiler's line, over CI's own selection (#8814's first head, TS2339)", () => {
  const p = plant({
    change: { 'services/svc-trade/src/venue/venue-adl-acks.sql.test.ts': 'export {};\n' },
    pnpm: `echo "src/venue/venue-adl-acks.sql.test.ts | TS2339 | Property 'n' does not exist"; exit 2`,
  });
  try {
    const r = p.run();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /TS2339 \| Property 'n' does not exist/);
    assert.match(r.out, /typecheck failed .* push refused/);
    assert.match(r.out, /reaches \(\.\.\.\[[0-9a-f]{40}\]\)/);
  } finally {
    p.done();
  }
});
