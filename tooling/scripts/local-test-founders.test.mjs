/**
 * Guard and vault selection for the local test stack founder pair.
 * Nothing here starts a service. Run: node --test tooling/scripts/local-test-founders.test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { base32Encode, totpNow } from './local-founder-seed.mjs';
import {
  DOCKER_EDGE_PORT,
  GuardError,
  LOCAL_TEST_FOUNDERS,
  assertLocalTestFounderTarget,
  assertVaultShape,
  draftFounderVault,
  enrolTestStackFounders,
  enrolledFounderPair,
  ensureFounderVaultDraft,
  founderIdentityEnv,
  founderPinStampFromEnv,
  founderVaultFiles,
  foundersEnrolled,
  isDockerFounderHandle,
  isOperatorHandle,
  planFounderIdentityRestart,
} from './local-test-founders.mjs';

const refuses = (fn, re) => assert.throws(fn, (err) => err instanceof GuardError && re.test(err.message));
const tmp = () => mkdtempSync(join(tmpdir(), 'local-test-founders-'));
const seeded = () => {
  let n = 0;
  return (len) => {
    n += 1;
    return Buffer.concat(
      Array.from({ length: Math.ceil(len / 32) }, (_, i) => createHash('sha256').update(`seed-${n}-${i}`).digest()),
    ).subarray(0, len);
  };
};

function marker(edge = 14500) {
  return {
    kind: 'intafaced-local-test-stack',
    ports: { edge, postgres: 15460, identity: 14502 },
    database: { host: '127.0.0.1', port: 15460, name: 'intafaced_local_test' },
  };
}

test('the labelled pair is not the operators and not the Docker founders', () => {
  assert.deepEqual(
    LOCAL_TEST_FOUNDERS.map((f) => f.handle),
    ['local_test_founder_a', 'local_test_founder_b'],
  );
  assert.deepEqual(
    LOCAL_TEST_FOUNDERS.map((f) => f.idVar),
    ['IDENTITY_FOUNDER_NITRO_USER_ID', 'IDENTITY_FOUNDER_PHANTOM_USER_ID'],
  );
  for (const f of LOCAL_TEST_FOUNDERS) {
    assert.equal(isOperatorHandle(f.handle), false);
    assert.equal(isDockerFounderHandle(f.handle), false);
  }
  assert.equal(isOperatorHandle('local_test_operator_a'), true);
  assert.equal(isDockerFounderHandle('local_nitro'), true);
  assert.equal(isDockerFounderHandle('local_phantom'), true);
});

test('guard: refuses without the local test stack marker, and refuses the Docker edge', () => {
  const stateDir = tmp();
  try {
    refuses(() => assertLocalTestFounderTarget({ marker: null, stateDir, edgeUrl: 'http://127.0.0.1:14500' }), /marker/);
    refuses(
      () => assertLocalTestFounderTarget({ marker: { kind: 'something-else' }, stateDir, edgeUrl: 'http://127.0.0.1:14500' }),
      /marker/,
    );
    refuses(() => assertLocalTestFounderTarget({ marker: marker(), stateDir: 'relative', edgeUrl: 'http://127.0.0.1:14500' }), /absolute/);
    refuses(
      () => assertLocalTestFounderTarget({ marker: marker(Number(DOCKER_EDGE_PORT)), stateDir, edgeUrl: 'http://127.0.0.1:4000' }),
      /4000/,
    );
    refuses(
      () =>
        assertLocalTestFounderTarget({
          marker: { ...marker(), database: { host: '127.0.0.1', port: 5432 } },
          stateDir,
          edgeUrl: 'http://127.0.0.1:14500',
        }),
      /5432/,
    );
    refuses(
      () =>
        assertLocalTestFounderTarget({
          marker: { ...marker(), database: { host: '10.0.0.5', port: 15460 } },
          stateDir,
          edgeUrl: 'http://127.0.0.1:14500',
        }),
      /127\.0\.0\.1/,
    );
    for (const edgeUrl of ['https://127.0.0.1:14500', 'http://localhost:14500', 'http://127.0.0.1:14501', 'http://127.0.0.1:14500/api']) {
      refuses(() => assertLocalTestFounderTarget({ marker: marker(), stateDir, edgeUrl }), /edge must be/);
    }
    const ok = assertLocalTestFounderTarget({ marker: marker(), stateDir, edgeUrl: 'http://127.0.0.1:14500' });
    assert.equal(ok.vaultPath, join(stateDir, 'founders.json'));
    assert.equal(ok.edgeUrl, 'http://127.0.0.1:14500');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('vault selection is the state directory founders.json and nothing from a repo checkout', () => {
  assert.deepEqual(founderVaultFiles({ stateDir: '/tmp/stack-state' }), ['/tmp/stack-state/founders.json']);
  assert.deepEqual(founderVaultFiles({}), []);
  assert.deepEqual(founderVaultFiles({ stateDir: 'relative' }), []);
  assert.deepEqual(founderVaultFiles({ scriptRepo: '/repo', stackRepo: '/repo' }), []);
});

test('vault shape refuses operators and Docker founders before any account is created', () => {
  const draft = draftFounderVault({ now: new Date('2026-10-17T00:00:00Z'), rand: seeded() });
  assert.doesNotThrow(() => assertVaultShape(draft));
  assert.equal(draft.founders.length, 2);
  refuses(
    () => assertVaultShape({ ...draft, founders: [{ handle: 'local_test_operator_a' }, draft.founders[1]] }),
    /operators are not founders/,
  );
  refuses(
    () => assertVaultShape({ ...draft, founders: [{ handle: 'local_nitro' }, { handle: 'local_phantom' }] }),
    /Docker stack founders/,
  );
  refuses(() => assertVaultShape({ ...draft, kind: 'docker' }), /not a local test stack vault/);
});

test('identity env pins exactly the two enrolled local-test ids and never a secret', () => {
  const draft = draftFounderVault({ now: new Date('2026-10-17T00:00:00Z'), rand: seeded() });
  const before = founderIdentityEnv(draft);
  assert.equal(before.IDENTITY_FOUNDER_NITRO_USER_ID, undefined);
  assert.equal(before.IDENTITY_FOUNDER_PHANTOM_USER_ID, undefined);
  assert.match(before.IDENTITY_FOUNDER_INVITE_HASHES, /^[0-9a-f]{64},[0-9a-f]{64}$/);
  assert.deepEqual(
    founderIdentityEnv({
      kind: draft.kind,
      founders: [
        {
          handle: 'local_test_operator_a',
          idVar: 'IDENTITY_FOUNDER_NITRO_USER_ID',
          userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          totpConfirmed: true,
        },
        {
          handle: 'local_test_operator_b',
          idVar: 'IDENTITY_FOUNDER_PHANTOM_USER_ID',
          userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          totpConfirmed: true,
        },
      ],
    }),
    {},
  );
  assert.deepEqual(founderIdentityEnv({ founders: [{ handle: 'local_nitro' }, { handle: 'local_phantom' }] }), {});

  draft.founders[0].userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  draft.founders[0].totpSecret = 'SECRET';
  draft.founders[0].totpConfirmed = true;
  draft.founders[1].userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  draft.founders[1].totpSecret = 'SECRET';
  draft.founders[1].totpConfirmed = true;
  const env = founderIdentityEnv(draft);
  assert.equal(env.IDENTITY_FOUNDER_NITRO_USER_ID, draft.founders[0].userId);
  assert.equal(env.IDENTITY_FOUNDER_PHANTOM_USER_ID, draft.founders[1].userId);
  assert.equal(foundersEnrolled(draft), true);
  for (const secret of [draft.founders[0].password, draft.founders[0].invite, draft.founders[0].totpSecret]) {
    assert.equal(JSON.stringify(env).includes(secret), false);
  }
  const swapped = founderIdentityEnv({
    ...draft,
    founders: [draft.founders[1], draft.founders[0]],
  });
  assert.equal(swapped.IDENTITY_FOUNDER_NITRO_USER_ID, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(swapped.IDENTITY_FOUNDER_PHANTOM_USER_ID, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const noSlot = founderIdentityEnv({
    ...draft,
    founders: draft.founders.map((f) => ({ ...f, idVar: undefined })),
  });
  assert.equal(noSlot.IDENTITY_FOUNDER_NITRO_USER_ID, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const wrongSlot = founderIdentityEnv({
    ...draft,
    founders: draft.founders.map((f) => ({ ...f, idVar: 'IDENTITY_FOUNDER_OTHER_USER_ID' })),
  });
  assert.equal(wrongSlot.IDENTITY_FOUNDER_NITRO_USER_ID, undefined);

  const operatorVault = {
    kind: draft.kind,
    founders: [
      { handle: 'local_test_operator_a', userId: draft.founders[0].userId, totpConfirmed: true, idVar: 'IDENTITY_FOUNDER_NITRO_USER_ID' },
      { handle: 'local_test_operator_b', userId: draft.founders[1].userId, totpConfirmed: true, idVar: 'IDENTITY_FOUNDER_PHANTOM_USER_ID' },
    ],
  };
  assert.deepEqual(founderIdentityEnv(operatorVault), {});
  assert.equal(foundersEnrolled(operatorVault), false);
});

test('the approving founder pair is ready only when both have an account and a confirmed second factor', () => {
  const draft = draftFounderVault();
  assert.equal(enrolledFounderPair(draft), null, 'no accounts yet');
  const enrol = (vault, overrides = {}) => ({
    ...vault,
    founders: vault.founders.map((f, i) => ({
      ...f,
      userId: `0000000${i}-0000-4000-8000-00000000000${i}`,
      totpSecret: 'JBSWY3DPEHPK3PXP',
      totpConfirmed: true,
      ...overrides,
    })),
  });
  const ready = enrolledFounderPair(enrol(draft));
  assert.deepEqual(
    ready?.map((f) => f.handle),
    ['local_test_founder_a', 'local_test_founder_b'],
  );
  assert.equal(enrolledFounderPair(enrol(draft, { totpConfirmed: false })), null, 'second factor not confirmed');
  assert.equal(enrolledFounderPair(enrol(draft, { userId: 'same-id-for-both' })), null, 'one account for both');
  const swapped = enrol(draft);
  swapped.founders = [...swapped.founders].reverse();
  assert.deepEqual(
    enrolledFounderPair(swapped)?.map((f) => f.key),
    ['a', 'b'],
    'always a then b',
  );
  const operators = enrol(draft);
  operators.founders = operators.founders.map((f, i) => ({ ...f, handle: `local_test_operator_${'ab'[i]}` }));
  assert.equal(enrolledFounderPair(operators), null, 'test operators are not founders');
  assert.equal(enrolledFounderPair(null), null);
});

test('pin stamp records only the invite expiry and the two ids', () => {
  const stamp = founderPinStampFromEnv({
    IDENTITY_FOUNDER_INVITE_EXPIRES_AT: '2026-10-20T00:00:00.000Z',
    IDENTITY_FOUNDER_NITRO_USER_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    IDENTITY_FOUNDER_PHANTOM_USER_ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    IDENTITY_FOUNDER_INVITE_HASHES: 'ab'.repeat(32),
    password: 'secret-password',
  });
  assert.deepEqual(stamp, {
    inviteExpiresAt: '2026-10-20T00:00:00.000Z',
    nitroUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    phantomUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  assert.equal(JSON.stringify(stamp).includes('secret-password'), false);
});

test('restart plan: enrol needs the invite env first, then a restart that pins the ids', () => {
  const vault = draftFounderVault({ now: new Date('2026-10-17T00:00:00Z'), rand: seeded() });
  const missing = planFounderIdentityRestart({ enrolled: false, stamp: null, vault });
  assert.equal(missing.restartBeforeEnrol, true);
  assert.equal(missing.restartToPin, false);
  const applied = planFounderIdentityRestart({
    enrolled: false,
    stamp: { inviteExpiresAt: vault.invites.expiresAt, nitroUserId: null, phantomUserId: null },
    vault,
  });
  assert.equal(applied.restartBeforeEnrol, false);
  vault.founders[0].userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  vault.founders[0].totpConfirmed = true;
  vault.founders[1].userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  vault.founders[1].totpConfirmed = true;
  const unpinned = planFounderIdentityRestart({
    enrolled: true,
    stamp: { inviteExpiresAt: vault.invites.expiresAt, nitroUserId: null, phantomUserId: null },
    vault,
  });
  assert.equal(unpinned.restartBeforeEnrol, false);
  assert.equal(unpinned.restartToPin, true);
  const pinned = planFounderIdentityRestart({
    enrolled: true,
    stamp: {
      inviteExpiresAt: vault.invites.expiresAt,
      nitroUserId: vault.founders[0].userId,
      phantomUserId: vault.founders[1].userId,
    },
    vault,
  });
  assert.equal(pinned.restartToPin, false);
});

test('draft writes only founders.json under the state dir and refreshes expired unused invites', () => {
  const stateDir = tmp();
  const repo = tmp();
  try {
    const first = ensureFounderVaultDraft({
      stateDir,
      marker: marker(),
      edgeUrl: 'http://127.0.0.1:14500',
      now: new Date('2026-10-17T00:00:00Z'),
      rand: seeded(),
      log() {},
    });
    assert.equal(first.created, true);
    assert.equal(existsSync(join(stateDir, 'founders.json')), true);
    assert.equal(statSync(join(stateDir, 'founders.json')).mode & 0o777, 0o600);
    assert.equal(existsSync(join(stateDir, '.env.founder-secrets.local')), false);
    assert.equal(existsSync(join(stateDir, '.env.founder.local')), false);
    assert.equal(existsSync(join(repo, '.env.founder-secrets.local')), false);
    const again = ensureFounderVaultDraft({
      stateDir,
      marker: marker(),
      edgeUrl: 'http://127.0.0.1:14500',
      now: new Date('2026-10-17T01:00:00Z'),
      rand: seeded(),
      log() {},
    });
    assert.equal(again.created, false);
    assert.equal(again.vault.invites.expiresAt, first.vault.invites.expiresAt);
    const expired = ensureFounderVaultDraft({
      stateDir,
      marker: marker(),
      edgeUrl: 'http://127.0.0.1:14500',
      now: new Date('2026-10-21T00:00:00Z'),
      rand: seeded(),
      log() {},
    });
    assert.equal(expired.created, true);
    assert.notEqual(expired.vault.invites.expiresAt, first.vault.invites.expiresAt);
    refuses(() => ensureFounderVaultDraft({ stateDir, marker: marker(4000), edgeUrl: 'http://127.0.0.1:4000', log() {} }), /4000/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

function fakeEdge(outbox) {
  const users = new Map();
  const calls = [];
  const clock = { t: new Date('2026-10-17T00:00:00Z') };
  const reply = (data) => ({ status: 200, json: async () => ({ result: { data } }) });
  const error = (status, code, intafacedCode) => ({ status, json: async () => ({ error: { data: { code, intafacedCode } } }) });
  const fetchImpl = async (url, init) => {
    const proc = new URL(url).pathname.split('/').pop();
    const body = JSON.parse(init.body);
    const token = init.headers.authorization?.replace('Bearer ', '');
    calls.push({ proc, url });
    if (proc === 'auth.registerFounder') {
      const id = `00000000-0000-4000-8000-00000000000${users.size + 1}`;
      users.set(id, { ...body, id });
      return reply({ accessToken: `tok-${id}`, refreshToken: 'r', expiresAt: 'x', userId: id });
    }
    const user = users.get(token?.replace('tok-', ''));
    if (!user) return error(401, 'UNAUTHORIZED');
    if (proc === 'auth.requestEmailConfirmation') {
      // Identity "mails" the link to the stack's outbox file; only the token in it confirms the address.
      user.confirmToken = `ct-${user.id}`;
      appendFileSync(
        outbox,
        `LOCAL-TEST purpose=email-confirm email=${user.email} expires=x link=confirm-email?token=${user.confirmToken}\n`,
      );
      return reply({ accepted: true });
    }
    if (proc === 'auth.confirmEmail') {
      if (body.token !== user.confirmToken) return error(400, 'BAD_REQUEST', 'auth.token_invalid');
      user.emailVerified = true;
      return reply({ userId: user.id });
    }
    if (proc === 'totp.enrol') {
      user.pending = base32Encode(Buffer.from(`secret-${user.id}`));
      return reply({ secret: user.pending, uri: 'otpauth://x', recoveryCodes: ['aaaaa-bbbbb', 'ccccc-ddddd'] });
    }
    if (proc === 'totp.confirm') {
      if (body.secret !== user.pending || body.code !== totpNow(user.pending, clock.t))
        return error(401, 'UNAUTHORIZED', 'auth.mfa_invalid');
      user.enrolled = true;
      return reply({ ok: true });
    }
    return error(404, 'NOT_FOUND');
  };
  return { fetchImpl, users, calls, clock };
}

test('enrol talks only to the test stack edge and writes no Docker founder file', async () => {
  const stateDir = tmp();
  const repo = tmp();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('no network expected');
  };
  try {
    await assert.rejects(
      enrolTestStackFounders({ stateDir, marker: marker(4000), edgeUrl: 'http://127.0.0.1:4000', fetchImpl, log() {} }),
      /4000/,
    );
    await assert.rejects(
      enrolTestStackFounders({ stateDir, marker: null, edgeUrl: 'http://127.0.0.1:14500', fetchImpl, log() {} }),
      /marker/,
    );
    assert.equal(called, false);
    ensureFounderVaultDraft({
      stateDir,
      marker: marker(),
      edgeUrl: 'http://127.0.0.1:14500',
      now: new Date('2026-10-17T00:00:00Z'),
      rand: seeded(),
      log() {},
    });
    const edge = fakeEdge(join(stateDir, 'email-outbox.log'));
    const vault = await enrolTestStackFounders({
      stateDir,
      marker: marker(),
      edgeUrl: 'http://127.0.0.1:14500',
      fetchImpl: edge.fetchImpl,
      now: () => edge.clock.t,
      log() {},
    });
    assert.deepEqual(
      edge.calls.map((c) => c.proc),
      [
        'auth.registerFounder',
        'auth.requestEmailConfirmation',
        'auth.confirmEmail',
        'totp.enrol',
        'totp.confirm',
        'auth.registerFounder',
        'auth.requestEmailConfirmation',
        'auth.confirmEmail',
        'totp.enrol',
        'totp.confirm',
      ],
    );
    // Each founder's address is confirmed through the mailed link, as its owner would, so a new browser can be mailed a code.
    assert.deepEqual(
      [...edge.users.values()].map((u) => u.emailVerified),
      [true, true],
    );
    assert.ok(edge.calls.every((c) => c.url.startsWith('http://127.0.0.1:14500/api/identity/trpc/')));
    assert.deepEqual(
      [...edge.users.values()].map((u) => u.handle),
      ['local_test_founder_a', 'local_test_founder_b'],
    );
    const env = founderIdentityEnv(vault);
    assert.equal(env.IDENTITY_FOUNDER_NITRO_USER_ID, vault.founders[0].userId);
    assert.equal(env.IDENTITY_FOUNDER_PHANTOM_USER_ID, vault.founders[1].userId);
    assert.notEqual(env.IDENTITY_FOUNDER_NITRO_USER_ID, env.IDENTITY_FOUNDER_PHANTOM_USER_ID);
    const names = readdirSync(stateDir);
    assert.ok(names.includes('founders.json'));
    assert.equal(
      names.some((n) => n.startsWith('.env.founder')),
      false,
    );
    assert.equal(existsSync(join(repo, '.env.founder-secrets.local')), false);
    assert.equal(existsSync(join(repo, '.env.founder.local')), false);
    const onDisk = JSON.parse(readFileSync(join(stateDir, 'founders.json'), 'utf8'));
    assert.equal(
      onDisk.founders.every((f) => f.totpConfirmed === true && f.password && f.totpSecret),
      true,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
