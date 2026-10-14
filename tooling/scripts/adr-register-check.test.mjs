// Run: node tooling/scripts/adr-register-check.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRegister, REGISTER_COLUMNS } from '../ci/adr-register-check.mjs';
import { readAdrs, renderIndex } from './adr-index.mjs';

const HEADER = `| ${REGISTER_COLUMNS.join(' | ')} |\n| ${REGISTER_COLUMNS.map(() => '---').join(' | ')} |\n`;
const row = (adr, rule = 'A rule') => `| ${rule} | v | hard | chat 3 1 | ${adr} | 2026-10-14 | 2027-01-14 |\n`;

/** Builds a tree: accepted + proposed ADR, a current README, and the given register body. */
function tree({ register = HEADER, readme = 'current', adrs = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adr-register-'));
  mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  if (adrs) {
    writeFileSync(join(root, 'docs/adr/2026-10-01-good.md'), '# Good\n**Status:** accepted\n');
    writeFileSync(join(root, 'docs/adr/2026-10-02-draft.md'), '# Draft\n**Status:** proposed\n');
  }
  if (readme === 'current') writeFileSync(join(root, 'docs/adr/README.md'), renderIndex(readAdrs(join(root, 'docs/adr'))));
  if (readme === 'stale') writeFileSync(join(root, 'docs/adr/README.md'), '# old index\n');
  if (register !== null) writeFileSync(join(root, 'docs/POLICY-REGISTER.md'), `intro text\n\n${register}\nafter\n`);
  return root;
}
const check = (opts) => {
  const root = tree(opts);
  try {
    return checkRegister(root).problems;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

// an EMPTY register over real ADRs is valid
assert.deepEqual(check(), []);
// a row linking an accepted ADR passes (plain link, anchor link, relative path)
assert.deepEqual(check({ register: HEADER + row('[why](adr/2026-10-01-good.md)') }), []);
assert.deepEqual(check({ register: HEADER + row('[why](adr/2026-10-01-good.md#decision)') }), []);
// a proposed ADR cannot back a rule
assert.match(check({ register: HEADER + row('[x](adr/2026-10-02-draft.md)') }).join('\n'), /is proposed\. Only accepted/);
// a missing ADR, a non-ADR file, a missing link, a wrong column count all fail
assert.match(check({ register: HEADER + row('[x](adr/2026-10-09-nope.md)') }).join('\n'), /not an ADR in docs\/adr/);
assert.match(check({ register: HEADER + row('[x](adr/README.md)') }).join('\n'), /not an ADR in docs\/adr/);
assert.match(check({ register: HEADER + row('none yet') }).join('\n'), /no link to a \.md file/);
assert.match(check({ register: HEADER + '| only | three | cells |\n' }).join('\n'), /3 columns, expected 7/);
// a stale or missing README fails
assert.match(check({ readme: 'stale' }).join('\n'), /README\.md is missing or stale/);
assert.match(check({ readme: 'none' }).join('\n'), /README\.md is missing or stale/);
// an unreadable header must fail rather than read as "zero rows"
assert.match(check({ register: '| Rule | Value |\n| --- | --- |\n' }).join('\n'), /header row must be exactly/);
assert.match(check({ register: 'no table here\n' }).join('\n'), /header row must be exactly/);
// the denominators: no register file, no ADRs
assert.match(check({ register: null }).join('\n'), /POLICY-REGISTER\.md does not exist/);
assert.match(check({ adrs: false, readme: 'none' }).join('\n'), /docs\/adr has no ADR files/);

// CLI: exits 1 over an empty directory, 0 over the real repo
const script = fileURLToPath(new URL('../ci/adr-register-check.mjs', import.meta.url));
const empty = mkdtempSync(join(tmpdir(), 'adr-register-empty-'));
try {
  const r = spawnSync(process.execPath, [script], { cwd: empty, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/adr has no ADR files/);
} finally {
  rmSync(empty, { recursive: true, force: true });
}
const real = spawnSync(process.execPath, [script], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' });
assert.equal(real.status, 0, real.stderr);

console.log('adr-register-check tests OK');
