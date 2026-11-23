// A door's `.refine` written with no message (door-refine.mjs), on planted inputs: the door's name for it is read from
// its recorder, names the record's check, finds the sample that check alone refuses, and holds the record to the door.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { canon, doorTree, knowRefines, treeOf } from './door-check.mjs';
import { doorRefines, quietRefineAt, squash, wordsOf } from './door-refine.mjs';
import { samplesFor } from './samples.mjs';

/** The zod the records use: the one @intafaced/contracts resolves. */
const contractsZod = () =>
  import(pathToFileURL(createRequire(new URL('../../../packages/contracts/package.json', import.meta.url)).resolve('zod')).href);

const REFINE = '(.refine/.superRefine (a TypeScript predicate the export drops))';
const EIGHT = '(args) => Object.keys(args).length <= 8';

/** A planted crate whose recorder names one refine, written two ways, beside a table that is not the refines'. */
function plantedDoor() {
  const root = mkdtempSync(join(tmpdir(), 'call-records-door-refine-'));
  mkdirSync(join(root, 'crates/svc-x/scripts'), { recursive: true });
  writeFileSync(
    join(root, 'crates/svc-x/scripts/record-door.mjs'),
    [
      "const OTHER = { '(v) => v > 0': 'not_a_refine' };",
      'const REFINES = {',
      "  'args=>Object.keys(args).length<=8': 'at_most_eight_keys',",
      `  '${EIGHT}': 'at_most_eight_keys',`,
      '};',
      'export { OTHER, REFINES };',
      '',
    ].join('\n'),
  );
  return root;
}

test("a door's names for its refines are its recorder's REFINES table, by each function's source without its spacing", () => {
  const root = plantedDoor();
  const names = doorRefines('crates/svc-x', root);
  assert.deepEqual(
    [...names],
    [
      ['args=>Object.keys(args).length<=8', 'at_most_eight_keys'],
      ['(args)=>Object.keys(args).length<=8', 'at_most_eight_keys'],
    ],
  );
  assert.equal(names.get(squash('(args) =>\n  Object.keys(args).length <= 8')), 'at_most_eight_keys');
  // A crate with no recorder names none, and nothing is thrown.
  assert.equal(doorRefines('crates/svc-none', root).size, 0);
  assert.equal(wordsOf('at_most_eight_keys'), 'at most eight keys');
});

test("portable: on a door run an input .refine with no message takes the door's name for it; off one, or unnamed by the door, it is left", async () => {
  const { plan } = await import('./portable.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'call-records-door-refine-'));
  const record = join(dir, 'tool-procedures.ts');
  const placeholder = "samples: [{ verdict: 'accept', input: {} }, { verdict: 'refuse', input: 42 }]";
  writeFileSync(
    record,
    [
      "import { z } from 'zod';",
      `export const T = defineProcedure({ name: 'x.tool', input: z.object({ tool: z.string(), input: z.record(z.string(), z.string()).refine(${EIGHT}) }), output: NO_INPUT, ${placeholder} });`,
      `export const U = defineProcedure({ name: 'x.other', input: z.object({ n: z.number().refine((n) => n % 2 === 0) }), output: NO_INPUT, ${placeholder} });`,
      '',
    ].join('\n'),
  );
  const skipped = {
    tool: `x.tool.input cannot be exported without losing meaning: input.input ${REFINE}`,
    other: `x.other.input cannot be exported without losing meaning: input.n ${REFINE}`,
  };
  const doorNames = doorRefines('crates/svc-x', plantedDoor());
  const onDoor = plan(skipped, [record], { door: true, doorNames });
  // The refine the door names is named in the record by that name, with a placeholder sample for it; the other is left.
  assert.deepEqual(onDoor.left, [{ record: 'x.other', at: 'input.n', why: 'its .refine has no message to name the rule by' }]);
  assert.deepEqual(
    [...onDoor.edits.get(record).edits.values()].map((e) => e.text),
    [
      ', checks: { at_most_eight_keys: { at: "input.input", says: "at most eight keys" } }',
      ", { verdict: 'refuse', input: 42, by: 'at_most_eight_keys' }",
    ],
  );
  // Off a door run nothing names it: both are left, as before.
  const off = plan(skipped, [record]);
  assert.equal(off.edits.size, 0);
  assert.deepEqual(
    off.left.map((l) => `${l.at}: ${l.why}`),
    ['input.input: its .refine has no message to name the rule by', 'input.n: its .refine has no message to name the rule by'],
  );
});

test('samples: a check on a .refine with no message gets the input it alone refuses, known by zod’s own words at that very place', async () => {
  const { z } = await contractsZod();
  const input = z.object({
    tool: z.string().min(1),
    input: z.record(z.string().max(64), z.string().max(4000)).refine((args) => Object.keys(args).length <= 8),
  });
  const checks = { at_most_eight_keys: { at: 'input.input', says: 'at most eight keys' } };
  const record = { name: 'x.tool', path: 'p', input, checks };
  const samples = Function(`return ${samplesFor(record, new Map([['p', { tool: 'x', input: {} }]]))}`)();
  const mine = samples.find((s) => s.by === 'at_most_eight_keys');
  // The smallest map tried that the rule refuses: one key more than it allows.
  assert.equal(Object.keys(mine.input.input).length, 9);
  const r = input.safeParse(mine.input);
  assert.equal(r.success, false);
  assert.deepEqual(
    r.error.issues.map((i) => `${i.code} ${i.path.join('.')}`),
    ['custom input'],
  );
  assert.equal(quietRefineAt(input, ['input']), true);
  assert.equal(quietRefineAt(input, ['tool']), false);
  // A quiet refine under an optional and an array is found at its place; a union's option is not followed.
  const nested = z.object({ rows: z.array(z.object({ note: z.string().refine((v) => v !== 'no') })).optional() });
  assert.equal(quietRefineAt(nested, ['rows', '[]', 'note']), true);
  assert.equal(quietRefineAt(nested, ['rows']), false);
  // Near cases. A check named where no quiet refine sits is not given another's refusal: zod's words count only at
  // the place the check sits, so nothing is found and the record is named, never guessed.
  assert.throws(
    () => samplesFor({ ...record, checks: { elsewhere: { at: 'input.tool', says: 'at most eight keys' } } }, new Map([['p', { tool: 'x', input: {} }]])),
    /no input found that input check elsewhere alone refuses/,
  );
  // A refine written with its own message is still known by those words alone, never by zod's.
  const worded = z.object({ note: z.string().refine((v) => v.length >= 3, 'a note is 3 or more characters') });
  assert.throws(
    () => samplesFor({ name: 'x.note', path: 'p', input: worded, checks: { note_holds: { at: 'input.note', says: 'other words' } } }),
    /no input found that input check note_holds alone refuses/,
  );
});

test("a record whose input carries a refine the door names is held to the door's tree once the door's names are read", async () => {
  const { z } = await contractsZod();
  const nodes = [
    { t: 'object', shape: [['input', 1]] },
    { t: 'record', key: 2, value: 2, checks: [{ k: 'refine', id: 'planted_at_most_two_keys' }] },
    { t: 'string' },
  ];
  const input = z.object({ input: z.record(z.string(), z.string()).refine((planted) => Object.keys(planted).length <= 2) });
  assert.notEqual(canon(treeOf(input)), canon(doorTree(nodes, 0)));
  knowRefines(new Map([[squash('(planted) => Object.keys(planted).length <= 2'), 'planted_at_most_two_keys']]));
  assert.equal(canon(treeOf(input)), canon(doorTree(nodes, 0)));
});
