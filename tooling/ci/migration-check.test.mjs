import test from 'node:test';
import assert from 'node:assert/strict';
import { namingProblems } from './migration-check.mjs';

const now = Date.UTC(2026, 9, 23, 22, 0, 0);
const main = new Set(['0060_a.sql', '0061_b.sql']);
const check = (ups, onMain = main) => namingProblems(ups, onMain, now).map((p) => p.file);

const cases = [
  ['a stamped migration passes', () => check(['0060_a.sql', '0061_b.sql', '20261023213000_c.sql']), []],
  ['two PRs stamped out of merge order both pass', () => check(['20261023100000_x.sql'], new Set([...main, '20261023110000_y.sql'])), []],
  ['a four-digit name above main passes while main has no stamped one', () => check(['0062_c.sql']), []],
  ["a four-digit name at main's highest fails", () => check(['0061_c.sql']), ['0061_c.sql']],
  [
    'a four-digit name fails once main has a stamped one',
    () => check(['0099_c.sql'], new Set([...main, '20261023110000_y.sql'])),
    ['0099_c.sql'],
  ],
  ['a date that does not exist fails', () => check(['20261332000000_c.sql']), ['20261332000000_c.sql']],
  ['a stamp more than a day ahead fails', () => check(['20261025000000_c.sql']), ['20261025000000_c.sql']],
  ['a stamp before the rule began fails', () => check(['01261023213000_c.sql']), ['01261023213000_c.sql']],
  ['an upper-case name fails', () => check(['20261023213000_Bad.sql']), ['20261023213000_Bad.sql']],
  ['files already on main are never judged', () => check(['0060_a.sql']), []],
  ['main not fetched judges nothing', () => check(['0001_c.sql'], null), []],
];

for (const [name, got, want] of cases) {
  test(`migration naming: ${name}`, () => assert.deepEqual(got(), want));
}
