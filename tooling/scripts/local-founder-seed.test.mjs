/**
 * Unit tests for the local founder seed. Nothing here starts Docker or touches the network:
 * the edge is a fake `fetch`. Run: node --test tooling/scripts/local-founder-seed.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ENV_FILE,
  GuardError,
  FOUNDER_VAULT_PATH,
  assertLocalOnly,
  base32Decode,
  base32Encode,
  buildEnvFile,
  canonicalInvite,
  currentCode,
  enrol,
  generateInvites,
  hashInvite,
  hotp,
  init,
  isLoopbackHttpUrl,
  parseDotenv,
  totpNow,
  unwrapTrpc,
  upsertEnv,
} from './local-founder-seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'local-founder-seed.mjs');
const LOCAL = { INTAFACED_LOCAL_FOUNDER: '1', APP_ENV: 'dev' };
const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof GuardError && re.test(e.message));
const tmp = () => mkdtempSync(join(tmpdir(), 'local-founder-seed-'));
/** Deterministic "random" so tests are repeatable; every call returns different bytes. */
const seeded = () => {
  let n = 0;
  return (len) => {
    n += 1;
    return Buffer.concat(
      Array.from({ length: Math.ceil(len / 32) }, (_, i) => createHash('sha256').update(`seed-${n}-${i}`).digest()),
    ).subarray(0, len);
  };
};

test('guard: refuses in production, without the LOCAL flag, and unless APP_ENV is exactly dev or test', () => {
  refuses(() => assertLocalOnly({ env: { ...LOCAL, NODE_ENV: 'production' } }), /NODE_ENV is "production"/);
  refuses(() => assertLocalOnly({ env: { APP_ENV: 'dev' } }), /INTAFACED_LOCAL_FOUNDER=1/);
  refuses(() => assertLocalOnly({ env: { INTAFACED_LOCAL_FOUNDER: 'true', APP_ENV: 'dev' } }), /INTAFACED_LOCAL_FOUNDER=1/);
  for (const bad of ['prod', 'staging', '', 'development', 'Dev']) {
    refuses(() => assertLocalOnly({ env: { INTAFACED_LOCAL_FOUNDER: '1', APP_ENV: bad } }), /APP_ENV/);
  }
  refuses(() => assertLocalOnly({ env: { INTAFACED_LOCAL_FOUNDER: '1' } }), /APP_ENV is not set/);
  refuses(() => assertLocalOnly({ env: { INTAFACED_LOCAL_FOUNDER: '1' }, dotenvText: 'APP_ENV=prod\n' }), /"prod"/);
  assert.equal(assertLocalOnly({ env: { INTAFACED_LOCAL_FOUNDER: '1' }, dotenvText: 'APP_ENV=dev\n' }), 'dev');
  assert.equal(assertLocalOnly({ env: { ...LOCAL, APP_ENV: 'test' } }), 'test');
  // The process env wins over .env, so a shell APP_ENV=prod cannot be masked by a dev .env file.
  refuses(() => assertLocalOnly({ env: { INTAFACED_LOCAL_FOUNDER: '1', APP_ENV: 'prod' }, dotenvText: 'APP_ENV=dev\n' }), /"prod"/);
});

