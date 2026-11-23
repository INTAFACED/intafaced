// The call-record export reaching the CI review as its records' changes (ci-review.mjs summarizeExports, through
// summarizeGenerated): the moves of intafaced #9313 (weed project-state#3522: one 2,561,955-byte hunk, refused whole),
// planted changes that must show in full, and every section that must stay whole, byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blobId, MAX_DIFF_BYTES, splitDiff, summarizeGenerated, SUMMARY_RUN } from './ci-review.mjs';

const OLD = 'packages/contracts/procedures.schema.json';
const svc = (s) => `packages/contracts/procedures/${s}.schema.json`;
const COMMENT = 'Written by `procedures:write`; held by its drift test. Do not edit by hand.';
const text = (procedures) => `${JSON.stringify({ $comment: COMMENT, procedures }, null, 2)}\n`;
const id = (t) => blobId(t).slice(0, 10);

// A record about the size of a real one, so the old file's deletion is over the cap as on #9313.
const record = (service, name) => ({
  service,
  module: service.slice(4),
  transport: 'trpc',
  kind: 'query',
  path: name,
  access: { caller: 'scope', scope: `${service.slice(4)}:read`, module: service.slice(4) },
  refusals: { [`${service.slice(4)}.not_found`]: 'NOT_FOUND' },
  input: {
    type: 'object',
    properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}$' } },
    required: ['id'],
    additionalProperties: false,
  },
  output: { type: 'object', properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, { type: 'string' }])) },
});
const SERVICES = ['svc-academy', 'svc-bank', 'svc-tax'];
const ALL = Object.fromEntries(
  SERVICES.flatMap((s) => Array.from({ length: 80 }, (_, i) => [`${s.slice(4)}.call${String(i).padStart(2, '0')}`, record(s, `call${i}`)])),
);
const of = (s, all = ALL) => Object.fromEntries(Object.entries(all).filter(([, r]) => r.service === s));

