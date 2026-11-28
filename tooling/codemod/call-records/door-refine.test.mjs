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
import { committedRecords, samplesFor } from './samples.mjs';

/** The zod the records use: the one @intafaced/contracts resolves. */
const contractsZod = () =>
  import(pathToFileURL(createRequire(new URL('../../../packages/contracts/package.json', import.meta.url)).resolve('zod')).href);

const REFINE = '(.refine/.superRefine (a TypeScript predicate the export drops))';
const EIGHT = '(args) => Object.keys(args).length <= 8';

/**
 * A planted crate whose recorder names one refine as tsx prints it (`args=>…`, no parentheses), as svc-bank's names
 * `value=>Object.keys(value).length<=8`, beside a table that is not the refines'.
 */
function plantedDoor() {
  const root = mkdtempSync(join(tmpdir(), 'call-records-door-refine-'));
  mkdirSync(join(root, 'crates/svc-x/scripts'), { recursive: true });
  writeFileSync(
    join(root, 'crates/svc-x/scripts/record-door.mjs'),
    [
      "const OTHER = { '(v) => v > 0': 'not_a_refine' };",
      'const REFINES = {',
      "  'args=>Object.keys(args).length<=8': 'at_most_eight_keys',",
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
  assert.deepEqual([...names], [['args=>Object.keys(args).length<=8', 'at_most_eight_keys']]);
  // The refine as a record file writes it, its lone parameter in parentheses, takes the name the table gave the other
  // printing: svc-bank's `recipient` was left by hand for this.
  assert.equal(names.get(squash('(args) =>\n  Object.keys(args).length <= 8')), 'at_most_eight_keys');
  assert.equal(squash('(a, b) => a'), '(a,b)=>a');
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
    () =>
      samplesFor(
        { ...record, checks: { elsewhere: { at: 'input.tool', says: 'at most eight keys' } } },
        new Map([['p', { tool: 'x', input: {} }]]),
      ),
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

test('a block-bodied refine the door names is held to the door whether or not its last statement ends with a semicolon', async () => {
  const { z } = await contractsZod();
  const nodes = [
    { t: 'object', shape: [['from', 1]] },
    { t: 'string', checks: [{ k: 'refine', id: 'planted_real_day' }] },
  ];
  const input = z.object({
    from: z.string().refine((day) => {
      const at = new Date(`${day}T00:00:00.000Z`);
      return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === day;
    }),
  });
  // The recorder's key is esbuild's: no space, and no semicolon before the closing brace (svc-bank's calendar_day).
  knowRefines([
    [
      'day=>{const at=new Date(`${day}T00:00:00.000Z`);return!Number.isNaN(at.getTime())&&at.toISOString().slice(0,10)===day}',
      'planted_real_day',
    ],
  ]);
  assert.equal(canon(treeOf(input)), canon(doorTree(nodes, 0)));
});

// svc-bank's last calls by name (weed project-state#3724): each shape below left a record by hand until the step read it.

test('portable: a refine on the schema a .pipe starts from is named, and a shape built from a closed list of keys is followed', async () => {
  const { plan } = await import('./portable.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'call-records-pipe-'));
  const record = join(dir, 'bank-procedures.ts');
  const placeholder = "samples: [{ verdict: 'accept', input: {} }, { verdict: 'refuse', input: 42 }]";
  writeFileSync(
    record,
    [
      "import { z } from 'zod';",
      "const plainWords = z.string().refine((value) => ![...value].some((c) => c < ' '), 'text has a control character');",
      "const KEYS = ['programme', 'fees'] as const;",
      'const setting = z.object({ value: z.unknown(), version: z.number() }).nullable();',
      'const settings = z.object(Object.fromEntries(KEYS.map((k) => [k, setting])) as Record<(typeof KEYS)[number], typeof setting>);',
      `export const N = defineProcedure({ name: 'bank.note', input: z.object({ text: plainWords.pipe(z.string().max(500)).optional() }), output: NO_INPUT, ${placeholder} });`,
      `export const D = defineProcedure({ name: 'bank.desk', input: NO_INPUT, output: z.object({ settings }), ${placeholder} });`,
      // What it pipes into carries its own refine: which one the export means is not known, so it is left.
      `export const P = defineProcedure({ name: 'bank.both', input: z.object({ text: plainWords.pipe(z.string().refine((v) => v !== 'no', 'not no')) }), output: NO_INPUT, ${placeholder} });`,
      '',
    ].join('\n'),
  );
  const skipped = {
    note: `bank.note.input cannot be exported without losing meaning: input.text ${REFINE}`,
    desk: 'bank.desk.output cannot be exported without losing meaning: bank.desk.output.settings.fees.value (z.unknown (no shape: accepts anything))',
    both: `bank.both.input cannot be exported without losing meaning: input.text ${REFINE}`,
  };
  const { edits, left } = plan(skipped, [record], { door: true, doorNames: new Map() });
  const texts = [...edits.get(record).edits.values()].map((e) => e.text);
  assert.ok(
    texts.includes(', checks: { plain_words_holds: { at: "input.text", says: "text has a control character" } }'),
    texts.join('\n'),
  );
  assert.ok(texts.includes('jsonValueSchema'), texts.join('\n'));
  assert.deepEqual(left, [{ record: 'bank.both', at: 'input.text', why: "its refinement is not a .refine written in the schema's chain" }]);
});

test("samples: a check is found in a union's option, a rule across keys by taking keys out, and plain words by a control character", async () => {
  const { z } = await contractsZod();
  const recipient = z.record(z.string().max(64), z.string().max(254)).refine((value) => Object.keys(value).length <= 8);
  const from = { fromSpaceId: z.string(), amount: z.string() };
  const send = z.union([z.object({ ...from, rail: z.string(), recipient }).strict(), z.object({ ...from, payeeId: z.string() }).strict()]);
  assert.equal(quietRefineAt(send, ['recipient']), true);
  const typed = { fromSpaceId: 'a', amount: '1.50', rail: 'ach', recipient: { holderName: 'Ada TEST' } };
  const checks = { at_most_eight_keys: { at: 'input|0.recipient', says: 'at most eight keys' } };
  const sent = Function(`return ${samplesFor({ name: 'bank.send', path: 'p', input: send, checks }, new Map([['p', typed]]))}`)();
  assert.equal(Object.keys(sent.find((s) => s.by === 'at_most_eight_keys').input.recipient).length, 9);

  const plainWords = z.string().refine((value) => ![...value].some((c) => c < ' '), 'text has a control character');
  const note = z
    .object({
      id: z.string(),
      text: plainWords.pipe(z.string().min(1)).optional(),
      reportDescription: plainWords.pipe(z.string()).optional(),
    })
    .strict()
    .refine((v) => v.text !== undefined || v.reportDescription !== undefined, { message: 'send a note or a report description' });
  const noteChecks = {
    note_or_report: { at: 'input', says: 'send a note or a report description' },
    plain_words_holds: { at: ['input.text', 'input.reportDescription'], says: 'text has a control character' },
  };
  const out = Function(
    `return ${samplesFor({ name: 'bank.note', path: 'p', input: note, checks: noteChecks }, new Map([['p', { id: 'x', reportDescription: 'TEST rent' }]]))}`,
  )();
  assert.deepEqual(out.find((s) => s.by === 'note_or_report').input, { id: 'x' });
  assert.equal(out.find((s) => s.by === 'plain_words_holds').input.text, 'x\ny');
});

test("door-check: a pipe is held as the door's recorder writes one, and refines compare in one printing", async () => {
  const { z } = await contractsZod();
  const plain = z.string().refine((value) => value.text !== undefined, 'words');
  knowRefines(new Map([['value=>value.text!==void 0', 'planted_has_text']]));
  const nodes = [
    { t: 'pipe', in: 1, out: 2 },
    { t: 'string', checks: [{ k: 'refine', id: 'planted_has_text', msg: 'words' }] },
    { t: 'string', checks: [{ k: 'max_length', n: 5 }] },
  ];
  assert.equal(canon(treeOf(plain.pipe(z.string().max(5)))), canon(doorTree(nodes, 0)));
  assert.equal(squash('(day) => {\n  return day;\n}'), squash('day=>{return day}'));
});

test('samples: the records a file held before the run are not this run’s, even ones whose samples read like the placeholder', () => {
  const held = committedRecords('packages/contracts/src/bank-ops-2-procedures.ts');
  assert.ok(held.has('BANK_OPS_CARD_PROGRAMME'), [...held].join(', '));
  assert.equal(committedRecords('packages/contracts/src/no-such-procedures.ts').size, 0);
});
