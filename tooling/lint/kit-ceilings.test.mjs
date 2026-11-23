// tooling-tests: alone. It runs `git fetch` into the checkout's own .git (FETCH_HEAD, objects/maintenance.lock).
// The kit-look rules on planted room files, the ceilings' judge on planted counts, and the tree against its committed
// ceilings and main's copy of them (intafaced issue 9326).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countPlanted } from './count-rule.mjs';
import { mainRef } from '../ci/lint-ratchet.mjs';
import {
  CEILINGS,
  ROOT,
  countTree,
  countsAt,
  describe,
  forkPoint,
  judge,
  lowered,
  readCeilings,
  renamesSince,
  staleOf,
} from './kit-ceilings.mjs';

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

test('judge: a count over its ceiling and a raised ceiling fail; a stale one passes', () => {
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
  assert.deepEqual(judge({ [R]: { 'a.tsx': 1 } }, base, base), [], 'a count fell: the stale ceiling passes, on a PR into main');
  assert.deepEqual(
    staleOf({ [R]: { 'a.tsx': 1 } }, base).map((p) => p.kind),
    ['stale'],
    'and is named for the prune script',
  );
  assert.deepEqual(
    staleOf({ [R]: {} }, base).map((p) => [p.file, p.count]),
    [['a.tsx', 0]],
    "a gone file's entry is stale",
  );
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
  assert.deepEqual(
    judge({ [R]: { 'a.tsx': 2 } }, base, base, {}, { [R]: { 'a.tsx': 1 } }).map((p) => [p.kind, p.was]),
    [['rose', 1]],
    "a count back up to its stale ceiling: rose over main's count",
  );
  assert.deepEqual(
    judge({ [R]: { 'a.tsx': 1 } }, base, base, {}, { [R]: { 'a.tsx': 0 } }).map((p) => p.kind),
    ['rose'],
    'a file main counts 0, its ceiling stale at 2, gains one',
  );
  assert.deepEqual(judge({ [R]: { 'a.tsx': 1 } }, base, base, {}, { [R]: { 'a.tsx': 2 } }), [], 'a count that fell passes');
  assert.deepEqual(lowered({ [R]: { 'a.tsx': 1 } }, base)[R], { 'a.tsx': 1 }, '--write lowers');
  assert.throws(() => lowered({ [R]: { 'a.tsx': 3 } }, base), /refused/u, '--write never raises');
});

test("judge and --write: a renamed or moved file is the same file, held to its old path's ceiling", () => {
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
    judge({ [R]: { 'new/A/A.tsx': 2 } }, { [R]: { 'old/A.tsx': 2, 'new/A/A.tsx': 2 } }, base, renames).map((p) => [p.kind, p.file]),
    [],
    "the old path's entry kept beside the new one is stale, and passes",
  );
  assert.deepEqual(
    judge({ [R]: { 'new/A/A.tsx': 2 } }, moved, base, renames, { [R]: { 'old/A.tsx': 1 } }).map((p) => [p.kind, p.was]),
    [['rose', 1]],
    "a moved file is held to its old path's count on main",
  );
  assert.deepEqual(lowered({ [R]: { 'new/A/A.tsx': 2 } }, base, renames)[R], { 'new/A/A.tsx': 2 }, '--write moves the entry');
  assert.deepEqual(lowered({ [R]: { 'new/A/A.tsx': 1 } }, base, renames)[R], { 'new/A/A.tsx': 1 }, '--write moves and lowers');
  assert.throws(() => lowered({ [R]: { 'new/A/A.tsx': 3 } }, base, renames), /refused/u, '--write never raises a moved file');
  assert.throws(() => lowered({ [R]: { 'new/B.tsx': 1 } }, base, renames), /refused/u, '--write never adds a new file');
  const gone = { [R]: { 'old/A.tsx': 2, 'old/Gone.tsx': 4 } };
  assert.deepEqual(
    lowered({ [R]: { 'new/A/A.tsx': 2 } }, gone, renames)[R],
    { 'new/A/A.tsx': 2 },
    "--write drops a deleted file's ceiling beside a move",
  );
});

