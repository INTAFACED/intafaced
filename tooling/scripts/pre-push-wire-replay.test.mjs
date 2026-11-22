// The pre-push wire replay (pre-push-wire-replay.mjs) on planted repos: a push that changes no service with a recorded
// wire runs nothing; a replay that differs refuses the push and names the re-record command; a planted slow replay prints
// TIMEOUT, is stopped, and the push goes. Each repo holds the real script and a planted `pnpm` first on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayedServices, rerecord } from './pre-push-wire-replay.mjs';

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
  write('services/svc-bank/package.json', '{"name":"@intafaced/svc-bank"}\n');
  write('services/svc-bank/src/wire-replay.test.ts', '// recorded\n');
  write('services/svc-plain/package.json', '{"name":"@intafaced/svc-plain"}\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  write('node_modules/.bin/turbo', '#!/bin/sh\n', 0o755);
  for (const [f, body] of Object.entries(change)) write(f, body);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'change');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\necho "pnpm $*" >> '${join(dir, 'ran')}'\n${pnpm}\n`);
  chmodSync(join(bin, 'pnpm'), 0o755);
  const run = (args = []) => {
    const t = Date.now();
    const r = spawnSync('node', ['tooling/scripts/pre-push-wire-replay.mjs', ...args], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t };
  };
  return {
    run,
    ran: () => (existsSync(join(dir, 'ran')) ? readFileSync(join(dir, 'ran'), 'utf8') : ''),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("which services' replays a push runs: those whose own folder it changes and that record a wire", () => {
  const has = (svc) => svc === 'svc-bank' || svc === 'svc-pay';
  assert.deepEqual(replayedServices(['services/svc-pay/src/a.ts', 'services/svc-plain/src/a.ts', 'services/svc-bank/src/b.ts'], has), [
    'svc-bank',
    'svc-pay',
  ]);
  assert.deepEqual(replayedServices(['packages/contracts/src/a.ts', 'apps/customer/src/x.tsx', 'services/README.md'], has), []);
  assert.equal(rerecord('svc-bank'), '(cd services/svc-bank && WIRE_REPLAY_WRITE=1 npx vitest run src/wire-replay.test.ts)');
});

test('a push that changes no service with a recorded wire runs no replay', () => {
  const p = plant({ change: { 'services/svc-plain/src/a.ts': 'export const a = 1;\n', 'README.md': 'x\n' }, pnpm: 'exit 1' });
  try {
    const r = p.run();
    assert.equal(r.code, 0, r.out);
    assert.equal(p.ran(), '');
  } finally {
    p.done();
  }
});

// #9469's first push (b334bec5d6) changed what svc-bank's testPartner.spend answers and left its recording as it was: a
// red unit test after the push, the recording rewritten in a second one (f14d07cf8e).
test("a replay that differs refuses the push and names the command that re-records the service's wire (#9469 b334bec5d6)", () => {
  const p = plant({
    change: { 'services/svc-bank/src/test-partner.ts': 'export const feeKind = "spread";\n' },
    pnpm: 'case "$*" in *vitest*) echo "testPartner.spend sample customer: 200 != 200"; exit 1;; esac',
  });
  try {
    const r = p.run();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /testPartner\.spend sample customer/);
    assert.match(r.out, /wire replay failed .* push refused/);
    assert.ok(r.out.includes(rerecord('svc-bank')), r.out);
    assert.match(p.ran(), /pnpm turbo run build --filter=@intafaced\/svc-bank\^\.\.\. /);
    assert.match(p.ran(), /pnpm --filter @intafaced\/svc-bank exec vitest run src\/wire-replay\.test\.ts/);
  } finally {
    p.done();
  }
});

test('a matching replay lets the push through', () => {
  const p = plant({ change: { 'services/svc-bank/src/a.ts': 'export const a = 1;\n' }, pnpm: 'exit 0' });
  try {
    const r = p.run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /wire replay: matched/);
  } finally {
    p.done();
  }
});

test('a planted slow replay prints TIMEOUT, is stopped at the limit, and the push goes', () => {
  const p = plant({ change: { 'services/svc-bank/src/a.ts': 'export const a = 1;\n' }, pnpm: 'sleep 30' });
  try {
    const r = p.run(['--limit', '1']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /TIMEOUT after 1s/);
    assert.ok(r.ms < 10000, `took ${r.ms} ms: the slow replay was not stopped`);
  } finally {
    p.done();
  }
});
