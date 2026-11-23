// tooling-tests: alone. It runs `git fetch` into the checkout's own .git (FETCH_HEAD, objects/maintenance.lock).
// The kit-look rules on planted room files, the ceilings' judge on planted counts, and the tree against its committed
// ceilings and main's copy of them (intafaced issue 9326).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { countPlanted } from './count-rule.mjs';
import { mainRef } from '../ci/lint-ratchet.mjs';
import { CEILINGS, ROOT, countTree, describe, forkPoint, judge, lowered, readCeilings, renamesSince } from './kit-ceilings.mjs';

const skip = !existsSync(join(ROOT, 'node_modules', '.bin', 'oxlint')) && 'no node_modules';
const ROOM = 'apps/customer/src/features/planted/Room.tsx';
const room = (body) =>
  `import { Button, Text } from '@intafaced/ui';\nimport { cn } from '../../shared/cn';\nexport const Room = () => (\n  <div>\n${body}\n  </div>\n);\n`;
const count = (rule, body, file = ROOM) => countPlanted(rule, { [file]: room(body) }).total;

test('garden/no-restyled-kit-part: a restyled kit part fires; layout and variants pass', { skip }, () => {
  const rule = 'garden/no-restyled-kit-part';
  assert.equal(count(rule, '<Button className="bg-red-500">Buy</Button>'), 1, 'a colour class');
  assert.equal(count(rule, '<Button className="rounded-full shadow-lg">Buy</Button>'), 2, 'radius and shadow');
  assert.equal(count(rule, '<Button className={cn("mt-2", ok && "text-[13px] font-bold")}>Buy</Button>'), 2, 'type inside cn()');
  assert.equal(count(rule, '<Button className="hover:text-up">Buy</Button>'), 1, 'a colour behind a variant prefix');
  assert.equal(count(rule, "<Button style={{ color: 'var(--lit-up)' }}>Buy</Button>"), 1, 'a style colour');
  assert.equal(count(rule, '<Button className="ms-2 w-full flex gap-2 border-t text-center">Buy</Button>'), 0, 'layout only');
  assert.equal(count(rule, '<Button variant="primary" size={48}>Buy</Button>'), 0, 'a variant and a size');
  assert.equal(count(rule, '<span className="bg-red-500">x</span>'), 0, 'not a kit part');
  assert.equal(count(rule, '<Button className="bg-red-500">Buy</Button>', 'apps/customer/src/features/planted/Room.test.tsx'), 0, 'a test');
  assert.equal(count(rule, '<Button className="bg-red-500">Buy</Button>', 'apps/admin/src/Room.tsx'), 0, 'outside the customer app');
});

test('garden/no-raw-control: a raw control fires; the kit control passes', { skip }, () => {
  const rule = 'garden/no-raw-control';
  assert.equal(count(rule, '<button type="button">Buy</button>'), 1, 'a raw button');
  assert.equal(count(rule, '<input /><select /><textarea />'), 3, 'input, select, textarea');
  assert.equal(count(rule, '<Button>Buy</Button>'), 0, 'the kit Button');
});

test('garden/no-raw-type-class: a raw type class fires; a type role passes', { skip }, () => {
  const rule = 'garden/no-raw-type-class';
  assert.equal(count(rule, '<p className="text-[13px]">x</p>'), 1, 'an arbitrary size');
  assert.equal(count(rule, '<p className="text-sm font-medium leading-5 tracking-wide">x</p>'), 4, 'scale, weight, leading, tracking');
  assert.equal(count(rule, '<p className="text-center text-up mt-2">x</p>'), 0, 'alignment, colour and layout are not type');
  assert.equal(count(rule, '<Text variant="body">x</Text>'), 0, 'a type role');
});

test('judge: a count over its ceiling and a raised one each fail; a stale ceiling passes', () => {
  const R = 'garden/no-raw-control';
  const base = { [R]: { 'a.tsx': 2 } };
  assert.deepEqual(judge({ [R]: { 'a.tsx': 2 } }, base, base), [], 'held');
  assert.deepEqual(
    judge({ [R]: { 'a.tsx': 3 } }, base, base).map((p) => p.kind),
    ['over'],
    'a count rose',
  );
  assert.deepEqual(
    judge({ [R]: { 'b.tsx': 1, 'a.tsx': 2 } }, base, base).map((p) => p.kind),
    ['over'],
    'a new file holds one',
  );
  assert.deepEqual(judge({ [R]: { 'a.tsx': 1 } }, base, base), [], 'a count fell: the ceiling waits for the prune');
  assert.deepEqual(
    judge({ [R]: { 'a.tsx': 3 } }, { [R]: { 'a.tsx': 3 } }, base).map((p) => p.kind),
    ['raised'],
    'a raised ceiling',
  );
  assert.deepEqual(
    judge({ [R]: { 'c.tsx': 1 } }, { [R]: { 'a.tsx': 0, 'c.tsx': 1 } }, base).map((p) => p.kind),
    ['raised'],
    'an added file',
  );
  assert.match(describe({ kind: 'raised', rule: R, file: 'a.tsx', ceiling: 3, was: 2 }), /Never raise a ceiling/u);
  assert.deepEqual(lowered({ [R]: { 'a.tsx': 1 } }, base)[R], { 'a.tsx': 1 }, 'the prune lowers');
  assert.throws(() => lowered({ [R]: { 'a.tsx': 3 } }, base), /refused/u, 'the prune never raises');
});

