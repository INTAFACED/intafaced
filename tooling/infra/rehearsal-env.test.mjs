/**
 * The stack rehearsal's settings (#9166): every dev-only secret and every published database password is replaced,
 * production posture is set, and each rotated role gets one ALTER ROLE. Against the real .env.example and compose file,
 * so a new dev-only secret or a new database password cannot be missed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSTURE, TEST_STAND_INS, rehearsalEnv, rolesSql } from './rehearsal-env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
let n = 0;
const random = () => `r${++n}`.padEnd(64, '0');
const { env, roles, generated, standIns } = rehearsalEnv({ example, compose, random });

test('no dev-only secret survives', () => {
  const left = [...env].filter(([, v]) => v.replace(/^["']/, '').startsWith('dev-only-'));
  assert.deepEqual(left, []);
  assert.ok(generated.includes('INTERNAL_SERVICE_SECRET'));
});

test('production posture is set', () => {
  for (const [k, v] of Object.entries(POSTURE)) assert.equal(env.get(k), v);
});

test('every database password compose reads is fresh and its role rotated', () => {
  const names = [...new Set([...compose.matchAll(/\$\{(SVC_[A-Z0-9_]+_DB_PASSWORD):-/g)].map((m) => m[1]))];
  assert.ok(names.includes('SVC_OPS_DB_PASSWORD'), 'svc-ops connects with a rotatable password');
  assert.ok(names.includes('SVC_P2P_DB_PASSWORD'), 'a role name with a digit is rotated too');
  assert.deepEqual(roles.map((r) => r.name).sort(), names.sort());
  for (const { role, name } of roles) {
    assert.equal(role, `svc_${name.slice(4, -12).toLowerCase()}`);
    assert.notEqual(env.get(name), role);
  }
  const sql = rolesSql(env, roles);
  assert.equal(sql.trim().split('\n').length, roles.length);
  assert.match(sql, new RegExp(`ALTER ROLE svc_ledger PASSWORD '${env.get('SVC_LEDGER_DB_PASSWORD')}';`));
});

test('a secret from the runner wins; a blank one leaves the example', () => {
  const out = rehearsalEnv({ example: 'A=1\nB=dev-only-x\n', compose: '', random, extra: { A: 'set', C: undefined } });
  assert.equal(out.env.get('A'), 'set');
  assert.equal(out.env.has('C'), false);
  assert.notEqual(out.env.get('B'), 'dev-only-x');
});

test('every variable compose requires has a value, and a stand-in only where the example is blank', () => {
  const required = [...new Set([...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]))];
  for (const name of required) assert.ok(env.get(name), `${name} is required by compose and blank`);
  for (const name of standIns) assert.equal(env.get(name), TEST_STAND_INS[name]);
  const owner = rehearsalEnv({ example: 'EDGE_RATE_LIMIT_MAX=7\n', compose: '', random });
  assert.equal(owner.env.get('EDGE_RATE_LIMIT_MAX'), '7');
  assert.ok(!owner.standIns.includes('EDGE_RATE_LIMIT_MAX'));
});

test('no service connects with a password compose cannot rotate', () => {
  assert.deepEqual(compose.match(/postgres:\/\/(svc_[a-z0-9_]+):\1@/g) ?? [], []);
});

test('the screening list reaches every service, not only the edge', () => {
  const block = compose.slice(
    compose.indexOf('x-service-env: &service-env'),
    compose.indexOf('\nx-', compose.indexOf('x-service-env: &service-env') + 1),
  );
  for (const name of ['INTAFACED_SANCTIONS_REGIONS', 'INTAFACED_SANCTIONS_LIST_SOURCE'])
    assert.match(block, new RegExp(`\\n  ${name}: \\$\\{${name}:-\\}`));
});
