/**
 * Unit tests for the compose-env generator: no docker, no stack.
 * Run: node --test tooling/scripts/local-test-compose-env.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PARSE_ONLY, blankableVariable, composeEnvValues, envFileValue, renderEnvFile, startedBy } from './local-test-compose-env.mjs';

test('reads the variable a compose value names only when it can be blank', () => {
  assert.equal(blankableVariable('${EDGE_BODY_LIMIT_BYTES:-}'), 'EDGE_BODY_LIMIT_BYTES');
  assert.equal(blankableVariable('${EDGE_RATE_LIMIT_MAX:?missing — copy .env.example to .env}'), 'EDGE_RATE_LIMIT_MAX');
  assert.equal(blankableVariable('${PLAIN}'), 'PLAIN');
  assert.equal(blankableVariable('${HAS_DEFAULT:-true}'), null, 'compose has its own default');
  assert.equal(blankableVariable('http://${HOST}:8080'), null, 'not the whole value');
  assert.equal(blankableVariable('fixed'), null);
});

test('fills only what the started services run with on the stack, never a value .env.example already sets', () => {
  const services = {
    seed: { depends_on: { 'svc-edge': {} } },
    'svc-edge': {
      environment: { EDGE_BODY_LIMIT_BYTES: '${EDGE_BODY_LIMIT_BYTES:-}', APP_ENV: '${APP_ENV:?}', NOT_ON_STACK: '${NOT_ON_STACK:-}' },
    },
    'svc-ws': { environment: { EDGE_BODY_LIMIT_BYTES: '${EDGE_BODY_LIMIT_BYTES:-}' } },
  };
  const stackEnvs = { edge: { EDGE_BODY_LIMIT_BYTES: '1048576', APP_ENV: 'test', NOT_ON_STACK: '' }, ws: { EDGE_BODY_LIMIT_BYTES: '1' } };
  const example = 'EDGE_BODY_LIMIT_BYTES=\nAPP_ENV=development\n';
  const started = startedBy(services, 'seed');
  assert.deepEqual([...started].sort(), ['seed', 'svc-edge']);
  const { values, conflicts, unfilled } = composeEnvValues({ services, stackEnvs, example, started });
  assert.deepEqual(values, { EDGE_BODY_LIMIT_BYTES: '1048576', ...PARSE_ONLY }, 'svc-ws does not start, so its value never counts');
  assert.deepEqual(conflicts, []);
  assert.deepEqual(unfilled, []);
  // Without the started set, two services running one variable differently refuse by name.
  assert.match(composeEnvValues({ services, stackEnvs, example }).conflicts[0], /EDGE_BODY_LIMIT_BYTES: svc-edge and svc-ws/);
});

test('a required value the stack does not run with refuses by name', () => {
  const services = { seed: { depends_on: ['svc-x'] }, 'svc-x': { environment: { NEEDED: '${NEEDED:?set it}' } } };
  const { unfilled } = composeEnvValues({ services, stackEnvs: { x: {} }, example: 'NEEDED=\n', started: startedBy(services, 'seed') });
  assert.deepEqual(unfilled, ['NEEDED']);
});

test('every value reads back unchanged in compose env-file syntax', () => {
  assert.equal(envFileValue('6000'), '6000');
  assert.equal(envFileValue('a b'), "'a b'");
  assert.equal(envFileValue(`{"x": "it's $5"}`), `"{\\"x\\": \\"it's $$5\\"}"`);
  const file = renderEnvFile({ B: '2', A: '1' });
  assert.match(file, /^# LOCAL TEST values for the tester profile only; never a live value\./);
  assert.ok(file.indexOf('\nA=1\n') < file.indexOf('\nB=2\n'), 'sorted');
  assert.throws(() => renderEnvFile({ X: 'a\nb' }), /line break/);
});
