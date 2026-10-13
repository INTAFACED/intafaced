// Proves the local test stack's two safety properties without starting anything:
// local:fund refuses outside its own stack, and the script never supplies a sanctions list.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'local-test-stack.mjs');

function fundWith(home, args = ['someone@example.invalid', 'USDT', '1000']) {
  return spawnSync(process.execPath, [script, 'fund', ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
}

const home = mkdtempSync(join(tmpdir(), 'local-test-stack-test-'));
const state = join(home, '.intafaced', 'local-test-stack');
try {
  // 1. No marker: refuses before reading anything else.
  let r = fundWith(home);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing: marker .* not found/);

  // 2. A marker that is not a local test stack marker.
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'secrets.json'), JSON.stringify({ pgService: 'x' }));
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'something-else', ports: { postgres: 15460 } }));
  r = fundWith(home);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not a local test stack marker/);

  // 3. A hand-edited marker that names another database port (e.g. a shared 5432) is refused.
  //    The real containment is structural: the stack's addresses are fixed to 127.0.0.1:15460
  //    (Postgres) and :14501 (ledger) in the script, and fund also requires our own ledger process.
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'intafaced-local-test-stack', ports: { postgres: 5432 } }));
  r = fundWith(home);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /database is not 127\.0\.0\.1 on the local test stack port/);

  // 4. Correct marker, but this stack's own Postgres is not running.
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'intafaced-local-test-stack', ports: { postgres: 15460 } }));
  r = fundWith(home);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /local stack Postgres is not running/);

  // 5. Money amounts must be plain decimal strings.
  for (const bad of ['1e3', '12.5.1', '-5', '0x10']) {
    r = fundWith(home, ['someone@example.invalid', 'USDT', bad]);
    assert.equal(r.status, 2, `${bad}: ${r.stderr}`);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

// 6. The script never writes a sanctions value of its own: every assignment of the two
// screening variables comes from the caller's environment or the machine-local file.
const source = readFileSync(script, 'utf8');
for (const name of ['INTAFACED_SANCTIONS_REGIONS', 'INTAFACED_SANCTIONS_LIST_SOURCE']) {
  const literal = new RegExp(`${name}\\s*[:=]\\s*['"\`]`);
  assert.equal(literal.test(source), false, `${name} is given a literal value in the script`);
  for (const line of source.split('\n').filter((l) => new RegExp(`${name}\\s*:`).test(l))) {
    assert.match(line, /process\.env\.|file\.(regions|source)/, `unexpected source for ${name}: ${line.trim()}`);
  }
}
assert.equal(/screening\.local\.json/.test(source), true);
assert.equal(/\bZZ\b/.test(source), false, 'the repo script must not carry the ZZ fixture');

console.log('local-test-stack: 6 refusal checks passed');
