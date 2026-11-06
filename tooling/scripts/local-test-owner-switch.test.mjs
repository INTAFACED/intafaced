import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SWITCH_FILE,
  SWITCH_LABEL,
  applyOwnerSwitches,
  parseAssignment,
  planSwitch,
  readSwitches,
  switchableNames,
  withSwitches,
  withoutSwitches,
  writeSwitches,
} from './local-test-owner-switch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const PROFILE = {
  label: 'TEST: profile',
  values: {
    DEMO_LIMIT: { service: 'demo', value: '5' },
    OTHER_FEE: { service: 'other', value: '1' },
  },
};

const ENV_TS = `export const env = z.object({
      /** The owner's daily cap. NO DEFAULT: blank refuses demo.cap_unset. */
      DEMO_CAP: z.string().optional(),
      /** Where the peer lives. */
      DEMO_PEER_URL: z.string(),
      /** Signing key. Never invent one. */
      DEMO_SIGNING_KEY: z.string().optional(),
});`;

function fakeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'owner-switch-repo-'));
  mkdirSync(path.join(repo, 'services', 'svc-demo', 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'services', 'svc-demo', 'src', 'env.ts'), ENV_TS);
  return repo;
}

test('switchable names: env.ts owner settings and the TEST profile, never wiring or another service', () => {
  const repo = fakeRepo();
  try {
    const names = switchableNames('demo', { repo, profile: PROFILE });
    assert.deepEqual([...names].sort(), ['DEMO_CAP', 'DEMO_LIMIT']);
    assert.equal(names.has('DEMO_PEER_URL'), false, 'a URL with no owner mark is wiring');
    assert.equal(names.has('DEMO_SIGNING_KEY'), false, 'a key is wiring even with an owner mark');
    assert.equal(names.has('OTHER_FEE'), false, "another service's TEST value is not this service's");
    assert.throws(() => switchableNames('../etc', { repo, profile: PROFILE }), /not a stack service name/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a switch: blank unsets, test takes the profile value, a value is one line; anything else refuses', () => {
  const names = new Set(['DEMO_CAP', 'DEMO_LIMIT']);
  const opts = { names, profile: PROFILE };
  assert.deepEqual(planSwitch('demo', 'DEMO_CAP', 'blank', opts), { value: null });
  assert.deepEqual(planSwitch('demo', 'DEMO_LIMIT', 'test', opts), { value: '5' });
  assert.deepEqual(planSwitch('demo', 'DEMO_CAP', { value: '2' }, opts), { value: '2' });
  assert.throws(() => planSwitch('demo', 'DEMO_PEER_URL', 'blank', opts), /not an owner setting of demo/);
  assert.throws(() => planSwitch('demo', 'DEMO_CAP', 'test', opts), /no TEST value/);
  assert.throws(() => planSwitch('demo', 'DEMO_CAP', { value: '' }, opts), /one non-empty line/);
  assert.throws(() => planSwitch('demo', 'DEMO_CAP', { value: 'a\nB=1' }, opts), /one non-empty line/);
  assert.throws(() => planSwitch('demo', 'DEMO_CAP', 'on', opts), /blank, test or/);
  assert.throws(() => planSwitch('demo', 'demo_cap', 'blank', opts), /not a setting name/);
});

test('command-line assignments', () => {
  assert.deepEqual(parseAssignment('DEMO_CAP=blank'), { name: 'DEMO_CAP', choice: 'blank' });
  assert.deepEqual(parseAssignment('DEMO_CAP=test'), { name: 'DEMO_CAP', choice: 'test' });
  assert.deepEqual(parseAssignment('DEMO_CAP=value:a=b'), { name: 'DEMO_CAP', choice: { value: 'a=b' } });
  assert.throws(() => parseAssignment('DEMO_CAP'), /is not NAME=/);
  assert.throws(() => parseAssignment('DEMO_CAP=off'), /blank, test or value/);
});

test('applied last: blank removes the name, a value replaces it, other services and names stay as they were', () => {
  const services = { demo: { DEMO_CAP: { value: null }, DEMO_LIMIT: { value: '9' } } };
  const env = { DEMO_CAP: '3', DEMO_LIMIT: '5', HTTP_PORT: '1' };
  assert.deepEqual(applyOwnerSwitches('demo', env, services), { DEMO_LIMIT: '9', HTTP_PORT: '1' });
  assert.deepEqual(env, { DEMO_CAP: '3', DEMO_LIMIT: '5', HTTP_PORT: '1' }, 'the service definition is not changed');
  assert.equal(applyOwnerSwitches('other', env, services), env);
  assert.equal(applyOwnerSwitches('demo', env, {}), env);
});

test('the switch file: written mode 600 with its label, cleared per service, removed when empty', () => {
  const state = mkdtempSync(path.join(tmpdir(), 'owner-switch-state-'));
  try {
    assert.deepEqual(readSwitches(state), {}, 'no file is no switches');
    const names = new Set(['DEMO_CAP', 'DEMO_LIMIT']);
    let services = withSwitches({}, 'demo', [{ name: 'DEMO_CAP', choice: 'blank' }], { names, profile: PROFILE, by: 'J-x #1', at: 't' });
    services = withSwitches(services, 'other', [{ name: 'OTHER_FEE', choice: 'test' }], {
      names: new Set(['OTHER_FEE']),
      profile: PROFILE,
      by: 'J-x #1',
      at: 't',
    });
    writeSwitches(services, state);
    const file = path.join(state, SWITCH_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).label, SWITCH_LABEL);
    assert.deepEqual(readSwitches(state), {
      demo: { DEMO_CAP: { value: null, by: 'J-x #1', at: 't' } },
      other: { OTHER_FEE: { value: '1', by: 'J-x #1', at: 't' } },
    });
    const [left, cleared] = withoutSwitches(readSwitches(state), ['demo']);
    assert.deepEqual(cleared, ['demo']);
    writeSwitches(left, state);
    assert.deepEqual(Object.keys(readSwitches(state)), ['other']);
    const [none, all] = withoutSwitches(readSwitches(state));
    assert.deepEqual(all, ['other']);
    writeSwitches(none, state);
    assert.equal(existsSync(file), false, 'no switch left: the stack starts as it always did');
    writeFileSync(file, JSON.stringify({ services: {} }));
    assert.throws(() => readSwitches(state), /not a LOCAL TEST owner switch file/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("the stack applies a switch to that service's settings, and to no other", () => {
  const state = mkdtempSync(path.join(tmpdir(), 'owner-switch-stack-'));
  const envOf = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { localTestServiceEnvs } = await import(${JSON.stringify(path.join(HERE, 'local-test-stack.mjs'))});
           console.log(JSON.stringify(Object.fromEntries(localTestServiceEnvs().map((s) => [s.name, s.env]))));`,
        ],
        { cwd: REPO, encoding: 'utf8', env: { ...process.env, LOCAL_STACK_STATE: state } },
      ),
    );
  try {
    const before = envOf();
    // A real bank owner setting the stack sets from the TEST profile today.
    const name = [...switchableNames('bank')].find((n) => typeof before.bank[n] === 'string');
    assert.ok(name, 'the bank service starts with at least one switchable owner setting');
    writeSwitches(withSwitches({}, 'bank', [{ name, choice: 'blank' }], { by: 'test' }), state);
    const blank = envOf();
    assert.equal(name in blank.bank, false, `${name} is unset on the bank service`);
    assert.deepEqual(blank.trade, before.trade, 'another service is untouched');
    assert.deepEqual({ ...blank.bank, [name]: before.bank[name] }, before.bank, 'nothing else on the bank service moved');
    writeSwitches(withSwitches({}, 'bank', [{ name, choice: { value: 'TEST-7' } }], { by: 'test' }), state);
    assert.equal(envOf().bank[name], 'TEST-7');
    writeSwitches({}, state);
    assert.deepEqual(envOf(), before, 'cleared: every service is back as it started');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
