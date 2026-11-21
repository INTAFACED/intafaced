// The one type-check command (tsc.mjs): incremental, seeded from this machine's last passing check, one at a time per
// project in a worktree; and every package's typecheck goes through it (INTAFACED/project-state#3374).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { rewrite } from '../codemod/tsc-entry/rewrite.mjs';
import { checkerOf, installShims, planOf } from './tsc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const WRAPPER = join(HERE, 'tsc.mjs');
// What the wrapper runs here: tsrs off CI where installed, tsc in CI. Every test below holds for both.
const TSRS = checkerOf() === 'tsrs' ? '.tsrs' : '';
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
  const said = (re) => new Promise((r) => child.stderr.on('data', () => re.test(err) && r()));
  return { child, done, err: () => err, said };
};
const buildInfo = (pkg) => join(pkg, 'node_modules', '.cache', 'tsc', `tsconfig${TSRS}.tsbuildinfo`);

test('a --noEmit check of one project is made incremental; anything else runs tsc as given', () => {
  const root = repo();
  const pkg = join(root, 'pkg');
  const at = (name) => join(pkg, 'node_modules', '.cache', 'tsc', name);
  const plan = planOf(['-p', 'tsconfig.json', '--noEmit'], pkg);
  assert.deepEqual(plan.args, ['-p', 'tsconfig.json', '--noEmit', '--incremental', '--tsBuildInfoFile', at('tsconfig.tsbuildinfo')]);
  assert.deepEqual(
    planOf(['--noEmit'], pkg, 'tsrs').args.slice(1),
    ['--declaration', 'false', '--declarationMap', 'false', '--incremental', '--tsBuildInfoFile', at('tsconfig.tsrs.tsbuildinfo')],
    'tsrs: no declaration errors, as tsc 7.0 under --noEmit; its own build-info',
  );
  assert.equal(planOf(['--noEmit'], pkg).buildInfo, at('tsconfig.tsbuildinfo'), 'no -p: the cwd tsconfig.json');
  assert.equal(planOf(['--noEmit', '-p', 'pkg'], root).buildInfo, at('tsconfig.tsbuildinfo'), 'a directory -p: its tsconfig.json');
  for (const args of [
    ['-p', 'tsconfig.json'],
    ['-b'],
    ['--noEmit', '--watch'],
    ['--noEmit', '--incremental'],
    ['--noEmit', 'src/a.ts'],
    ['--version'],
  ])
    assert.equal(planOf(args, pkg).buildInfo, undefined, args.join(' '));
  assert.deepEqual(
    planOf(['-p', 'tsconfig.json'], pkg, 'tsrs'),
    { args: ['-p', 'tsconfig.json'], checker: 'tsrs' },
    'a build: tsrs (#3609)',
  );
  for (const args of [['-b'], ['--watch'], ['src/a.ts'], ['--version']]) assert.equal(planOf(args, pkg, 'tsrs').checker, undefined);
});

