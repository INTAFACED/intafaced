/**
 * ci-tests.mjs: a builder's machine runs CI's unit selection with CI's database environment, read from CI's files.
 * Run: node --test tooling/scripts/ci-tests.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOCAL_KEYS, ciSchemaProof, ciTestEnv } from './ci-tests.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ACTION = readFileSync(ROOT + '.github/actions/test-infra/action.yml', 'utf8');

test("CI's database environment is read from the test-infra action, every per-service URL included", () => {
  const { env, skipped } = ciTestEnv(ACTION);
  assert.equal(env.REQUIRE_POSTGRES, '1', 'a database suite fails instead of skipping');
  assert.match(env.TEST_DATABASE_URL, /^postgres:\/\/.+\/intafaced_test$/);
  // Every key assert-test-db-env.mjs requires (CI's own probe) is set.
  const required = [...readFileSync(ROOT + 'tooling/ci/assert-test-db-env.mjs', 'utf8').matchAll(/key: '([A-Z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(required.length >= 10, 'the probe lists its URLs');
  for (const key of required) assert.ok(env[key], `${key} comes from CI's action`);
  assert.equal(env.TEST_DATABASE_URL_P2P, 'postgres://svc_p2p:svc_p2p@127.0.0.1:5432/intafaced_test');
  // What a laptop lacks is left to CI by name, never faked.
  for (const key of ['CI', 'NATS_URL', 'REDIS_URL', 'REQUIRE_EVM_CHAIN']) assert.ok(skipped.includes(key), key);
});

test('only database keys are taken', () => {
  for (const key of ['REQUIRE_POSTGRES', 'TEST_DATABASE_URL', 'TEST_DATABASE_URL_P2P', 'TEST_DATABASE_URL_SUPPORT_ADMIN'])
    assert.ok(LOCAL_KEYS.test(key), key);
  for (const key of ['CI', 'REDIS_URL', 'REQUIRE_EVM_CHAIN', 'TEST_DATABASE_URLX']) assert.ok(!LOCAL_KEYS.test(key), key);
});

test('planted: a changed action is a refusal, never a run against a guessed database', () => {
  assert.throws(() => ciTestEnv(ACTION.replace('- name: Test environment', '- name: Test env')), /no "Test environment" step/);
  assert.throws(() => ciTestEnv(ACTION.replace('for pair in', 'for p in')), /loop changed shape/);
  assert.throws(() => ciTestEnv(ACTION.replace("echo 'REQUIRE_POSTGRES=1'", "echo 'REQUIRE_POSTGRES=0'")), /REQUIRE_POSTGRES/);
  assert.throws(() => ciSchemaProof(ACTION.replace(/expected=\d+/, 'expected=')), /schema proof changed shape/);
});

test("the schema proof is CI's: its count and its list", () => {
  const { expected, inList } = ciSchemaProof(ACTION);
  assert.equal(inList.split(',').length, expected);
});

test("the package selection is CI's own function, called with the merge-base", () => {
  const text = readFileSync(new URL('./ci-tests.mjs', import.meta.url), 'utf8');
  assert.match(text, /affectedFilters\(files, readEdges\(\), mergeBase\)/);
  // ...and CI's changed job reads the same function (`--filters`).
  assert.match(readFileSync(ROOT + '.github/workflows/ci.yml', 'utf8'), /node tooling\/ci\/ci-affected\.mjs --filters/);
});
