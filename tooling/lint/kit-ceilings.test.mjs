// The kit-look rules on planted room files, the ceilings' judge on planted counts, and the tree against its committed
// ceilings and main's copy of them (intafaced issue 9326).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { countPlanted } from './count-rule.mjs';
import { mainRef } from '../ci/lint-ratchet.mjs';
import { CEILINGS, ROOT, countTree, describe, judge, lowered, readCeilings } from './kit-ceilings.mjs';

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

test('judge: a count over its ceiling, a stale ceiling and a raised one each fail', () => {
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
  assert.deepEqual(
    judge({ [R]: { 'a.tsx': 1 } }, base, base).map((p) => p.kind),
    ['stale'],
    'a count fell: lower the ceiling',
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
  assert.deepEqual(lowered({ [R]: { 'a.tsx': 1 } }, base)[R], { 'a.tsx': 1 }, '--write lowers');
  assert.throws(() => lowered({ [R]: { 'a.tsx': 3 } }, base), /refused/u, '--write never raises');
});

test(`the tree holds ${CEILINGS}: no count over, none stale, none raised over main's`, { skip }, () => {
  const ref = mainRef();
  assert.ok(ref, "cannot fetch main: main's ceilings are what a change's are judged against");
  let base = null;
  try {
    base = JSON.parse(
      execFileSync('git', ['show', `${ref}:${CEILINGS}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  } catch (e) {
    // Only the change that adds the file has no copy on main to compare with.
    assert.match(String(e.stderr), /does not exist|exists on disk, but not in/u, String(e.stderr));
  }
  const problems = judge(countTree(), readCeilings(), base);
  assert.deepEqual(problems.map(describe), []);
});
