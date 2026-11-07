/**
 * The planted cases of journey-list-guard.mjs: main's own journey list passes; a dropped journey, a dropped step, a step
 * taken out of the live count, an unknown slice id, a stale ROADMAP.md and a retirement line without an OWNER number each
 * fail; a regenerated ROADMAP.md hides no drop; a strict `Journey-retired:` line with an OWNER number passes, and one in
 * code or a comment does not. The last two run the script itself against a scratch git repository.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compose } from '../scripts/roadmap.mjs';
import { drops, judge, retireLine, retirements } from './journey-list-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'tooling', 'ci', 'journey-list-guard.mjs');
const load = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const JOURNEYS = load('docs/roadmap/journeys.json');
const SLICES = load('docs/roadmap/slices.json');
const ROADMAP = readFileSync(join(ROOT, 'docs/ROADMAP.md'), 'utf8');
const copy = () => structuredClone(JOURNEYS);
// A live journey with at least two live steps, so dropping one step leaves the journey live.
const target = JOURNEYS.find((j) => !j.parked && !j.deferred && j.steps.filter((s) => !s.parked && !s.deferred).length >= 2);
const fresh = async (head) => (await compose(SLICES, head, ROADMAP)) === ROADMAP;
const verdict = (head, body = '', roadmapFresh = true) => judge({ base: JOURNEYS, head, slices: SLICES, roadmapFresh, body });
const withoutJourney = () => copy().filter((j) => j.id !== target.id);
const withoutStep = () => {
  const head = copy();
  const j = head.find((x) => x.id === target.id);
  j.steps = j.steps.filter((s) => s.n !== target.steps.at(-1).n);
  return head;
};

test("main's own journey list and ROADMAP.md pass", async () => {
  assert.equal(await fresh(JOURNEYS), true, 'docs/ROADMAP.md on this tree is what roadmap.mjs builds');
  const v = await verdict(JOURNEYS);
  assert.deepEqual(v, { ok: true, lines: [] });
});

test('planted: a dropped journey fails', async () => {
  const v = await verdict(withoutJourney());
  assert.equal(v.ok, false);
  assert.ok(
    v.lines.some((l) => l.startsWith(`${target.id} is on the base`)),
    v.lines.join('\n'),
  );
});

test('planted: a dropped step fails', async () => {
  const v = await verdict(withoutStep());
  assert.equal(v.ok, false);
  assert.ok(
    v.lines.some((l) => l.startsWith(`${target.id} #${target.steps.at(-1).n} is on the base`)),
    v.lines.join('\n'),
  );
});

test('planted: a step newly parked, or a journey newly deferred, is a drop from the live count', async () => {
  const parked = copy();
  parked.find((x) => x.id === target.id).steps[0].parked = true;
  assert.deepEqual(drops(JOURNEYS, parked).steps, [{ key: `${target.id}#${target.steps[0].n}`, how: 'taken out of the live count' }]);
  const deferred = copy();
  deferred.find((x) => x.id === target.id).deferred = true;
  assert.deepEqual(drops(JOURNEYS, deferred).journeys, [{ id: target.id, how: 'taken out of the live count' }]);
  assert.equal((await verdict(parked)).ok, false);
});

test('planted: an unknown slice id fails', async () => {
  const head = copy();
  head.find((x) => x.id === target.id).steps[0].slices.push('NOPE-made-up-01');
  const v = await verdict(head);
  assert.equal(v.ok, false);
  assert.ok(
    v.lines.some((l) => l.endsWith(`${target.id} #${target.steps[0].n}: NOPE-made-up-01`)),
    v.lines.join('\n'),
  );
});

test('planted: a regenerated ROADMAP.md hides no drop, and a stale one fails', async () => {
  const head = withoutJourney();
  const regenerated = await compose(SLICES, head, ROADMAP);
  assert.notEqual(regenerated, ROADMAP, 'the drop changes the page');
  const v = await judge({
    base: JOURNEYS,
    head,
    slices: SLICES,
    roadmapFresh: (await compose(SLICES, head, regenerated)) === regenerated,
    body: '',
  });
  assert.equal(v.ok, false);
  assert.ok(
    v.lines.some((l) => l.startsWith(`${target.id} is on the base`)) && !v.lines.some((l) => l.includes('ROADMAP')),
    v.lines.join('\n'),
  );
  // The page left as it was, while journeys.json changes: stale.
  const stale = await verdict(head, `Journey-retired: ${target.id} (OWNER 1)`, await fresh(head));
  assert.equal(stale.ok, false);
  assert.ok(
    stale.lines.some((l) => l.includes('docs/ROADMAP.md is not what')),
    stale.lines.join('\n'),
  );
});

test('planted: a retirement line without an OWNER number fails; with one it passes', async () => {
  const head = withoutStep();
  const step = `${target.id} #${target.steps.at(-1).n}`;
  for (const bad of [
    `Journey-retired: ${step}`,
    `Journey-retired: ${step} (OWNER)`,
    `Journey-retired: ${step} OWNER 183`,
    `Journey-retired: ${step} (owner 183)`,
  ]) {
    const v = await verdict(head, bad);
    assert.equal(v.ok, false, bad);
    assert.ok(
      v.lines.some((l) => l.includes('looks like a retirement')),
      `${bad}\n${v.lines.join('\n')}`,
    );
  }
  assert.deepEqual(await verdict(head, `Why.\n\nJourney-retired: ${step} (OWNER 183)\n`), { ok: true, lines: [] });
  assert.deepEqual(await verdict(withoutJourney(), `Journey-retired: ${target.id} (OWNER 183)`), { ok: true, lines: [] });
  // The printed line, with its placeholder filled in, is accepted.
  const printed = retireLine(drops(JOURNEYS, head)).replace('<n>', '183');
  assert.deepEqual(await verdict(head, printed), { ok: true, lines: [] });
});

test('a retirement line in code, in a comment, indented, or naming another step retires nothing', async () => {
  const head = withoutStep();
  const step = `${target.id} #${target.steps.at(-1).n}`;
  const line = `Journey-retired: ${step} (OWNER 183)`;
  for (const body of [
    '```\n' + line + '\n```',
    `<!-- ${line} -->`,
    `  ${line}`,
    `- ${line}`,
    `Journey-retired: ${target.id} #99 (OWNER 183)`,
  ]) {
    const v = await verdict(head, body);
    assert.equal(v.ok, false, body);
  }
  assert.deepEqual(retirements(`journey-retired: ${step} (OWNER 1)`).problems, [`journey-retired: ${step} (OWNER 1)`]);
});

test('the body is read only when something is dropped', async () => {
  let reads = 0;
  const body = () => {
    reads += 1;
    return '';
  };
  await judge({ base: JOURNEYS, head: JOURNEYS, slices: SLICES, roadmapFresh: true, body });
  assert.equal(reads, 0);
  await judge({ base: JOURNEYS, head: withoutStep(), slices: SLICES, roadmapFresh: true, body });
  assert.equal(reads, 1);
});

test('a malformed journeys.json fails by name', async () => {
  const head = copy();
  head.push(structuredClone(head[0]));
  const v = await verdict(head);
  assert.equal(v.ok, false);
  assert.ok(
    v.lines.some((l) => l.endsWith(`${head[0].id} is used twice`)),
    v.lines.join('\n'),
  );
});

test('the script: passes the base unchanged, refuses a dropped journey with a regenerated page, takes a retirement line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-list-guard-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    const put = (p, text) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    };
    git('init', '-q', '-b', 'main');
    put('docs/roadmap/journeys.json', JSON.stringify(JOURNEYS));
    put('docs/roadmap/slices.json', JSON.stringify(SLICES));
    put('docs/ROADMAP.md', ROADMAP);
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    const run = (env = {}) =>
      spawnSync(process.execPath, [SCRIPT, '--base-ref', 'main'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    const head = withoutJourney();
    put('docs/roadmap/journeys.json', JSON.stringify(head));
    put('docs/ROADMAP.md', await compose(SLICES, head, ROADMAP));
    const refused = run({ PR_BODY: '' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`${target.id} is on the base`));
    assert.doesNotMatch(refused.stderr, /ROADMAP/);
    const retired = run({ PR_BODY: `Journey-retired: ${target.id} (OWNER 183)` });
    assert.equal(retired.status, 0, retired.stderr);
    const noOwner = run({ PR_BODY: `Journey-retired: ${target.id}` });
    assert.equal(noOwner.status, 1);
    const missingRef = spawnSync(process.execPath, [SCRIPT, '--base-ref', 'nope'], { cwd: dir, encoding: 'utf8' });
    assert.equal(missingRef.status, 1, 'a base ref that does not exist fails rather than read an empty base');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
