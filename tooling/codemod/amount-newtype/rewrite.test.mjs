// node --test tooling/codemod/amount-newtype/rewrite.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amountFor, filesMissingImport, literalSites, withImport } from './rewrite.mjs';

test('a literal becomes the money it names: zero, whole units, or a scaled integer', () => {
  assert.equal(amountFor('0'), 'Amount::ZERO');
  assert.equal(amountFor('0i128'), 'Amount::ZERO');
  assert.equal(amountFor('5_000_000_000_000_000_000'), 'Amount::whole(5)');
  assert.equal(amountFor('1_234_000_000_000_000_000_000'), 'Amount::whole(1_234)');
  assert.equal(amountFor('-2000000000000000000'), '-Amount::whole(2)');
  assert.equal(amountFor('1_500'), 'Amount::from_scaled(1_500)');
  assert.equal(amountFor('x + 1'), null);
  assert.equal(amountFor('tokens'), null);
});

/** One cargo JSON error line whose span `text` holds `line` and highlights `[from, to)` (1-based columns). */
function mismatch(label, line, from, to, primary = true) {
  const start = 100;
  return JSON.stringify({
    reason: 'compiler-message',
    message: {
      level: 'error',
      spans: [
        {
          is_primary: primary,
          label,
          file_name: 'crates/svc-x/src/a.rs',
          byte_start: start,
          byte_end: start + (to - from),
          line_start: 3,
          line_end: 3,
          text: [{ text: line, highlight_start: from, highlight_end: to }],
        },
      ],
    },
  });
}

test('only a literal the compiler says should be money is rewritten, in a mismatch or as an argument', () => {
  const lines = [
    mismatch('expected `Amount`, found integer', 'let a: Amount = 0;', 17, 18),
    mismatch('expected `service_kit::money::Amount`, found integer', 'fee(7);', 5, 6, false),
    mismatch('expected `Amount`, found integer', 'let a: Amount = n;', 17, 18),
    mismatch('expected `Option<Amount>`, found `Option<{integer}>`', 'x = Some(3);', 5, 12),
    mismatch('expected `i128`, found `Amount`', 'let n: i128 = 0;', 15, 16),
  ];
  const sites = literalSites(lines.join('\n'));
  assert.deepEqual(
    sites.map((s) => s.to),
    ['Some(Amount::from_scaled(3))'],
    'the same byte range keeps the last site; a name and a non-money mismatch are left to the author',
  );
  assert.deepEqual(
    literalSites(lines[0]).map((s) => s.to),
    ['Amount::ZERO'],
  );
  assert.deepEqual(
    literalSites(lines[1]).map((s) => s.to),
    ['Amount::from_scaled(7)'],
  );
});

test('a file that names Amount without importing it gets the import from its own crate', () => {
  const err = JSON.stringify({
    reason: 'compiler-message',
    message: {
      level: 'error',
      spans: [{ is_primary: true, label: 'use of undeclared type `Amount`', file_name: 'crates/svc-x/src/b.rs' }],
    },
  });
  assert.deepEqual(filesMissingImport(err), ['crates/svc-x/src/b.rs']);
  assert.equal(
    withImport('//! doc\nuse std::fmt;\nfn f() {}\n', 'crates/svc-x/src/b.rs'),
    '//! doc\nuse service_kit::money::Amount;\nuse std::fmt;\nfn f() {}\n',
  );
  assert.equal(withImport('//! doc\n\nfn f() {}\n', 'crates/service-kit/src/c.rs'), '//! doc\n\nuse crate::money::Amount;\nfn f() {}\n');
});