test('two Volt batches into main that lower different files edit no common file, and each passes after the other', () => {
  const R = 'garden/no-raw-control';
  const ceilings = { [R]: { 'a/A.tsx': 2, 'b/B.tsx': 3 } };
  const main = { 'a/A.tsx': 2, 'b/B.tsx': 3 };
  const after = { A: { 'a/A.tsx': 0, 'b/B.tsx': 3 }, B: { 'a/A.tsx': 2, 'b/B.tsx': 1 }, both: { 'a/A.tsx': 0, 'b/B.tsx': 1 } };
  for (const [label, counts] of Object.entries(after))
    assert.deepEqual(judge({ [R]: counts }, ceilings, ceilings, {}, { [R]: main }), [], `${label}, into main, with ${CEILINGS} untouched`);
  assert.deepEqual(judge({ [R]: after.both }, ceilings, ceilings, {}, { [R]: after.A }), [], 'B after A merged');
  assert.deepEqual(
    staleOf({ [R]: after.both }, ceilings).map((p) => p.file),
    ['a/A.tsx', 'b/B.tsx'],
    'both left stale',
  );
  const pruned = lowered({ [R]: after.both }, ceilings);
  assert.deepEqual(judge({ [R]: after.both }, pruned, ceilings), [], "the prune script's ceilings pass");
  assert.deepEqual(staleOf({ [R]: after.both }, pruned), [], 'and leave none stale');
  assert.deepEqual(
    lowered({ [R]: { 'b/B.tsx': 1 } }, ceilings)[R],
    { 'b/B.tsx': 1 },
    'a file the lint counts no finding in loses its entry',
  );
});

test("countsAt: a touched file's counts where the change forked, 0 for one with none, a renamed file at its old path", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-ceilings-git-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const put = (file, body) => {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), room(body));
    };
    git('init', '-q');
    put('apps/customer/src/features/planted/A.tsx', '<button>a</button>');
    put('apps/customer/src/features/planted/B.tsx', '<span>b</span>');
    put('apps/customer/src/features/planted/Old.tsx', '<button>c</button><button>d</button>');
    put('apps/customer/src/features/planted/Same.tsx', '<button>e</button>');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fork');
    put('apps/customer/src/features/planted/A.tsx', '<button>a</button><button>a2</button>');
    put('apps/customer/src/features/planted/B.tsx', '<button>b</button>');
    git('mv', 'apps/customer/src/features/planted/Old.tsx', 'apps/customer/src/features/planted/New.tsx');
    const renames = renamesSince('HEAD', dir);
    assert.deepEqual(renames, { 'apps/customer/src/features/planted/New.tsx': 'apps/customer/src/features/planted/Old.tsx' });
    const at = countsAt('HEAD', dir, renames)['garden/no-raw-control'];
    assert.deepEqual(at, {
      'apps/customer/src/features/planted/A.tsx': 1,
      'apps/customer/src/features/planted/B.tsx': 0,
      'apps/customer/src/features/planted/Old.tsx': 2,
    });
    const now = { 'garden/no-raw-control': countTree(dir)['garden/no-raw-control'] };
    const stale = { 'garden/no-raw-control': Object.fromEntries(Object.keys(now['garden/no-raw-control']).map((f) => [f, 5])) };
    assert.deepEqual(
      judge(now, stale, stale, renames, countsAt('HEAD', dir, renames)).map((p) => [p.kind, p.file.split('/').at(-1), p.was]),
      [
        ['rose', 'A.tsx', 1],
        ['rose', 'B.tsx', 0],
      ],
      'under stale ceilings of 5, the two files that gained a raw control fail; the moved and untouched ones pass',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`the tree holds ${CEILINGS}: no count over its ceiling or main's, no ceiling raised over main's`, { skip }, () => {
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
  const fork = forkPoint(ref);
  const renames = renamesSince(ref);
  const problems = judge(countTree(), readCeilings(), base, renames, countsAt(fork, ROOT, renames));
  assert.deepEqual(problems.map(describe), []);
});