test('guard: the edge must be http on loopback', () => {
  for (const ok of ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000']) assert.equal(isLoopbackHttpUrl(ok), true, ok);
  for (const bad of [
    'https://localhost:4000',
    'http://example.com',
    'http://localhost.evil.com',
    'http://user:pw@localhost:4000',
    'http://10.0.0.5:4000',
    'nonsense',
  ]) {
    assert.equal(isLoopbackHttpUrl(bad), false, bad);
  }
  refuses(() => assertLocalOnly({ env: { ...LOCAL, INTAFACED_LOCAL_EDGE_URL: 'https://api.intafaced.com' }, needEdge: true }), /edge URL/);
  assert.equal(assertLocalOnly({ env: LOCAL, needEdge: true }), 'dev');
});

test('invites: two distinct 160-bit codes, hashes are sha256 of the canonical form, expiry is +72 h', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  const inv = generateInvites({ now, rand: seeded() });
  assert.equal(inv.codes.length, 2);
  assert.notEqual(inv.codes[0], inv.codes[1]);
  assert.equal(inv.expiresAt, '2026-10-20T00:00:00.000Z');
  inv.codes.forEach((code, i) => {
    assert.match(code, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
    const canonical = canonicalInvite(code);
    assert.equal(canonical.length, 32);
    assert.equal(inv.hashes[i], createHash('sha256').update(canonical, 'utf8').digest('hex'));
    assert.equal(hashInvite(canonical), inv.hashes[i]);
    assert.match(inv.hashes[i], /^[0-9a-f]{64}$/);
  });
  // Real entropy source: two runs never collide.
  assert.notEqual(generateInvites().codes[0], generateInvites().codes[0]);
});

test('invites: accepted by the real svc-identity parsers (skipped if tsx is not installed)', (t) => {
  const tsx = resolve(here, '../../services/svc-identity/node_modules/.bin/tsx');
  if (!existsSync(tsx)) return t.skip('tsx not installed');
  const inv = generateInvites();
  const probe = `
    import { founderEnrolmentConfig, matchInvite } from './src/auth/founder-enrolment.ts';
    const [h, e, a, b] = process.argv.slice(1);
    const cfg = founderEnrolmentConfig(h, e);
    if (!cfg) throw new Error('config rejected');
    if (matchInvite(a, cfg.hashes) !== cfg.hashes[0]) throw new Error('code 1 does not match hash 1');
    if (matchInvite(b, cfg.hashes) !== cfg.hashes[1]) throw new Error('code 2 does not match hash 2');
    console.log('ok');`;
  const dir = resolve(here, '../../services/svc-identity');
  const r = spawnSync(tsx, ['--eval', probe, inv.hashes.join(','), inv.expiresAt, inv.codes[0], inv.codes[1]], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok/);
});

test('totp: RFC 4226 / 6238 vectors and base32 round trip', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.deepEqual(
    [0, 1, 2].map((c) => hotp(secret, c)),
    ['755224', '287082', '359152'],
  );
  assert.equal(hotp(secret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(totpNow(base32Encode(secret), new Date(59000)), '287082');
  assert.deepEqual(base32Decode(base32Encode(secret)), secret);
});

test('env helpers: upsert replaces in place and appends; the file carries hashes, never invite codes', () => {
  assert.equal(upsertEnv('A=1\nB=2\n', { B: '9', C: '3' }), 'A=1\nB=9\nC=3\n');
  assert.equal(upsertEnv('', { A: '1' }), 'A=1\n');
  assert.deepEqual(parseDotenv('# c\nAPP_ENV="dev"\nX=1\n'), { APP_ENV: 'dev', X: '1' });
  const inv = generateInvites({ rand: seeded() });
  const text = buildEnvFile({ totpKey: 'k', adminSessionSecret: 's', signinChallengeKey: 'c', invites: inv });
  for (const code of inv.codes) assert.ok(!text.includes(code) && !text.includes(canonicalInvite(code)));
  assert.match(text, /^WEBAUTHN_ORIGIN=http:\/\/localhost:8090,http:\/\/localhost:3100$/m);
  assert.match(text, /^ADMIN_ORIGIN=http:\/\/localhost:3100$/m);
});

test('init: writes two 0600 files, prints no secret, refuses to overwrite without --force', () => {
  const root = tmp();
  try {
    const out = [];
    init({ root, env: LOCAL, rand: seeded(), log: (l) => out.push(l) });
    for (const f of [ENV_FILE, FOUNDER_VAULT_PATH]) assert.equal(statSync(join(root, f)).mode & 0o777, 0o600, f);
    const envText = readFileSync(join(root, ENV_FILE), 'utf8');
    const secrets = JSON.parse(readFileSync(join(root, FOUNDER_VAULT_PATH), 'utf8'));
    const env = parseDotenv(envText);
    assert.equal(Buffer.from(env.IDENTITY_TOTP_SECRET_KEY, 'base64').length, 32);
    assert.match(env.ADMIN_SESSION_SECRET, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(env.ADMIN_SESSION_SECRET, 'base64url').length, 32);
    assert.equal(env.IDENTITY_FOUNDER_INVITE_HASHES.split(',').length, 2);
    assert.equal(Buffer.from(env.IDENTITY_SIGNIN_CHALLENGE_KEY, 'base64url').length, 32);
    assert.equal(env.IDENTITY_SIGNIN_CHALLENGE_BITS, '12');
    assert.ok(!('IDENTITY_FOUNDER_NITRO_USER_ID' in env), 'pair is only written after enrolment');
    assert.deepEqual(
      secrets.founders.map((f) => f.key),
      ['nitro', 'phantom'],
    );
    for (const f of secrets.founders) assert.ok(f.password.length >= 12);
    // Stdout carries paths and the expiry only.
    const printed = out.join('\n');
    for (const secret of [
      env.IDENTITY_TOTP_SECRET_KEY,
      env.ADMIN_SESSION_SECRET,
      ...secrets.founders.flatMap((f) => [f.password, f.invite, canonicalInvite(f.invite)]),
    ]) {
      assert.ok(!printed.includes(secret), 'a secret reached the log');
    }
    assert.match(printed, /written to .*\.env\.founder\.local/);
    refuses(() => init({ root, env: LOCAL, log() {} }), /already exists/);
    init({ root, env: LOCAL, force: true, log() {} });
    assert.notEqual(parseDotenv(readFileSync(join(root, ENV_FILE), 'utf8')).IDENTITY_TOTP_SECRET_KEY, env.IDENTITY_TOTP_SECRET_KEY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init: refuses outside the local guard before writing anything', () => {
  const root = tmp();
  try {
    refuses(() => init({ root, env: { APP_ENV: 'dev' }, log() {} }), /INTAFACED_LOCAL_FOUNDER/);
    refuses(() => init({ root, env: { ...LOCAL, APP_ENV: 'prod' }, log() {} }), /APP_ENV/);
    assert.equal(existsSync(join(root, ENV_FILE)), false);
    assert.equal(existsSync(join(root, FOUNDER_VAULT_PATH)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A fake svc-identity behind the edge. It enforces what the real one does that matters here:
 * login without a code is `auth.mfa_required` once TOTP is enrolled, a pending secret expires after
 * 15 minutes (`auth.mfa_invalid`), and confirm needs the pending secret and a current code.
 * `clock` is shared with the script via `now`. `failConfirm`: 'before' = server error, nothing applied;
 * 'lostReply' = applied, then the reply is lost (HTTP 502).
 */
function fakeEdge({ failConfirm = null } = {}) {
  const users = new Map();
  const calls = [];
  const clock = { t: new Date('2026-10-17T00:00:00Z') };
  let failed = false;
  const reply = (data) => ({ status: 200, json: async () => ({ result: { data } }) });
  const error = (status, code, intafacedCode) => ({ status, json: async () => ({ error: { data: { code, intafacedCode } } }) });
  const fetchImpl = async (url, init) => {
    const proc = new URL(url).pathname.split('/').pop();
    const body = JSON.parse(init.body);
    const token = init.headers.authorization?.replace('Bearer ', '');
    calls.push(proc);
    if (proc === 'auth.registerFounder') {
      const id = `00000000-0000-4000-8000-00000000000${users.size + 1}`;
      users.set(id, { ...body, id });
      return reply({ accessToken: `tok-${id}`, refreshToken: 'r', expiresAt: 'x', userId: id });
    }
    if (proc === 'auth.login') {
      const u = [...users.values()].find((x) => x.handle === body.identifier && x.password === body.password);
      if (!u) return error(401, 'UNAUTHORIZED', 'auth.invalid_credentials');
      if (u.enrolled && !body.totpCode) return error(401, 'UNAUTHORIZED', 'auth.mfa_required');
      return reply({ accessToken: `tok-${u.id}`, refreshToken: 'r', expiresAt: 'x', userId: u.id });
    }
    const user = users.get(token?.replace('tok-', ''));
    if (!user) return error(401, 'UNAUTHORIZED');
    if (proc === 'totp.enrol') {
      if (user.enrolled) return error(409, 'CONFLICT', 'auth.mfa_already_enrolled');
      user.pending = base32Encode(Buffer.from(`secret-${user.id}-${calls.length}`));
      user.pendingAt = clock.t.getTime();
      return reply({ secret: user.pending, uri: 'otpauth://x', recoveryCodes: ['aaaaa-bbbbb', 'ccccc-ddddd'] });
    }
    if (proc === 'totp.confirm') {
      if (failConfirm === 'before' && !failed) {
        failed = true;
        return error(500, 'INTERNAL_SERVER_ERROR');
      }
      const live = user.pending && clock.t.getTime() - user.pendingAt <= 15 * 60 * 1000;
      if (!live || body.secret !== user.pending || body.code !== totpNow(user.pending, clock.t))
        return error(401, 'UNAUTHORIZED', 'auth.mfa_invalid');
      user.enrolled = true;
      user.pending = null;
      if (failConfirm === 'lostReply' && !failed) {
        failed = true;
        return error(502, 'BAD_GATEWAY');
      }
      return reply({ ok: true });
    }
    return error(404, 'NOT_FOUND');
  };
  return { fetchImpl, users, calls, clock };
}

test('enrol: registers both founders through the real procedures, enrols TOTP, writes the pair, leaks nothing', async () => {
  const root = tmp();
  try {
    init({ root, env: LOCAL, rand: seeded(), log() {} });
    const edge = fakeEdge();
    const out = [];
    await enrol({ root, env: LOCAL, fetchImpl: edge.fetchImpl, now: () => edge.clock.t, log: (l) => out.push(l) });
    assert.deepEqual(edge.calls, [
      'auth.registerFounder',
      'totp.enrol',
      'totp.confirm',
      'auth.registerFounder',
      'totp.enrol',
      'totp.confirm',
    ]);
    const secrets = JSON.parse(readFileSync(join(root, FOUNDER_VAULT_PATH), 'utf8'));
    const env = parseDotenv(readFileSync(join(root, ENV_FILE), 'utf8'));
    assert.equal(env.IDENTITY_FOUNDER_NITRO_USER_ID, secrets.founders[0].userId);
    assert.equal(env.IDENTITY_FOUNDER_PHANTOM_USER_ID, secrets.founders[1].userId);
    assert.notEqual(env.IDENTITY_FOUNDER_NITRO_USER_ID, env.IDENTITY_FOUNDER_PHANTOM_USER_ID);
    assert.ok(secrets.founders.every((f) => f.totpConfirmed === true && f.totpSecret && f.recoveryCodes.length === 2));
    assert.equal(statSync(join(root, ENV_FILE)).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, FOUNDER_VAULT_PATH)).mode & 0o777, 0o600);
    // The invite codes sent to the service were the generated ones; the log shows none of the secrets.
    assert.deepEqual(
      [...edge.users.values()].map((u) => u.invite),
      secrets.founders.map((f) => f.invite),
    );
    const printed = out.join('\n');
    for (const f of secrets.founders)
      for (const s of [f.password, f.invite, f.totpSecret, ...f.recoveryCodes, f.userId]) assert.ok(!printed.includes(s));
    // Re-running is a no-op for finished founders.
    const before = edge.calls.length;
    await enrol({ root, env: LOCAL, fetchImpl: edge.fetchImpl, now: () => edge.clock.t, log() {} });
    assert.equal(edge.calls.length, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enrol: resumes after a failed confirm without losing the TOTP secret or re-registering', async () => {
  const root = tmp();
  try {
    init({ root, env: LOCAL, rand: seeded(), log() {} });
    const edge = fakeEdge({ failConfirm: 'before' });
    const now = () => edge.clock.t;
    await assert.rejects(enrol({ root, env: LOCAL, fetchImpl: edge.fetchImpl, now, log() {} }), /INTERNAL_SERVER_ERROR/);
    const saved = JSON.parse(readFileSync(join(root, FOUNDER_VAULT_PATH), 'utf8')).founders[0];
    assert.ok(saved.userId && saved.totpSecret && saved.totpConfirmed === false);
    await enrol({ root, env: LOCAL, fetchImpl: edge.fetchImpl, now, log() {} });
    assert.equal(edge.calls.filter((c) => c === 'auth.registerFounder').length, 2);
    assert.equal(edge.calls.filter((c) => c === 'totp.enrol').length, 2, 'the still-pending secret was reused, not re-enrolled');
    assert.ok(JSON.parse(readFileSync(join(root, FOUNDER_VAULT_PATH), 'utf8')).founders.every((f) => f.totpConfirmed === true));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enrol: a lost confirm reply (server enrolled, auth.mfa_required on login) is detected, not stuck', async () => {
  const root = tmp();
  try {
    init({ root, env: LOCAL, rand: seeded(), log() {} });
    const edge = fakeEdge({ failConfirm: 'lostReply' });
    const now = () => edge.clock.t;
    await assert.rejects(enrol({ root, env: LOCAL, fetchImpl: edge.fetchImpl, now, log() {} }), /BAD_GATEWAY/);
    assert.equal([...edge.users.values()][0].enrolled, true, 'precondition: the server did enrol');
    const out = [];
    await enrol({ root, env: LOCAL, fetchImpl: edge.fetchImpl, now, log: (l) => out.push(l) });
    const secrets = JSON.parse(readFileSync(join(root, FOUNDER_VAULT_PATH), 'utf8'));
    assert.ok(secrets.founders.every((f) => f.totpConfirmed === true && f.totpSecret));
    assert.match(out.join('\n'), /already enrolled/);
    assert.equal(edge.calls.filter((c) => c === 'totp.enrol').length, 2, 'founder 1 was not enrolled a second time');
    assert.equal(parseDotenv(readFileSync(join(root, ENV_FILE), 'utf8')).IDENTITY_FOUNDER_NITRO_USER_ID, secrets.founders[0].userId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enrol: a pending TOTP older than 15 minutes is replaced by a fresh enrolment', async () => {
  const root = tmp();
  try {
    init({ root, env: LOCAL, rand: seeded(), log() {} });
    const edge = fakeEdge({ failConfirm: 'before' });
    const now = () => edge.clock.t;
    await assert.rejects(enrol({ root, env: LOCAL, fetchImpl: edge.fetchImpl, now, log() {} }), /INTERNAL_SERVER_ERROR/);
    const stale = JSON.parse(readFileSync(join(root, FOUNDER_VAULT_PATH), 'utf8')).founders[0].totpSecret;
    edge.clock.t = new Date(edge.clock.t.getTime() + 16 * 60 * 1000);
    await enrol({ root, env: LOCAL, fetchImpl: edge.fetchImpl, now, log() {} });
    const secrets = JSON.parse(readFileSync(join(root, FOUNDER_VAULT_PATH), 'utf8'));
    assert.ok(secrets.founders.every((f) => f.totpConfirmed === true));
    assert.notEqual(secrets.founders[0].totpSecret, stale);
    assert.equal(edge.calls.filter((c) => c === 'totp.enrol').length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init --force: refuses while founders were created unless --force-new-db; always keeps 0600 backups', async () => {
  const root = tmp();
  try {
    init({ root, env: LOCAL, rand: seeded(), log() {} });
    const oldEnv = readFileSync(join(root, ENV_FILE), 'utf8');
    // Before any founder exists, --force is allowed but still backs the old files up.
    init({ root, env: LOCAL, force: true, now: new Date('2026-10-17T01:00:00Z'), log() {} });
    const bakEnv = join(root, '.env.founder.bak-2026-10-17T01-00-00-000Z.local');
    assert.equal(readFileSync(bakEnv, 'utf8'), oldEnv);
    assert.equal(statSync(bakEnv).mode & 0o777, 0o600);
    assert.ok(existsSync(join(root, '.env.founder-secrets.bak-2026-10-17T01-00-00-000Z.local')));
    // After enrolment the secrets file names real users: --force alone must refuse and change nothing.
    const edge = fakeEdge();
    await enrol({ root, env: LOCAL, fetchImpl: edge.fetchImpl, now: () => edge.clock.t, log() {} });
    const secretsBefore = readFileSync(join(root, FOUNDER_VAULT_PATH), 'utf8');
    const envBefore = readFileSync(join(root, ENV_FILE), 'utf8');
    refuses(() => init({ root, env: LOCAL, force: true, log() {} }), /--force-new-db/);
    assert.equal(readFileSync(join(root, FOUNDER_VAULT_PATH), 'utf8'), secretsBefore);
    assert.equal(readFileSync(join(root, ENV_FILE), 'utf8'), envBefore);
    // With both flags the old secrets survive as a backup and new ones are written.
    init({ root, env: LOCAL, force: true, forceNewDb: true, now: new Date('2026-10-17T02:00:00Z'), log() {} });
    const bakSecrets = join(root, '.env.founder-secrets.bak-2026-10-17T02-00-00-000Z.local');
    assert.equal(readFileSync(bakSecrets, 'utf8'), secretsBefore);
    assert.equal(statSync(bakSecrets).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(root, FOUNDER_VAULT_PATH), 'utf8')).founders[0].userId, null);
    // An unreadable secrets file is treated as "may hold founders".
    writeFileSync(join(root, FOUNDER_VAULT_PATH), '{not json');
    refuses(() => init({ root, env: LOCAL, force: true, log() {} }), /--force-new-db/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enrol: refuses a non-loopback edge and a missing init, before any request', async () => {
  const root = tmp();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('no network expected');
  };
  try {
    await assert.rejects(enrol({ root, env: LOCAL, fetchImpl, log() {} }), /run "init" first/);
    init({ root, env: LOCAL, rand: seeded(), log() {} });
    await assert.rejects(
      enrol({ root, env: { ...LOCAL, INTAFACED_LOCAL_EDGE_URL: 'https://api.example.com' }, fetchImpl, log() {} }),
      /edge URL/,
    );
    await assert.rejects(enrol({ root, env: { INTAFACED_LOCAL_FOUNDER: '1', APP_ENV: 'staging' }, fetchImpl, log() {} }), /APP_ENV/);
    assert.equal(called, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('code: returns the current one-time code for an enrolled founder only', async () => {
  const root = tmp();
  try {
    init({ root, env: LOCAL, rand: seeded(), log() {} });
    refuses(() => currentCode({ root, env: LOCAL, who: 'nitro' }), /no authenticator/);
    const edge = fakeEdge();
    await enrol({ root, env: LOCAL, fetchImpl: edge.fetchImpl, now: () => edge.clock.t, log() {} });
    const at = new Date('2026-10-17T00:00:10Z');
    const { code, secondsLeft } = currentCode({ root, env: LOCAL, who: 'phantom', at });
    const secret = JSON.parse(readFileSync(join(root, FOUNDER_VAULT_PATH), 'utf8')).founders[1].totpSecret;
    assert.equal(code, totpNow(secret, at));
    assert.match(code, /^\d{6}$/);
    assert.equal(secondsLeft, 20);
    refuses(() => currentCode({ root, env: LOCAL, who: 'someone' }), /usage/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unwrapTrpc: unwraps data / json, and errors carry codes only (never the body)', () => {
  assert.deepEqual(unwrapTrpc(200, { result: { data: { a: 1 } } }), { a: 1 });
  assert.deepEqual(unwrapTrpc(200, { result: { data: { json: { a: 2 } } } }), { a: 2 });
  assert.throws(
    () => unwrapTrpc(403, { error: { data: { code: 'FORBIDDEN', intafacedCode: 'auth.invite_used' }, message: 'secret-ish text' } }),
    (e) => e.message === 'FORBIDDEN (auth.invite_used)',
  );
  assert.throws(() => unwrapTrpc(502, null), /HTTP_502/);
  assert.throws(() => unwrapTrpc(200, {}), /unexpected response/);
});

test('CLI: refuses without the LOCAL flag, in production, and with a prod APP_ENV; writes nothing', () => {
  // The CLI resolves the real repo root, so prove the refusals leave it exactly as found.
  const repo = resolve(here, '../..');
  const files = [ENV_FILE, FOUNDER_VAULT_PATH].map((f) => join(repo, f));
  const before = files.map((f) => existsSync(f));
  const home = tmp();
  try {
    const run = (env, args = ['init']) =>
      spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: 'utf8' });
    for (const [env, re] of [
      [{ APP_ENV: 'dev' }, /INTAFACED_LOCAL_FOUNDER=1/],
      [{ APP_ENV: 'dev', INTAFACED_LOCAL_FOUNDER: '1', NODE_ENV: 'production' }, /production/],
      [{ APP_ENV: 'prod', INTAFACED_LOCAL_FOUNDER: '1' }, /APP_ENV/],
    ]) {
      const r = run(env);
      assert.equal(r.status, 1);
      assert.match(r.stderr, re);
      assert.equal(r.stdout, '');
    }
    assert.equal(run({}, []).status, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  assert.deepEqual(
    files.map((f) => existsSync(f)),
    before,
  );
});