test('a seeded new worktree checks from the last passing check, and a planted type error still fails, twice', () => {
  const root = repo();
  const first = check(join(root, 'pkg'));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(existsSync(buildInfo(join(root, 'pkg'))), 'the check wrote its build-info');
  const seeds = readdirSync(join(root, '.git', 'intafaced-tsc-seed'));
  assert.deepEqual(seeds, [`pkg%tsconfig.json${TSRS}.tsbuildinfo`], 'and published it as the seed');

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
  await waiting.said(/already running in this worktree/);
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

/**
 * A git repo holding pkg/ as apps/customer is on 20 Nov 2026 in small: a dependency whose declarations are built into
 * dist/, a file that declares globals and imports it (Chart.tsx), a file that re-exports it (trade-api.ts), and an
 * unchanged file that imports from that one (execution/fixtures.ts).
 */
function depRepo() {
  const root = repo();
  const pkg = join(root, 'pkg');
  rmSync(join(pkg, 'src'), { recursive: true });
  mkdirSync(join(pkg, 'src'));
  // isolatedModules as tsconfig.base.json sets it; without it TypeScript reaches the same skip only by thread timing.
  writeFileSync(
    join(pkg, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'nodenext', isolatedModules: true }, include: ['src'] }),
  );
  writeFileSync(
    join(pkg, 'src', 'global.ts'),
    "import type { Order } from 'dep';\ndeclare global {\n  var lastOrder: Order | undefined;\n}\nexport type Last = Order;\n",
  );
  writeFileSync(join(pkg, 'src', 'api.ts'), "export * from 'dep';\n");
  writeFileSync(join(pkg, 'src', 'use.ts'), "import type { Order } from './api.js';\nexport const o: Order = { id: 'x' };\n");
  writeFileSync(join(pkg, 'package.json'), '{"name":"pkg","type":"module"}');
  mkdirSync(join(pkg, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(
    join(pkg, 'node_modules', 'dep', 'package.json'),
    '{"name":"dep","type":"module","exports":{".":{"types":"./dist/index.d.ts"}}}',
  );
  return pkg;
}
const build = (pkg) => {
  mkdirSync(join(pkg, 'node_modules', 'dep', 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'node_modules', 'dep', 'dist', 'index.d.ts'), 'export interface Order {\n  id: string;\n}\n');
};
const unbuild = (pkg) => rmSync(join(pkg, 'node_modules', 'dep', 'dist'), { recursive: true, force: true });
/** The real compiler, no build-info: what every answer must equal. */
const real = (cwd) =>
  spawnSync(
    process.execPath,
    [join(REPO, 'node_modules', ...(TSRS ? ['tsrs', 'bin', 'tsrs'] : ['typescript', 'bin', 'tsc'])), '-p', 'tsconfig.json', '--noEmit'],
    {
      cwd,
      encoding: 'utf8',
    },
  );
const sameAsReal = (pkg, label) => {
  const [got, want] = [check(pkg), real(pkg)];
  assert.equal(got.stdout, want.stdout, `${label}: the same errors as the real compiler`);
  assert.equal(got.status, want.status, label);
  return got;
};

test('a check made before a dependency is built answers like the real compiler once it is built (20 Nov, #9253)', () => {
  const pkg = depRepo();
  const first = sameAsReal(pkg, 'dependency not built');
  assert.match(first.stdout, /src\/use\.ts\(1,15\): error TS2305/, 'the unchanged importer fails while the dependency is missing');
  build(pkg);
  const after = sameAsReal(pkg, 'dependency built');
  assert.equal(after.status, 0, after.stdout);
});

test('a dependency that goes away is seen in unchanged importers, and a plain edit is still one incremental check', () => {
  const pkg = depRepo();
  build(pkg);
  sameAsReal(pkg, 'built');
  unbuild(pkg);
  const gone = sameAsReal(pkg, 'dependency gone');
  assert.match(gone.stdout, /src\/use\.ts\(1,15\): error TS2305/, 'the importer that did not change is checked too');
  build(pkg);
  sameAsReal(pkg, 'built again');

  writeFileSync(join(pkg, 'src', 'use.ts'), "import type { Order } from './api.js';\nexport const o: Order = { id: 'y' };\n");
  const edit = sameAsReal(pkg, 'a one-file edit');
  assert.doesNotMatch(edit.stderr, /checking every file again/, 'an edit to an ordinary file checks once');
  writeFileSync(join(pkg, 'src', 'global.ts'), readFileSync(join(pkg, 'src', 'global.ts'), 'utf8') + 'const unused = 1;\n');
  const globalBody = sameAsReal(pkg, 'an edit inside the globals file that leaves its declarations alone');
  assert.doesNotMatch(globalBody.stderr, /checking every file again/);
});

test('an error stored by an earlier check is printed only when checking its file now finds it', () => {
  const pkg = depRepo();
  const read = () => JSON.parse(readFileSync(buildInfo(pkg), 'utf8'));
  const entryOf = (b, file) => b.semanticDiagnosticsPerFile.find((e) => Array.isArray(e) && b.fileNames[e[0] - 1].endsWith(file));
  sameAsReal(pkg, 'dependency not built');
  const stored = entryOf(read(), 'src/use.ts');
  assert.ok(stored, 'the failing check stored the error of src/use.ts');
  build(pkg);
  sameAsReal(pkg, 'built');
  // Whatever left a stale answer behind (here: written in by hand), it is never repeated.
  const passing = read();
  const id = passing.fileNames.findIndex((n) => n.endsWith('src/use.ts')) + 1;
  writeFileSync(buildInfo(pkg), JSON.stringify({ ...passing, semanticDiagnosticsPerFile: [[id, stored[1]]] }));
  const again = sameAsReal(pkg, 'a stale stored error');
  assert.equal(again.status, 0, again.stdout);
});

/** A script that runs tsc itself rather than the one command. */
export function bareTsc(script) {
  return /(^|[\s&|;(])(npx |pnpm exec )?tsc(\s|$)/.test(script);
}

/** A tool's line that spawns tsc itself (its binary, `npx tsc`), not a comment. */
export function spawnsTsc(line) {
  if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return false;
  return /typescript['/,\s]+bin['/,\s]+tsc|BIN\(['"]tsc['"]\)|\[\s*['"]tsc['"]|\b(npx|pnpm exec) tsc\b/.test(line);
}

test('every package.json script and every tool runs tsc only through tooling/scripts/tsc.mjs', () => {
  assert.ok(bareTsc('tsc -p tsconfig.json --noEmit && node ../../tooling/ci/test-typecheck.mjs'), "the 527 runs' shape is caught");
  assert.ok(bareTsc('tsc -p tsconfig.json'), 'a package build is caught (#3609)');
  assert.ok(bareTsc('tsc --noEmit && vite build'));
  assert.equal(rewrite('tsc --noEmit && vite build', 'apps/x'), 'node ../../tooling/scripts/tsc.mjs --noEmit && vite build');
  assert.ok(!bareTsc('node ../../tooling/scripts/tsc.mjs -p tsconfig.json --noEmit && node ../../tooling/ci/test-typecheck.mjs'));
  assert.ok(spawnsTsc("  const r = spawnSync('npx', ['tsc', '--noEmit', '-p', '.'], {"), "report.mjs's old spawn is caught");
  assert.ok(spawnsTsc("spawnSync(BIN('tsc'), ['-p', config])"));
  assert.ok(spawnsTsc("const c = [join(ROOT, 'node_modules/typescript/bin/tsc')];"));
  assert.ok(!spawnsTsc(' * a hand-typed `npx tsc` takes it too.'));
  assert.ok(!spawnsTsc("spawnSync(process.execPath, [join(ROOT, 'tooling', 'scripts', 'tsc.mjs'), '-p', config])"));
  const git = (...a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const offenders = [];
  for (const file of git('ls-files', '*package.json', 'package.json'))
    for (const [name, script] of Object.entries(JSON.parse(readFileSync(join(REPO, file), 'utf8')).scripts ?? {}))
      if (bareTsc(script)) offenders.push(`${file} ${name}`);
  for (const file of git('ls-files', '*.mjs', '*.cjs', '*.js', '*.ts', '*.sh', '.githooks/*')) {
    if (/(^|\/)node_modules\/|\.test\.|\.d\.ts$|^tooling\/scripts\/tsc\.mjs$/.test(file) || !existsSync(join(REPO, file))) continue;
    readFileSync(join(REPO, file), 'utf8')
      .split('\n')
      .forEach((line, i) => spawnsTsc(line) && offenders.push(`${file}:${i + 1}`));
  }
  assert.deepEqual(
    offenders,
    [],
    'these call tsc directly; run tooling/scripts/tsc.mjs instead (tsrs off CI, tsc in CI): `node tooling/codemod/tsc-entry/rewrite.mjs` rewrites package.json scripts, and a tool spawns `node <repo>/tooling/scripts/tsc.mjs <args>`',
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
