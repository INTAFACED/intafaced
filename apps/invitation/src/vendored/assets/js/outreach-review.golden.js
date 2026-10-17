'use strict';
const assert = require('node:assert/strict');
const { formatReviewAmount } = require('./outreach-review.js');
const intake = require('./outreach-intake.js');
const cases = [
  ['5000000', '5,000,000'],
  ['9007199254740993', '9,007,199,254,740,993'],
  [
    '123456789012345678901234567890123456789012345678901234567890',
    '123,456,789,012,345,678,901,234,567,890,123,456,789,012,345,678,901,234,567,890',
  ],
  ['9007199254740993.000000000000000001', '9,007,199,254,740,993.000000000000000001'],
  [
    '1234567890123456789012345678901234567890.123456789012345678',
    '1,234,567,890,123,456,789,012,345,678,901,234,567,890.123456789012345678',
  ],
  ['5000000.120000000000000000', '5,000,000.120000000000000000'],
  ['0.000000000000000001', '0.000000000000000001'],
  ['0.0000', '0.0000'],
  ['999', '999'],
];
for (const [raw, expected] of cases) {
  assert.equal(formatReviewAmount(raw), expected);
  assert.equal(formatReviewAmount(raw).replace(/,/g, ''), raw, 'display grouping is reversible without changing one digit');
  const form = {
    investorType: 'individual',
    participation: 'direct',
    decisionRole: 'decision_maker',
    amountStatus: 'stated',
    amount: raw,
    currency: 'EUR',
    timing: 'undecided',
  };
  const before = JSON.stringify(form);
  assert.equal(
    intake.buildQuestionnaire('investor', form).answers.indicativeContribution.amount,
    raw,
    'original decimal string stays on the wire',
  );
  assert.equal(JSON.stringify(form), before, 'display does not rewrite unsent form fields');
}
for (const invalid of [undefined, null, 5000000, '', '1e6', 'NaN', '1,000', '-1']) assert.equal(formatReviewAmount(invalid), null);
assert.deepEqual(
  intake.buildQuestionnaire('investor', {
    investorType: 'individual',
    participation: 'introduction',
    decisionRole: 'introducer',
    amountStatus: 'undecided',
    timing: 'undecided',
  }).answers.indicativeContribution,
  { status: 'undecided' },
);
console.log('outreach-review.golden: exact integer/fraction/trailing precision, original wire strings and introduction omission passed');
