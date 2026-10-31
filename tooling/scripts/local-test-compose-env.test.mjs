/**
 * Unit tests for the compose-env generator: no docker, no stack.
 * Run: node --test tooling/scripts/local-test-compose-env.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PARSE_ONLY,
  blankKeys,
  blankableVariable,
  composeEnvValues,
  envFileValue,
  hostOnly,
  marker,
  markedVariables,
  markerEnvFile,
  renderEnvFile,
  startedBy,
  unmark,
} from './local-test-compose-env.mjs';

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

test('marks only whole environment values a port or path never uses, and reads them back as their compose reference', () => {
  const compose = [
    '    environment:',
    '      EDGE_BODY_LIMIT_BYTES: ${EDGE_BODY_LIMIT_BYTES:-}',
    '      NEEDED: "${NEEDED:?set it}"',
    '      HAS_DEFAULT: ${HAS_DEFAULT:-true}',
    '      SET_IN_EXAMPLE: ${SET_IN_EXAMPLE:-}',
    '      STATE: ${STATE:-}',
    '    volumes:',
    '      - ${STATE:-/var/lib/x}:${STATE:-/var/lib/x}',
  ].join('\n');
  const marked = markedVariables(compose, 'SET_IN_EXAMPLE=1\nNEEDED=\n');
  assert.deepEqual(Object.fromEntries(marked), { EDGE_BODY_LIMIT_BYTES: '${EDGE_BODY_LIMIT_BYTES:-}', NEEDED: '${NEEDED:?}' });
  assert.match(markerEnvFile(marked), /^EDGE_BODY_LIMIT_BYTES=__compose_env_EDGE_BODY_LIMIT_BYTES__$/m);
  assert.match(markerEnvFile(marked), /^LITELLM_CONFIG_PATH=\/dev\/null$/m, 'parse-only values ride along');
  const services = unmark({ edge: { environment: { A: marker('NEEDED'), B: 'fixed' } }, seed: {} }, marked);
  assert.deepEqual(services.edge.environment, { A: '${NEEDED:?}', B: 'fixed' });
  assert.deepEqual(services.seed.environment, {});
});

test("never copies a value that names the stack's own host: inside a container that address is the container", () => {
  for (const v of ['localhost:14500', 'http://127.0.0.1:14502', 'http://127.0.0.1:1', 'http://[::1]:3000/x', 'a.example,localhost'])
    assert.equal(hostOnly(v), true, v);
  for (const v of ['nats://nats:4222', 'http://svc-identity:4002', 'https://terms.example/x', 'local-test', '127.0.0.10x'])
    assert.equal(hostOnly(v), false, v);
  const services = {
    edge: { environment: { EDGE_SANDBOX_HOSTS: '${EDGE_SANDBOX_HOSTS:-}', NEEDED_URL: '${NEEDED_URL:?}' } },
  };
  const stackEnvs = { edge: { EDGE_SANDBOX_HOSTS: 'localhost:14500', NEEDED_URL: 'http://127.0.0.1:14502' } };
  const out = composeEnvValues({ services, stackEnvs, example: '' });
  assert.equal(out.values.EDGE_SANDBOX_HOSTS, undefined, 'a blank compose value stays blank');
  assert.deepEqual(out.unfilled, ['NEEDED_URL'], 'a required one refuses by name');
});

test('a required value blank in a service up seed does not start still refuses: compose interpolates every service', () => {
  const services = {
    seed: { environment: {} },
    other: { environment: { ONLY_OTHER: '${ONLY_OTHER:?}', OPTIONAL: '${OPTIONAL:-}' } },
  };
  const out = composeEnvValues({ services, stackEnvs: { other: { ONLY_OTHER: 'x' } }, example: '', started: new Set(['seed']) });
  assert.deepEqual(out.unfilled, ['ONLY_OTHER'], 'not filled from a service that does not start, and named');
  assert.equal(out.values.ONLY_OTHER, undefined);
});

test('.env.example blanks: quoted empty, export and an inline comment are no value', () => {
  const { blank, set } = blankKeys('A=\nB=""\nC=\'\'\nexport D=\nE= # note\nF=1\nexport G=x\nH="#"\n');
  assert.deepEqual([...blank].sort(), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual([...set].sort(), ['F', 'G', 'H']);
});

test('a variable a YAML comment mentions is still marked', () => {
  const compose = [
    'services:',
    '  edge:',
    '    environment:',
    '      # blank ${EDGE_X} refuses',
    '      EDGE_X: ${EDGE_X:-} # ${EDGE_X} again',
  ].join('\n');
  assert.deepEqual(Object.fromEntries(markedVariables(compose, '')), { EDGE_X: '${EDGE_X:-}' });
});
