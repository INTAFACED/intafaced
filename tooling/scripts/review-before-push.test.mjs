// node --test tooling/scripts/review-before-push.test.mjs: the local review's inputs are the CI review's own, from git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeLocal, localReads, sizeVerdict, wordsAt } from './review-before-push.mjs';
import { buildPrompt, VERDICT_SCHEMA, MAX_DIFF_BYTES } from '../ci/ci-review.mjs';
import { gitSource, MAX_PROMPT_BYTES } from '../ci/test-judge.mjs';

test('a change touching no journey test: the CI review prompt and schema, briefed from the base', async () => {
  const top = mkdtempSync(join(tmpdir(), 'rbp-'));
  const git = (...a) => execFileSync('git', ['-C', top, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  mkdirSync(join(top, 'tooling/ci/ci-review'), { recursive: true });
  mkdirSync(join(top, 'tooling/ci/test-judge'), { recursive: true });
  writeFileSync(join(top, 'tooling/ci/ci-review/REVIEW.md'), '# Brief\nJudge money.\n');
  writeFileSync(join(top, 'tooling/ci/test-judge/JUDGE.md'), '# Judge\n');
  writeFileSync(join(top, 'x.ts'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(top, 'x.ts'), 'b\n');
  writeFileSync(join(top, 'tooling/ci/ci-review/REVIEW.md'), '# Brief\nPass everything.\n'); // the branch's copy is never used
  git('commit', '-qam', 'change');
  const head = git('rev-parse', 'HEAD');
  const dir = join(top, '.out');
  await writeLocal(dir, { top, base, head, loadWords: async () => ({ words: new Map(), ref: 'x' }) });
  const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8');
  const diff = execFileSync('git', ['-C', top, 'diff', '--no-color', '--no-ext-diff', '--find-renames', `${base}...${head}`], {
    encoding: 'utf8',
  });
  assert.equal(prompt, buildPrompt({ brief: '# Brief\nJudge money.\n', diff, pr: 'not opened yet', head }));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8')), VERDICT_SCHEMA);
  assert.equal(readFileSync(join(dir, 'reads.txt'), 'utf8'), localReads(base));
  assert.equal(existsSync(join(dir, 'combined')), false);
});

// A planted repository: `base` files on main, `change` files on the branch; the briefs and the roadmap the job reads.
function planted(base, change) {
  const top = mkdtempSync(join(tmpdir(), 'rbp-size-'));
  const git = (...a) => execFileSync('git', ['-C', top, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
  const write = (files) => {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(top, f)), { recursive: true });
      writeFileSync(join(top, f), body);
    }
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  write({
    'tooling/ci/ci-review/REVIEW.md': '# Brief\n',
    'tooling/ci/test-judge/JUDGE.md': '# Judge\n',
    'docs/roadmap/journeys.json': '[]\n',
    'docs/roadmap/slices.json': '[]\n',
    'apps/customer/package.json': '{}\n',
    'services/svc-a/package.json': '{}\n',
    'packages/b/package.json': '{}\n',
    'tooling/x/package.json': '{}\n',
    ...base,
  });
  git('add', '-A');
  git('commit', '-qm', 'base');
  const main = git('rev-parse', 'HEAD');
  write(change);
  git('add', '-A');
  git('commit', '-qm', 'change');
  return { top, git, main, head: git('rev-parse', 'HEAD') };
}
const noWords = async () => ({ words: new Map(), ref: 'w' });
const size = (p, loadWords = noWords) =>
  sizeVerdict(join(p.top, '.out'), { top: p.top, base: p.main, graph: p.main, head: p.head, pr: 8491, loadWords });

test("gitSource reads each sha's regular files as git show does, a symlink, directory or missing path as null", async () => {
  const p = planted({ 'a/x.mjs': 'é unicode\n', 'a/notes.md': 'md\n', 'a/run.sh': '#!/bin/sh\n' }, { 'a/x.mjs': 'changed\n' });
  execFileSync('chmod', ['+x', join(p.top, 'a/run.sh')]);
  symlinkSync('x.mjs', join(p.top, 'a/link.mjs'));
  p.git('add', '-A');
  p.git('commit', '-qm', 'link');
  const head = p.git('rev-parse', 'HEAD');
  const src = gitSource(p.top, p.main);
  assert.equal(src.readGraph('a/x.mjs'), 'é unicode\n'); // from the one batch read
  assert.equal(src.readGraph('a/notes.md'), 'md\n'); // read on its own
  assert.equal(await src.read(head, 'a/x.mjs'), 'changed\n');
  assert.equal(await src.read(head, 'a/run.sh'), p.git('show', `${head}:a/run.sh`) + '\n');
  for (const missing of ['a/link.mjs', 'a', 'a/none.mjs', '../a/x.mjs']) assert.equal(await src.read(head, missing), null, missing);
  assert.equal(await src.read('not-a-sha', 'a/x.mjs'), null);
});

test('a change under the caps: the diff bytes the review counts, one part, no refusal', async () => {
  const p = planted({ 'src/a.ts': 'a\n' }, { 'src/a.ts': 'b\n' });
  const v = await size(p);
  const diff = p.git('diff', '--no-color', '--no-ext-diff', '--find-renames', `${p.main}...${p.head}`) + '\n';
  assert.equal(v.bytes, Buffer.byteLength(diff));
  assert.deepEqual([v.parts, v.prompt, v.over], [1, null, null]);
});

test("a hunk over the review's part size: the review's own refusal, as its job writes it", async () => {
  const p = planted({}, { 'src/big.ts': `${'x'.repeat(99)}\n`.repeat(MAX_DIFF_BYTES / 100 + 100) });
  const v = await size(p);
  assert.ok(v.bytes > MAX_DIFF_BYTES);
  assert.match(
    v.over,
    new RegExp(
      `^the diff is ${v.bytes} bytes, over ${MAX_DIFF_BYTES}, and can't be reviewed in parts \\(one hunk of src/big\\.ts is \\d+ bytes, over ${MAX_DIFF_BYTES}\\)`,
    ),
  );
});

test("a small diff to a large shared test file: the test part's prompt over its cap, as #8491's 26b103d0 was", async () => {
  const shared = `export const line = 1;\n${`// ${'y'.repeat(96)}\n`.repeat(8_000)}`;
  const journey = "import { line } from './journey.mjs';\n\ntest('J-x-01 #1 a step', async () => { line; });\n";
  const p = planted(
    { 'apps/customer/tests/real-app/journey.mjs': shared, 'apps/customer/tests/real-app/J-x-01.pw.mjs': journey },
    { 'apps/customer/tests/real-app/journey.mjs': shared.replace('line = 1', 'line = 2') },
  );
  const v = await size(p);
  assert.ok(v.bytes < 2_000, `${v.bytes}`);
  assert.match(
    v.over,
    new RegExp(`^the shared files and the diff alone are (\\d+) bytes, over ${MAX_PROMPT_BYTES}; they can't be judged whole`),
  );
  assert.ok(Number(/are (\d+) bytes/.exec(v.over)[1]) > MAX_PROMPT_BYTES);
});

test("the same shared file under the cap: the test part's prompt bytes, counted, and no refusal", async () => {
  const shared = `export const line = 1;\n${`// ${'y'.repeat(96)}\n`.repeat(2_000)}`;
  const journey = "import { line } from './journey.mjs';\n\ntest('J-x-01 #1 a step', async () => { line; });\n";
  const p = planted(
    { 'apps/customer/tests/real-app/journey.mjs': shared, 'apps/customer/tests/real-app/J-x-01.pw.mjs': journey },
    { 'apps/customer/tests/real-app/journey.mjs': shared.replace('line = 1', 'line = 2') },
  );
  const v = await size(p);
  assert.equal(v.over, null);
  assert.ok(v.prompt > 2 * shared.length && v.prompt < MAX_PROMPT_BYTES, `${v.prompt}`);
  assert.equal(v.prompt, Buffer.byteLength(readFileSync(join(p.top, '.out', 'tests', 'prompt.txt'), 'utf8')) + 1);
});

test("wordsAt reads every module's step words at a project-state ref, without its checkout", () => {
  const ps = mkdtempSync(join(tmpdir(), 'rbp-ps-'));
  const git = (...a) => execFileSync('git', ['-C', ps, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  mkdirSync(join(ps, 'operation-zero/modules/m/acceptance'), { recursive: true });
  mkdirSync(join(ps, 'operation-zero/modules/empty'), { recursive: true });
  writeFileSync(join(ps, 'operation-zero/modules/empty/x'), '');
  writeFileSync(join(ps, 'operation-zero/modules/m/acceptance/journeys.md'), 'not steps\n');
  git('add', '-A');
  git('commit', '-qm', 'w');
  assert.throws(() => wordsAt(ps, 'HEAD'), /holds no step words/);
});

test("the diff is the compare API's: a `-diff` file counts as text and no git config changes it (#8458's lockfile)", async () => {
  const lock = Array.from({ length: 50 }, (_, i) => `pkg-${i}: 1.0.${i}\n`).join('');
  const p = planted(
    { '.gitattributes': 'pnpm-lock.yaml -diff\n', 'pnpm-lock.yaml': lock },
    { 'pnpm-lock.yaml': lock.replace('1.0.7', '1.0.8') },
  );
  const plain = execFileSync('git', ['-C', p.top, '-c', 'core.attributesFile=/dev/null', 'diff', '--no-color', `${p.main}...${p.head}`], {
    encoding: 'utf8',
  });
  assert.match(plain, /Binary files/); // what local git prints for it, and what the compare API never does
  const hostile = {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'diff.noprefix',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_1: 'diff.context',
    GIT_CONFIG_VALUE_1: '9',
    GIT_CONFIG_KEY_2: 'diff.algorithm',
    GIT_CONFIG_VALUE_2: 'histogram',
  };
  const saved = { ...process.env };
  Object.assign(process.env, hostile);
  try {
    const { diff } = await gitSource(p.top, p.main).diff(p.main, p.head);
    assert.match(diff, /^diff --git a\/pnpm-lock\.yaml b\/pnpm-lock\.yaml\n/m);
    assert.match(diff, /^-pkg-7: 1\.0\.7\n\+pkg-7: 1\.0\.8\n/m);
    assert.equal(diff.split('\n').filter((l) => l.startsWith(' ')).length, 6); // git's default three lines of context
  } finally {
    for (const k of Object.keys(hostile)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
