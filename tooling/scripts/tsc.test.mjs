// The one type-check command (tsc.mjs): incremental, seeded from this machine's last passing check, one at a time per
// project in a worktree; and every package's typecheck goes through it (INTAFACED/project-state#3374).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { installShims, planOf } from './tsc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const WRAPPER = join(HERE, 'tsc.mjs');
const temps = [];
after(() => temps.forEach((t) => rmSync(t, { recursive: true, force: true })));

/** A git repo holding one small project at pkg/, committed. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'tsc-wrapper-'));
  temps.push(root);
  mkdirSync(join(root, 'pkg', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'pkg', 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'nodenext' }, include: ['src'] }),
  );
  writeFileSync(join(root, 'pkg', 'src', 'a.ts'), 'export const a: number = 1;\n');
  writeFileSync(join(root, 'pkg', 'src', 'b.ts'), "import { a } from './a.js';\nexport const b: number = a + 1;\n");
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'pkg');
  return root;
}

const check = (cwd) => spawnSync(process.execPath, [WRAPPER, '-p', 'tsconfig.json', '--noEmit'], { cwd, encoding: 'utf8' });
const startCheck = (cwd) => {
  const child = spawn(process.execPath, [WRAPPER, '-p', 'tsconfig.json', '--noEmit'], { cwd });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((r) => child.on('close', (code) => r({ code, err })));
  return { child, done, err: () => err };
};
const buildInfo = (pkg) => join(pkg, 'node_modules', '.cache', 'tsc', 'tsconfig.tsbuildinfo');

test('a --noEmit check of one project is made incremental; anything else runs tsc as given', () => {
  const root = repo();
  const pkg = join(root, 'pkg');
  const plan = planOf(['-p', 'tsconfig.json', '--noEmit'], pkg);
  assert.deepEqual(plan.args, ['-p', 'tsconfig.json', '--noEmit', '--incremental', '--tsBuildInfoFile', buildInfo(pkg)]);
  assert.equal(planOf(['--noEmit'], pkg).buildInfo, buildInfo(pkg), 'no -p: the cwd tsconfig.json');
  assert.equal(planOf(['--noEmit', '-p', 'pkg'], root).buildInfo, buildInfo(pkg), 'a directory -p: its tsconfig.json');
  for (const args of [
    ['-p', 'tsconfig.json'],
    ['-b'],
    ['--noEmit', '--watch'],
    ['--noEmit', '--incremental'],
    ['--noEmit', 'src/a.ts'],
    ['--version'],
  ])
    assert.equal(planOf(args, pkg).buildInfo, undefined, args.join(' '));
});

test('a seeded new worktree checks from the last passing check, and a planted type error still fails, twice', () => {
  const root = repo();
  const first = check(join(root, 'pkg'));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(existsSync(buildInfo(join(root, 'pkg'))), 'the check wrote its build-info');
  const seeds = readdirSync(join(root, '.git', 'intafaced-tsc-seed'));
  assert.deepEqual(seeds, ['pkg%tsconfig.json.tsbuildinfo'], 'and published it as the seed');

  const wt = join(root, '..', `${root.split('/').pop()}-wt`);
  temps.push(wt);
  assert.equal(spawnSync('git', ['worktree', 'add', '-q', wt], { cwd: root }).status, 0);
  const seeded = check(join(wt, 'pkg'));
  assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
  assert.match(seeded.stderr, /started from the last passing check/);

  writeFileSync(join(wt, 'pkg', 'src', 'a.ts'), "export const a: number = 'one';\n");
  for (const round of [1, 2]) {
    const bad = check(join(wt, 'pkg'));
    assert.notEqual(bad.status, 0, `round ${round}: the planted error fails`);
    assert.match(bad.stdout, /src\/a\.ts\(1,14\): error TS2322/, `round ${round}`);
  }
  // A type that moves under an unchanged importer is caught there too.
  writeFileSync(join(wt, 'pkg', 'src', 'a.ts'), "export const a: string = 'one';\n");
  const moved = check(join(wt, 'pkg'));
  assert.notEqual(moved.status, 0);
  assert.match(moved.stdout, /src\/b\.ts\(2,14\): error TS2322/);
});

test('a second check of the same project waits while the first holds it, and a dead holder is taken over', async () => {
  const root = repo();
  const pkg = join(root, 'pkg');
  const lockDir = `${buildInfo(pkg)}.lock`;
  mkdirSync(lockDir, { recursive: true });
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  writeFileSync(join(lockDir, 'pid'), `${holder.pid}\n`);
  const waiting = startCheck(pkg);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(waiting.child.exitCode, null, 'still waiting while the holder lives');
  assert.match(waiting.err(), new RegExp(`already running in this worktree \\(pid ${holder.pid}\\)`));
  assert.ok(!existsSync(buildInfo(pkg)), 'no compiler ran meanwhile');
  holder.kill();
  const { code } = await waiting.done;
  assert.equal(code, 0, 'the holder gone, its lock is taken over and the check runs');
  assert.ok(!existsSync(lockDir), 'and released');

  const [a, b] = [startCheck(pkg), startCheck(pkg)];
  const both = await Promise.all([a.done, b.done]);
  assert.deepEqual(
    both.map((r) => r.code),
    [0, 0],
  );
});

/** A typecheck script that runs tsc itself rather than the one command; the message names the fix. */
export function bareTsc(script) {
  return /(^|[\s&|;(])(npx |pnpm exec )?tsc(\s|$)/.test(script) && !script.includes('tooling/scripts/tsc.mjs');
}

test("every package's typecheck runs tsc only through tooling/scripts/tsc.mjs", () => {
  assert.ok(bareTsc('tsc -p tsconfig.json --noEmit && node ../../tooling/ci/test-typecheck.mjs'), "the 527 runs' shape is caught");
  assert.ok(bareTsc('node ./scripts/ensure-dep-types.mjs && tsc -p tsconfig.json --noEmit'));
  assert.ok(!bareTsc('node ../../tooling/scripts/tsc.mjs -p tsconfig.json --noEmit && node ../../tooling/ci/test-typecheck.mjs'));
  const offenders = [];
  for (const area of ['apps', 'packages', 'services', 'tooling']) {
    for (const name of readdirSync(join(REPO, area))) {
      const file = join(REPO, area, name, 'package.json');
      if (!existsSync(file)) continue;
      const script = JSON.parse(readFileSync(file, 'utf8')).scripts?.typecheck ?? '';
      if (bareTsc(script)) offenders.push(`${area}/${name}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these typecheck scripts call tsc directly: write `node ../../tooling/scripts/tsc.mjs -p tsconfig.json --noEmit` instead (incremental, one at a time)',
  );
});

test('the setup points every node_modules/.bin/tsc at the one command, so a hand-typed npx tsc takes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'tsc-shims-'));
  temps.push(root);
  for (const at of ['node_modules/.bin', 'apps/x/node_modules/.bin', 'services/y/node_modules/.bin']) {
    mkdirSync(join(root, at), { recursive: true });
    writeFileSync(join(root, at, 'tsc'), '#!/bin/sh\nexec node typescript/bin/tsc "$@"\n');
  }
  mkdirSync(join(root, 'packages', 'z'), { recursive: true });
  assert.equal(installShims(root), 3);
  const shim = readFileSync(join(root, 'apps/x/node_modules/.bin/tsc'), 'utf8');
  assert.ok(shim.includes(`exec node "${WRAPPER}" "$@"`), shim);
  const version = spawnSync('sh', [join(root, 'apps/x/node_modules/.bin/tsc'), '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /Version 7\./);
});
