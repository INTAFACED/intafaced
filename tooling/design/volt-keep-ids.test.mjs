// A Volt batch keeps every element id a journey test finds by (volt-keep-ids.mjs, #9433).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ALLOWED, keepIds, readRepo } from './volt-keep-ids.mjs';

const FAIL =
  'a journey test finds an element by an id no source renders any more: put the test id, data-cell or data-col back on the element (a journey test changes only in a PR that names its step and proves it again)';

test("every id a journey test finds by is still in the source, and the list of today's unheld ids is tight", () => {
  const r = keepIds(readRepo(), JSON.parse(readFileSync(ALLOWED, 'utf8')));
  assert.ok(r.used > 0, 'no journey ids read: the reader is broken, not the rooms');
  assert.deepEqual(r.missing, [], FAIL);
  assert.deepEqual(r.stale, [], 'held now, or no journey uses it: run `node tooling/design/volt-keep-ids.mjs --write`');
});

test('a room that drops a test id or a data-cell fails; a template-built id and an allowed one pass; a cell word quoted elsewhere does not hold it', () => {
  const tests = [
    [
      'J-x-01.pw.mjs',
      "page.getByTestId('send-note'); page.locator('[data-testid=\"send-row\"]'); page.locator('[data-cell=held-back]'); page.getByTestId('outline-item-0-2'); page.locator('[data-col=amount]'); page.getByTestId('old-one');",
    ],
  ];
  const room = '<p data-testid="send-note" /><tr data-testid="send-row"><td data-cell="held-back" /><td data-col="amount" /></tr>';
  const kit = 'const id = `outline-item-${i}-${j}`;';
  const before = keepIds({ tests, texts: [room, kit] }, ['testid old-one']);
  assert.deepEqual(before.missing, []);
  assert.deepEqual(before.stale, []);

  const after = keepIds(
    {
      tests,
      texts: [
        room.replace(' data-testid="send-note"', '').replace(' data-cell="held-back"', '').replace(' data-col="amount"', ''),
        kit,
        "const k = 'amount';",
      ],
    },
    ['testid old-one'],
  );
  assert.deepEqual([...after.missing].sort(), [
    'cell held-back (J-x-01.pw.mjs)',
    'col amount (J-x-01.pw.mjs)',
    'testid send-note (J-x-01.pw.mjs)',
  ]);

  // An allowed id the source now holds is stale: the list only shrinks.
  assert.deepEqual(keepIds({ tests, texts: [room, kit, "'old-one'"] }, ['testid old-one']).stale, ['testid old-one']);
});
