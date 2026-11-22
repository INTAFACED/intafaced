// The pre-push wire replay (pre-push-wire-replay.mjs) on planted repos: a push that changes no service with a replay pays
// under 2 seconds and runs nothing; a replay that answers other than its recording refuses the push and names the command
// that rewrites it (#9519's 43ca732ccc: GET /api/v1/venue/margin-rules served, not recorded); a planted slow replay prints
// TIMEOUT, is stopped, and the push goes; a builder's WIRE_REPLAY_WRITE never reaches the replay. Each repo holds the real
// script and a planted `pnpm` first on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaysFor, rewriteCommand } from './pre-push-wire-replay.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function plant({ change, pnpm }) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-wire-replay-'));
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
  copyFileSync(join(ROOT, 'tooling', 'scripts', 'pre-push-wire-replay.mjs'), join(work, 'tooling', 'scripts', 'pre-push-wire-replay.mjs'));
  write('.gitignore', 'node_modules\n');
  write('services/svc-trade/package.json', '{ "name": "@intafaced/svc-trade" }\n');
  write('services/svc-trade/src/wire-replay.test.ts', '// the replay\n');
  write('services/svc-plain/src/a.ts', 'export const a = 1;\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  write('node_modules/.bin/turbo', '#!/bin/sh\n', 0o755);
  for (const [f, body] of Object.entries(change)) write(f, body);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'change');
  mkdirSync(bin);
  // Each call is logged with the WIRE_REPLAY_WRITE it saw; `pnpm` answers `body` for the replay, 0 for the build.
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/bin/sh\necho "pnpm $* write=${'$'}{WIRE_REPLAY_WRITE:-unset}" >> '${join(dir, 'ran')}'\ncase "$1" in turbo) exit 0 ;; esac\n${pnpm}\n`,
  );
  chmodSync(join(bin, 'pnpm'), 0o755);
  const run = (args = [], extra = {}) => {
    const t = Date.now();
    const r = spawnSync('node', ['tooling/scripts/pre-push-wire-replay.mjs', ...args], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, ...extra, PATH: `${bin}:${process.env.PATH}` },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t };
  };
  return {
    run,
    ran: () => (existsSync(join(dir, 'ran')) ? readFileSync(join(dir, 'ran'), 'utf8') : ''),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('which services a push replays: a changed service that keeps a replay, once each', () => {
  const has = (s) => s === 'svc-trade' || s === 'svc-bank';
  assert.deepEqual(
    replaysFor(
      [
        'services/svc-trade/src/venue/user-venue-rest.ts',
        'services/svc-trade/README.md',
        'services/svc-plain/src/a.ts',
        'services/svc-bank/src/x.ts',
      ],
      has,
    ),
    ['svc-bank', 'svc-trade'],
  );
  assert.deepEqual(replaysFor(['packages/contracts/src/a.ts', 'apps/customer/src/App.tsx', 'services/README.md'], has), []);
  // Every service that keeps a replay today is found by the default check.
  assert.ok(replaysFor(['services/svc-trade/src/index.ts']).includes('svc-trade'));
  assert.equal(
    rewriteCommand('@intafaced/svc-trade'),
    'WIRE_REPLAY_WRITE=1 pnpm --filter @intafaced/svc-trade exec vitest run src/wire-replay.test.ts',
  );
});

test('a push that changes no service with a replay pays under 2 seconds and runs nothing', () => {
  const p = plant({ change: { 'services/svc-plain/src/a.ts': 'export const a = 2;\n', 'README.md': 'x\n' }, pnpm: 'exit 1' });
  try {
    const r = p.run();
    assert.equal(r.code, 0, r.out);
    assert.ok(r.ms < 2000, `took ${r.ms} ms`);
    assert.equal(p.ran(), '');
  } finally {
    p.done();
  }
});

test("a route the recording lacks refuses the push and names the rewrite (#9519's 43ca732ccc, replayed)", () => {
  const p = plant({
    change: { 'services/svc-trade/src/venue/user-venue-rest.ts': "app.get('/api/v1/venue/margin-rules', publicRead, read);\n" },
    pnpm: 'echo \'+   "GET /api/v1/venue/margin-rules absent anon",\'; exit 1',
  });
  try {
    const r = p.run([], { WIRE_REPLAY_WRITE: '1' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /GET \/api\/v1\/venue\/margin-rules absent anon/);
    assert.match(r.out, /@intafaced\/svc-trade's wire replay does not answer as recorded .* push refused/);
    assert.ok(r.out.includes(rewriteCommand('@intafaced/svc-trade')), r.out);
    const ran = p.ran();
    assert.match(ran, /pnpm turbo run build .*--filter=@intafaced\/svc-trade\^\.\.\./);
    assert.match(ran, /pnpm --filter @intafaced\/svc-trade exec vitest run src\/wire-replay\.test\.ts/);
    // The builder's WIRE_REPLAY_WRITE=1 never reaches the replay: the hook judges the recording, never rewrites it.
    assert.doesNotMatch(ran, /write=1/);
  } finally {
    p.done();
  }
});

test('a push that also changes a shared package runs no replay and builds nothing: CI judges it (#9599)', () => {
  const p = plant({
    change: { 'services/svc-trade/src/a.ts': 'export const a = 1;\n', 'packages/contracts/src/b.ts': 'export const b = 1;\n' },
    pnpm: 'exit 1',
  });
  try {
    const r = p.run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /changes a shared package.*left to CI/);
    assert.equal(p.ran(), '');
  } finally {
    p.done();
  }
});

test('a replay that answers as recorded lets the push go', () => {
  const p = plant({ change: { 'services/svc-trade/src/a.ts': 'export const a = 1;\n' }, pnpm: 'exit 0' });
  try {
    const r = p.run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /wire replay: passed/);
  } finally {
    p.done();
  }
});

test('a planted slow replay prints TIMEOUT, is stopped at the limit, and the push goes', () => {
  const p = plant({ change: { 'services/svc-trade/src/a.ts': 'export const a = 1;\n' }, pnpm: 'sleep 30' });
  try {
    const r = p.run(['--limit', '1']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /TIMEOUT after 1s/);
    assert.ok(r.ms < 10000, `took ${r.ms} ms: the slow replay was not stopped`);
  } finally {
    p.done();
  }
});
