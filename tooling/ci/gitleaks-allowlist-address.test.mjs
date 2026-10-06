import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Obvious fake hex. Not a secret. 40 hex digits is an address; 64 is a key. */
const ADDRESS = `0x${'ab'.repeat(20)}`;
const PRIVATE_KEY = `0x${'ab'.repeat(32)}`;
const KECCAK_EMPTY = 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const KECCAK_ABC = '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45';

function addressAllowlist() {
  const toml = readFileSync(join(ROOT, '.gitleaks.toml'), 'utf8');
  assert.ok(toml.includes(`'''${KECCAK_EMPTY}'''`), 'Keccak empty digest allowlist entry removed');
  assert.ok(toml.includes(`'''${KECCAK_ABC}'''`), 'Keccak abc digest allowlist entry removed');
  assert.doesNotMatch(toml, /\[0-9a-f\]\{64\}/i, 'blanket 64-hex exemption hides private keys');
  const line = toml.split('\n').find((row) => row.includes('0x[0-9a-f]{40}'));
  assert.ok(line, '.gitleaks.toml is missing the 40-hex address allowlist');
  const quoted = line.match(/'''(.*)'''/);
  assert.ok(quoted, 'address allowlist regex is not a literal string');
  let source = quoted[1];
  let flags = '';
  if (source.startsWith('(?i)')) {
    flags = 'i';
    source = source.slice('(?i)'.length);
  }
  return new RegExp(source, flags);
}

test('gitleaks address allowlist matches a bare 40-hex address and not a 64-hex key', () => {
  const allow = addressAllowlist();
  assert.equal(allow.test(ADDRESS), true, 'bare 0x + 40 hex address must stay allowlisted');
  assert.equal(allow.test(PRIVATE_KEY), false, '0x + 64 hex private key must not match the 40-hex allowlist');
  assert.equal(allow.test(`token = ${ADDRESS}`), true, 'address inside a match must stay allowlisted');
  assert.equal(allow.test(`token = ${PRIVATE_KEY}`), false, 'private key inside a match must not be allowlisted');
});