test("judge and the prune: a renamed or moved file is the same file, held to its old path's ceiling", () => {
  const R = 'garden/no-raw-control';
  const base = { [R]: { 'old/A.tsx': 2 } };
  const renames = { 'new/A/A.tsx': 'old/A.tsx' };
  const moved = { [R]: { 'new/A/A.tsx': 2 } };
  assert.deepEqual(judge({ [R]: { 'new/A/A.tsx': 2 } }, moved, base, renames), [], 'moved at the same count');
  assert.deepEqual(judge({ [R]: { 'new/A/A.tsx': 1 } }, { [R]: { 'new/A/A.tsx': 1 } }, base, renames), [], 'moved and lowered');
  assert.deepEqual(
    judge({ [R]: { 'new/A/A.tsx': 3 } }, moved, base, renames).map((p) => p.kind),
    ['over'],
    'moved at a higher count',
  );
  assert.deepEqual(
    judge({ [R]: { 'new/A/A.tsx': 3 } }, { [R]: { 'new/A/A.tsx': 3 } }, base, renames).map((p) => [p.kind, p.was]),
    [['raised', 2]],
    "its entry moved by hand to a higher number: raised over its old path's 2",
  );
  assert.deepEqual(
    judge({ [R]: { 'new/A/A.tsx': 2, 'new/B.tsx': 1 } }, moved, base, renames).map((p) => [p.kind, p.file]),
    [['over', 'new/B.tsx']],
    'a brand-new file holding a raw control beside the move',
  );
  assert.deepEqual(
    judge({ [R]: { 'new/B.tsx': 1 } }, { [R]: { 'new/B.tsx': 1 } }, base, renames).map((p) => [p.kind, p.file]),
    [['raised', 'new/B.tsx']],
    'a brand-new file given an entry by hand: added',
  );
  assert.deepEqual(
    judge({ [R]: { 'new/A/A.tsx': 2 } }, { [R]: { 'old/A.tsx': 2, 'new/A/A.tsx': 2 } }, base, renames),
    [],
    "the old path's entry kept beside the new one is stale, and passes until the prune drops it",
  );
  assert.deepEqual(lowered({ [R]: { 'new/A/A.tsx': 2 } }, base, renames)[R], { 'new/A/A.tsx': 2 }, 'the prune moves the entry');
  assert.deepEqual(lowered({ [R]: { 'new/A/A.tsx': 1 } }, base, renames)[R], { 'new/A/A.tsx': 1 }, 'the prune moves and lowers');
  assert.throws(() => lowered({ [R]: { 'new/A/A.tsx': 3 } }, base, renames), /refused/u, 'the prune never raises a moved file');
  assert.throws(() => lowered({ [R]: { 'new/B.tsx': 1 } }, base, renames), /refused/u, 'the prune never adds a new file');
  const gone = { [R]: { 'old/A.tsx': 2, 'old/Gone.tsx': 4 } };
  assert.deepEqual(
    lowered({ [R]: { 'new/A/A.tsx': 2 } }, gone, renames)[R],
    { 'new/A/A.tsx': 2 },
    "the prune drops a deleted file's ceiling beside a move",
  );
});

test('two Volt batches into main that lower different files edit no common file; the prune lowers both', () => {
  const R = 'garden/no-raw-control';
  const ceilings = { [R]: { 'a/A.tsx': 2, 'b/B.tsx': 3 } };
  const after = { A: { 'a/A.tsx': 0, 'b/B.tsx': 3 }, B: { 'a/A.tsx': 2, 'b/B.tsx': 1 }, both: { 'a/A.tsx': 0, 'b/B.tsx': 1 } };
  for (const [label, counts] of Object.entries(after))
    assert.deepEqual(judge({ [R]: counts }, ceilings, ceilings), [], `${label}, into main, with ${CEILINGS} untouched`);
  assert.deepEqual(
    judge({ [R]: { ...after.both, 'c/C.tsx': 1 } }, ceilings, ceilings).map((p) => [p.kind, p.file]),
    [['over', 'c/C.tsx']],
    'a batch that adds a file holding a finding still fails',
  );
  assert.deepEqual(
    judge({ [R]: after.both }, { [R]: { ...ceilings[R], 'b/B.tsx': 4 } }, ceilings).map((p) => [p.kind, p.file]),
    [['raised', 'b/B.tsx']],
    'a batch that raises a ceiling still fails',
  );
  const pruned = lowered({ [R]: after.both }, ceilings);
  assert.deepEqual(pruned[R], { 'a/A.tsx': 0, 'b/B.tsx': 1 }, 'the prune lowers both stale ceilings');
  assert.deepEqual(judge({ [R]: after.both }, pruned, ceilings), [], "the prune's PR passes");
});

test(`the tree holds ${CEILINGS}: no count over its ceiling, none raised over main's`, { skip }, () => {
  const ref = mainRef();
  assert.ok(ref, "cannot fetch main: main's ceilings are what a change's are judged against");
  let base = null;
  try {
    base = JSON.parse(
      execFileSync('git', ['show', `${forkPoint(ref)}:${CEILINGS}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  } catch (e) {
    // Only the change that adds the file has no copy on main to compare with.
    assert.match(String(e.stderr), /does not exist|exists on disk, but not in/u, String(e.stderr));
  }
  const problems = judge(countTree(), readCeilings(), base, renamesSince(ref));
  assert.deepEqual(problems.map(describe), []);
});
