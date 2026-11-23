/**
 * Every crate's port notes (`crates/<service>/PORT.md`) end in a `## Slices` list that the garden can read: lines
 * "- `<name>` (after `<name>`, ...): <its calls>", each slice named once, each `after` naming a slice listed above it.
 * The garden opens one item per line from main's copy, and stops at the first list that does not read, so a slice
 * PR that adds a second line for its slice instead of editing the first (#10037 did) leaves the whole service stuck.
 * This catches it on the PR. The reader is project-state's `tooling/garden/shape.mjs` `portSlices`, kept identical.
 * No network. Run: node --test tooling/ci/port-notes.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const NAME = '[a-z0-9][a-z0-9-]*';

/** The garden's reader: `{ slices }`, or `{ error }` naming what does not read. */
export function portSlices(text) {
  const sec = /^## Slices[ \t]*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text ?? '')?.[1];
  if (sec == null) return { error: 'no `## Slices` section' };
  const slices = [...sec.matchAll(new RegExp(`^- \`(${NAME})\`(?: \\(after ([^)]*)\\))?`, 'gm'))].map(([, name, after]) => ({
    name,
    after: [...(after ?? '').matchAll(new RegExp(`\`(${NAME})\``, 'g'))].map((x) => x[1]),
  }));
  const names = slices.map((x) => x.name);
  if (!slices.length) return { error: 'its `## Slices` section lists no "- `<name>`: ..." line' };
  const twice = names.find((n, k) => names.indexOf(n) !== k);
  if (twice) return { error: `a slice is listed twice: \`${twice}\` (edit its one line; never add a second)` };
  const unknown = slices.flatMap((x, k) => x.after.filter((a) => !names.slice(0, k).includes(a)))[0];
  if (unknown) return { error: `\`(after ${unknown})\` names no slice listed above it` };
  return { slices };
}

const ROOT = process.cwd();
const notes = existsSync(join(ROOT, 'crates'))
  ? readdirSync(join(ROOT, 'crates'))
      .map((c) => `crates/${c}/PORT.md`)
      .filter((p) => existsSync(join(ROOT, p)))
  : [];

// Every port so far has finished and its notes became the crate's README.md (svc-bank last); a new port's PORT.md is
// read below the moment it lands. Run from anywhere else, there is nothing to read and that is the mistake.
test('the checkout is the repo root, where port notes are read', () => {
  assert.ok(existsSync(join(ROOT, 'crates')), 'no crates/ here: run from the repo root');
});

for (const p of notes) {
  test(`${p}'s slices read: each named once, each after one above it`, () => {
    const read = portSlices(readFileSync(join(ROOT, p), 'utf8'));
    assert.equal(read.error, undefined, `${p}: ${read.error}`);
  });
}

test("#10037's mistake, a slice's line added again instead of edited, is refused", () => {
  const text = [
    '## Slices',
    '',
    '- `business` (after `transfers`): `business.*` (21 calls)',
    '- `transfers`: `transfers.*`',
    '- `business-spend` (after `business`): `businessBills.*` (29 calls), `/internal/jobs/bill-pay/{run-due,returned}`',
    '- `business-spend` (after `business`): `businessBills.*` (29 calls)',
  ].join('\n');
  assert.match(portSlices(text).error, /listed twice: `business-spend`/);
});

test('an after that names no slice above it, no section, and an empty section are refused', () => {
  assert.match(portSlices('## Slices\n- `a` (after `b`): x\n- `b`: y\n').error, /\(after b\)/);
  assert.match(portSlices('# Notes\n').error, /no `## Slices`/);
  assert.match(portSlices('## Slices\n\nnothing\n## Next\n').error, /lists no/);
});

test('a list in order reads, and a following section ends it', () => {
  const read = portSlices('## Slices\n- `store`: x\n- `a` (after `store`): y\n## After\n- `store`: not a slice\n');
  assert.deepEqual(read.slices, [
    { name: 'store', after: [] },
    { name: 'a', after: ['store'] },
  ]);
});
