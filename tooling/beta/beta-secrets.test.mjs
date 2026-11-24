import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { BETA_SETTINGS, betaEnvs, betaSecretPlan, generateValues, planText, secretUses, writeToGitHub } from './beta-secrets.mjs';

const SCRIPT = fileURLToPath(new URL('./beta-secrets.mjs', import.meta.url));
const posture = await tsImport('../../packages/config/src/production-posture.ts', import.meta.url);
const betaPosture = await tsImport('../../packages/config/src/beta-posture.ts', import.meta.url);
const config = await tsImport('../../packages/config/src/env.ts', import.meta.url);
const appEnv = await tsImport('../../packages/config/src/app-env.ts', import.meta.url);

const uses = secretUses();
const plan = betaSecretPlan(uses);
const names = plan.secrets.map((s) => s.name);

/** What the boot refuses that names one of the plan's settings: the generated values' own share of the boot check. */
function refusalsOfPlannedSecrets(envs) {
  const planned = new Set(uses.map((u) => u.key));
  const out = [];
  for (const { name, env } of envs) {
    for (const issue of [...posture.productionPostureIssues(env), ...posture.productionPostureS2sIssues(env)])
      if ([...planned].some((k) => issue.startsWith(`${k} `)) || issue.includes('INTERNAL_SERVICE_BODY_BIND'))
        out.push(`${name}: ${issue}`);
    for (const schema of [config.internalServiceEnvSchema, config.authEnvSchema]) {
      const held = Object.keys(schema.shape).some((k) => k in env && planned.has(k));
      if (!held) continue;
      const r = schema.safeParse(env);
      if (!r.success) out.push(`${name}: ${r.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    }
  }
  return out;
}

test('the dry run lists every secret the beta services read at boot, by name, with no value', () => {
  for (const n of [
    'EDGE_PRINCIPAL_SECRET',
    'INTERNAL_SERVICE_SECRET',
    'JWT_ACCESS_SECRET',
    'API_KEY_SIGNING_ENC_KEY',
    'ADMIN_SESSION_SECRET',
    'POSTGRES_PASSWORD',
    'SVC_IDENTITY_DB_PASSWORD',
    'SVC_LEDGER_DB_PASSWORD',
  ])
    assert.ok(names.includes(n), `${n} is in the plan`);
  assert.equal(BETA_SETTINGS.INTERNAL_SERVICE_BODY_BIND, 'require');
  assert.equal(new Set(names).size, names.length, 'one GitHub secret per name');
  // Every setting of every process the stack hands a secret is read from a planned secret.
  const reads = new Set(plan.secrets.flatMap((s) => s.reads));
  for (const u of uses) assert.ok(reads.has(`${u.service} ${u.key}`), `${u.service} ${u.key} has a planned secret`);
  // A secret several processes must agree on is one secret: identity signs what the edge and svc-ws read.
  const edgeAuthority = plan.secrets.find((s) => s.name === 'IDENTITY_EDGE_AUTHORITY_SECRET');
  assert.deepEqual([...edgeAuthority.reads].sort(), ['edge IDENTITY_OWNERSHIP_SECRET', 'identity IDENTITY_EDGE_AUTHORITY_SECRET']);
  // Only a TEST stand-in that is off by default goes unread.
  assert.deepEqual(plan.unused, ['notifyVerifyCode']);

  const r = spawnSync(process.execPath, [SCRIPT, 'plan'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const n of names) assert.match(r.stdout, new RegExp(`^${n} `, 'm'));
  assert.equal(r.stdout, `${planText(plan)}\n`);
  assert.doesNotMatch(r.stdout, /[0-9a-f]{64}|[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/, 'no value-shaped text');
});

test("the boot check passes on generated values: staging's posture refuses none of them", () => {
  const values = generateValues(plan);
  const envs = betaEnvs(values, uses, plan);
  assert.ok(envs.length > 20 && envs.some((e) => e.name === 'admin'), 'every service and the founder console');
  for (const { env } of envs) {
    assert.ok(posture.isProductionPosture(env), 'every process runs in production posture');
    assert.deepEqual(betaPosture.betaPostureIssues({ APP_ENV: env.APP_ENV, INTAFACED_BETA_POSTURE: env.INTAFACED_BETA_POSTURE }), []);
  }
  assert.deepEqual(refusalsOfPlannedSecrets(envs), []);
  for (const [name, value] of values) {
    assert.ok(!appEnv.hasLocalTestMarker(value) && !/^test/i.test(value), `${name} carries no TEST marker`);
    assert.ok(value.length >= 32, `${name} meets every 32-character floor`);
  }
  // Each process reads the values it was given, and services that must agree get the same one.
  const edge = envs.find((e) => e.name === 'edge').env;
  const identity = envs.find((e) => e.name === 'identity').env;
  assert.equal(edge.IDENTITY_OWNERSHIP_SECRET, values.get('IDENTITY_EDGE_AUTHORITY_SECRET'));
  assert.equal(identity.IDENTITY_EDGE_AUTHORITY_SECRET, values.get('IDENTITY_EDGE_AUTHORITY_SECRET'));
  assert.equal(new URL(identity.DATABASE_URL).password, values.get('SVC_IDENTITY_DB_PASSWORD'));
  assert.notEqual(values.get('SVC_IDENTITY_DB_PASSWORD'), values.get('SVC_LEDGER_DB_PASSWORD'), 'one password per role');
  // The console's session key keeps the exact shape apps/admin/src/lib/founder-session.ts accepts.
  assert.match(values.get('ADMIN_SESSION_SECRET'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(values.get('PAY_TRAVEL_RULE_MESSAGE_KEY'), 'base64').length, 32);
});

test('the same boot check refuses a planted dev value, published password, TEST marker or soft body binding', () => {
  const values = generateValues(plan);
  const planted = (name, value) => refusalsOfPlannedSecrets(betaEnvs(new Map(values).set(name, value), uses, plan));
  assert.ok(planted('JWT_ACCESS_SECRET', `dev-only-${'a'.repeat(40)}`).some((i) => i.includes('JWT_ACCESS_SECRET')));
  assert.ok(planted('SVC_IDENTITY_DB_PASSWORD', 'svc_identity').some((i) => i.startsWith('identity: DATABASE_URL')));
  assert.ok(planted('INTERNAL_SERVICE_SECRET', 'short').some((i) => i.includes('INTERNAL_SERVICE_SECRET')));
  const soft = betaEnvs(values, uses, plan).map(({ name, env }) => ({ name, env: { ...env, INTERNAL_SERVICE_BODY_BIND: 'accept-both' } }));
  assert.ok(refusalsOfPlannedSecrets(soft).length > 0, 'accept-both is refused');
  assert.ok(appEnv.hasLocalTestMarker(`local-test:${values.get('IDENTITY_PAY_QR_KEY')}`), 'the stack form would be refused');
});

/** A stand-in for gh that records every call; `secrets` is what the environment already holds. */
function fakeGh({ environment = true, secrets = [] } = {}) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'api') return { status: environment ? 0 : 1, stdout: '', stderr: environment ? '' : 'HTTP 404' };
    if (args[0] === 'secret' && args[1] === 'list')
      return { status: 0, stdout: JSON.stringify(secrets.map((name) => ({ name }))), stderr: '' };
    return { status: 0, stdout: `✓ Set ${args[2]}`, stderr: '' };
  };
  return { gh, calls };
}

test('write hands each value to gh on stdin only, never on a command line or on screen', () => {
  const { gh, calls } = fakeGh();
  const said = [];
  const { set, kept } = writeToGitHub({ env: 'beta', plan, gh, say: (l) => said.push(l) });
  assert.deepEqual(set, names);
  assert.deepEqual(kept, []);
  const sets = calls.filter((c) => c.args[0] === 'secret' && c.args[1] === 'set');
  assert.equal(sets.length, names.length);
  const values = sets.map((c) => c.input);
  assert.equal(new Set(values).size, values.length, 'every secret its own value');
  for (const c of sets) {
    assert.deepEqual(c.args.slice(3), ['--env', 'beta', '--repo', 'INTAFACED/intafaced']);
    assert.ok(c.input.length >= 32);
  }
  const visible = [...calls.flatMap((c) => c.args), ...said].join('\n');
  for (const v of values) assert.ok(!visible.includes(v), 'no value in any argument or printed line');
  const vars = calls.filter((c) => c.args[0] === 'variable').map((c) => `${c.args[2]}=${c.args.at(-1)}`);
  assert.deepEqual(
    vars,
    Object.entries(BETA_SETTINGS).map(([k, v]) => `${k}=${v}`),
  );
});

test('write keeps what the environment holds unless asked to rotate, and refuses a missing environment', () => {
  const held = ['JWT_ACCESS_SECRET', 'SVC_LEDGER_DB_PASSWORD'];
  const quiet = () => {};
  const kept = writeToGitHub({ env: 'beta', plan, gh: fakeGh({ secrets: held }).gh, say: quiet });
  assert.deepEqual(kept.kept, held);
  assert.equal(kept.set.length, names.length - held.length);
  const rotated = writeToGitHub({ env: 'beta', plan, rotate: true, gh: fakeGh({ secrets: held }).gh, say: quiet });
  assert.equal(rotated.set.length, names.length);
  const missing = fakeGh({ environment: false });
  assert.throws(() => writeToGitHub({ env: 'beta', plan, gh: missing.gh, say: quiet }), /does not exist/);
  assert.equal(missing.calls.length, 1, 'nothing is listed or set');
  assert.throws(() => writeToGitHub({ plan, gh: fakeGh().gh, say: quiet }), /--env/);
});