const lines = (t) => t.replace(/\n$/, '').split('\n');
const added = (path, t) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000000..${id(t)}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines(t).length} @@\n${lines(
    t,
  )
    .map((l) => `+${l}`)
    .join('\n')}\n`;
const deleted = (path, t) =>
  `diff --git a/${path} b/${path}\ndeleted file mode 100644\nindex ${id(t)}..0000000000\n--- a/${path}\n+++ /dev/null\n@@ -1,${lines(t).length} +0,0 @@\n${lines(
    t,
  )
    .map((l) => `-${l}`)
    .join('\n')}\n`;
// A file changed in place, as one hunk of every line: its two sides are read as blobs, by the ids on its index line.
const changed = (path, a, b) =>
  `diff --git a/${path} b/${path}\nindex ${id(a)}..${id(b)} 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${lines(a).length} +1,${lines(b).length} @@\n${[
    ...lines(a).map((l) => `-${l}`),
    ...lines(b).map((l) => `+${l}`),
  ].join('\n')}\n`;
const blobs = (...texts) => {
  const m = new Map(texts.map((t) => [id(t), t]));
  return (b) => m.get(b) ?? null;
};
const CODE =
  'diff --git a/packages/contracts/src/procedure.ts b/packages/contracts/src/procedure.ts\nindex 1..2 100644\n@@ -1 +1 @@\n-a\n+b\n';

/** The split of #9313: the one file deleted, one file per service added, every record unchanged. */
const split = (now = ALL) => [deleted(OLD, text(ALL)), ...SERVICES.map((s) => added(svc(s), text(of(s, now))))].join('');

test('the export split of #9313 reaches the review as moves, under the cap, and every record is named on both files', () => {
  const diff = CODE + split() + CODE;
  assert.ok(Buffer.byteLength(deleted(OLD, text(ALL))) > MAX_DIFF_BYTES, 'the deletion alone is one hunk over the cap, as on #9313');
  assert.match(splitDiff(diff).tooLarge, /one hunk of packages\/contracts\/procedures\.schema\.json is \d+ bytes, over 400000/);
  const out = summarizeGenerated(diff);
  assert.ok(Buffer.byteLength(out) < 30_000, `${Buffer.byteLength(out)} bytes`);
  assert.ok(out.startsWith(CODE) && out.endsWith(CODE), 'the code around it is kept byte for byte');
  assert.equal(splitDiff(out).parts.length, 1, 'one call: no parts needed');
  for (const s of SERVICES) {
    const names = JSON.stringify(Object.keys(of(s)));
    assert.ok(out.split('\n').includes(`> 80 records moved unchanged to ${svc(s)}: ${names}`), `${s} out`);
    assert.ok(out.split('\n').includes(`< 80 records moved here unchanged from ${OLD}: ${names}`), `${s} in`);
  }
  // Nothing else is said of the records: no + or - or ~ line names one.
  assert.equal(out.split('\n').filter((l) => /^[+~-] "[a-z]+\.call/.test(l)).length, 0);
  // Each file keeps its own section and git's header lines, so a review in parts names every file.
  assert.ok(
    out.includes(
      `diff --git a/${OLD} b/${OLD}\ndeleted file mode 100644\nindex ${id(text(ALL))}..0000000000\n[generated call-record export`,
    ),
  );
  assert.ok(out.includes(`- "$comment" ${JSON.stringify(COMMENT)}`) && out.includes(`+ "$comment" ${JSON.stringify(COMMENT)}`));
  assert.match(out, /240 records before and 0 after in this file/);
});

test('planted on the split: a changed input, a record deleted and one added by hand each show in full', () => {
  const now = structuredClone(ALL);
  now['tax.call07'].input.properties.planted = { type: 'number' };
  const gone = now['bank.call03'];
  delete now['bank.call03'];
  now['academy.byHand'] = { service: 'svc-academy', path: 'byHand', access: { caller: 'public' } };
  const out = summarizeGenerated(split(now)).split('\n');
  for (const line of [
    `~ "tax.call07": moved here from ${OLD}, and changed:`,
    '+ "tax.call07"."input"."properties"."planted" {"type":"number"}',
    `> 1 record moved to ${svc('svc-tax')} and changed, the changes shown there: ["tax.call07"]`,
    `- "bank.call03" ${JSON.stringify(gone)}`,
    `+ "academy.byHand" ${JSON.stringify(now['academy.byHand'])}`,
  ])
    assert.ok(out.includes(line), line);
  // The moved lists no longer hold them.
  assert.ok(!out.some((l) => l.startsWith('<') && /"tax\.call07"|"bank\.call03"/.test(l)));
  assert.ok(out.includes(`< 79 records moved here unchanged from ${OLD}: ${JSON.stringify(Object.keys(of('svc-bank', now)))}`));
});

test('an export file changed in place is read from its two blobs: every change shows, and a record moved between two files', () => {
  const a = { tax: text(of('svc-tax')), bank: text(of('svc-bank')) };
  const taxNow = structuredClone(of('svc-tax'));
  taxNow['tax.call01'].access.scope = 'tax:write';
  const moving = structuredClone(of('svc-bank'));
  taxNow['bank.call09'] = moving['bank.call09'];
  delete moving['bank.call09'];
  const b = { tax: text(taxNow), bank: text(moving) };
  const diff = changed(svc('svc-tax'), a.tax, b.tax) + changed(svc('svc-bank'), a.bank, b.bank);
  const out = summarizeGenerated(diff, { readBlob: blobs(a.tax, b.tax, a.bank, b.bank) }).split('\n');
  for (const line of [
    '~ "tax.call01"."access"."scope": "tax:read" -> "tax:write"',
    `< 1 record moved here unchanged from ${svc('svc-bank')}: ["bank.call09"]`,
    `> 1 record moved unchanged to ${svc('svc-tax')}: ["bank.call09"]`,
  ])
    assert.ok(out.includes(line), line);
  // Without the blobs, or with a blob that isn't the one the index line names, the sections stay whole.
  assert.equal(summarizeGenerated(diff), diff);
  assert.equal(summarizeGenerated(diff, { readBlob: () => a.tax }), diff);
  assert.equal(
    summarizeGenerated(diff, {
      readBlob: () => {
        throw new Error('no such blob');
      },
    }),
    diff,
  );
});

test('a name in two files of one side is shown whole on each, and a key order change is a change', () => {
  const twice = [
    deleted(OLD, text(ALL)),
    added(svc('svc-tax'), text(of('svc-tax'))),
    added(svc('svc-bank'), text({ ...of('svc-bank'), 'tax.call00': ALL['tax.call00'] })),
  ];
  const out = summarizeGenerated(twice.join('')).split('\n');
  assert.ok(out.includes('! "tax.call00" is in 1 old and 2 new export files: each shown whole'));
  assert.equal(out.filter((l) => l === `+ "tax.call00" ${JSON.stringify(ALL['tax.call00'])}`).length, 2);
  assert.ok(out.includes(`- "tax.call00" ${JSON.stringify(ALL['tax.call00'])}`));
  const { service, ...rest } = ALL['tax.call00'];
  const reordered = { ...of('svc-tax'), 'tax.call00': { ...rest, service } };
  const moved = summarizeGenerated(deleted(OLD, text(ALL)) + added(svc('svc-tax'), text(reordered))).split('\n');
  assert.ok(moved.some((l) => l.startsWith('~ "tax.call00": the same entries in another order {"service"')));
});

test('a summary over the cap is parted between its @@ lines, and nothing is left out', () => {
  // Every record new, none moved: the summary is the records themselves, over the cap in one file.
  const many = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`academy.n${i}`, record('svc-academy', `n${i}`)]));
  const out = summarizeGenerated(added(svc('svc-academy'), text(many)));
  assert.ok(Buffer.byteLength(out) > MAX_DIFF_BYTES);
  const { parts } = splitDiff(out);
  assert.ok(parts.length > 1, 'parted');
  const body = parts.join('').split('\n');
  for (const [n, r] of Object.entries(many)) assert.ok(body.includes(`+ "${n}" ${JSON.stringify(r)}`), n);
  for (const p of parts)
    assert.match(p, /^diff --git a\/packages\/contracts\/procedures\/svc-academy\.schema\.json .*\n.*\n.*\n\[generated call-record export/);
  const runs = out.split('\n').filter((l) => l.startsWith('@@ summary lines '));
  assert.ok(runs.length >= Math.ceil(Buffer.byteLength(out) / SUMMARY_RUN), `${runs.length} runs`);
  assert.match(runs.at(-1), /^@@ summary lines \d+-901 of 901 @@$/);
});

test('a section not read exactly as the export stays whole, byte for byte, as every other file does', () => {
  const t = text(of('svc-tax'));
  const one = (s) =>
    summarizeGenerated(deleted(OLD, text(ALL)) + s)
      .split(/^(?=diff --git )/m)
      .at(-1);
  const whole = (s, why) => assert.equal(one(s), s, why);
  // Another path, or a rename into or out of an export path from elsewhere.
  whole(added('packages/contracts/src/procedures.schema.json', t), 'not an export path');
  whole(added('packages/contracts/procedures/nested/svc-tax.schema.json', t), 'a deeper path');
  whole(
    added(svc('svc-tax'), t).replaceAll(`a/${svc('svc-tax')} b/${svc('svc-tax')}`, `a/docs/x.json b/${svc('svc-tax')}`),
    'a rename from elsewhere',
  );
  // Not this export's text: not JSON, another top-level key, a repeated key, a string written another way, a comment.
  whole(added(svc('svc-tax'), t.replace('{\n  "$comment"', '{\n  "$comment" oops')), 'not JSON');
  whole(added(svc('svc-tax'), `${JSON.stringify({ $comment: COMMENT, procedures: of('svc-tax'), extra: 1 }, null, 2)}\n`), 'another key');
  whole(added(svc('svc-tax'), `${JSON.stringify({ procedures: of('svc-tax'), $comment: COMMENT }, null, 2)}\n`), 'keys in another order');
  whole(
    added(svc('svc-tax'), t.replace('"procedures": {', '"procedures": {\n    "tax.call00": {"hidden": true},')),
    'a repeated record name',
  );
  whole(added(svc('svc-tax'), t.replace('"trpc"', '"trp\\u0063"')), 'a string escaped another way');
  whole(added(svc('svc-tax'), `${JSON.stringify({ $comment: COMMENT, procedures: { x: [1] } }, null, 2)}\n`), 'a record not a map');
  // Not read exactly: an index line that is not its blob, a second hunk, a line of the other sign, a copy, no index.
  whole(added(svc('svc-tax'), t).replace(`..${id(t)}`, '..0123456789'), 'another blob');
  whole(`${added(svc('svc-tax'), t)}@@ -9 +9 @@\n+x\n`, 'a second hunk');
  whole(added(svc('svc-tax'), t).replace('\n+  "procedures"', '\n   "procedures"'), 'a context line');
  whole(added(svc('svc-tax'), t).replace('new file mode 100644\n', `new file mode 100644\ncopy from ${OLD}\n`), 'a copy');
  whole(added(svc('svc-tax'), t).replace(/index .*\n/, ''), 'no index line');
  const rename = `diff --git a/${OLD} b/${svc('svc-tax')}\nsimilarity index 100%\nrename from ${OLD}\nrename to ${svc('svc-tax')}\n`;
  assert.equal(summarizeGenerated(rename), rename, 'a rename with no change stays as git wrote it');
  // A summary no smaller than its sections: the whole diff stays as it was.
  const tiny = added(svc('svc-ws'), text({}));
  assert.equal(summarizeGenerated(tiny), tiny);
  // A diff with no export file is returned unchanged.
  assert.equal(summarizeGenerated(CODE), CODE);
});
