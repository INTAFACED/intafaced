/**
 * Unit tests for local-tester-identity (svc-identity's wrapper on the tester compose stack): what it starts identity with.
 * No process is started.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftFounderVault } from './local-test-founders.mjs';
import { changedFounderEnv, vaultFounderEnv } from './local-tester-identity.mjs';

test('no vault, or an unreadable one, gives identity no founder value', () => {
  assert.deepEqual(
    vaultFounderEnv('/state', () => {
      throw new Error('ENOENT');
    }),
    {},
  );
  assert.deepEqual(
    vaultFounderEnv('/state', () => 'not json'),
    {},
  );
});

test("a draft vault gives identity its invites only; an enrolled one adds the two founders' ids", () => {
  const vault = draftFounderVault({ now: new Date('2026-11-24T00:00:00Z') });
  const draft = vaultFounderEnv('/state', () => JSON.stringify(vault));
  assert.deepEqual(Object.keys(draft).sort(), ['IDENTITY_FOUNDER_INVITE_EXPIRES_AT', 'IDENTITY_FOUNDER_INVITE_HASHES']);
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  vault.founders.forEach((f, i) => Object.assign(f, { userId: ids[i], totpSecret: 'JBSWY3DPEHPK3PXP', totpConfirmed: true }));
  const pinned = vaultFounderEnv('/state', () => JSON.stringify(vault));
  assert.equal(pinned.IDENTITY_FOUNDER_NITRO_USER_ID, ids[0]);
  assert.equal(pinned.IDENTITY_FOUNDER_PHANTOM_USER_ID, ids[1]);
});

test('a vault caught half written is no change: identity is not started again (#10815)', () => {
  const vault = draftFounderVault({ now: new Date('2026-11-24T00:00:00Z') });
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  vault.founders.forEach((f, i) => Object.assign(f, { userId: ids[i], totpSecret: 'JBSWY3DPEHPK3PXP', totpConfirmed: true }));
  const whole = JSON.stringify(vault, null, 2);
  const pinned = vaultFounderEnv('/state', () => whole);
  assert.equal(pinned.IDENTITY_FOUNDER_PHANTOM_USER_ID, ids[1]);
  // The founder seed rewrites the vault after each email confirm; every cut of that write reads as no change.
  for (const cut of [0, 1, Math.floor(whole.length / 2), whole.length - 1])
    assert.equal(
      changedFounderEnv('/state', pinned, () => whole.slice(0, cut)),
      null,
      `cut at ${cut}`,
    );
  vault.founders[0].emailConfirmed = true;
  assert.equal(
    changedFounderEnv('/state', pinned, () => JSON.stringify(vault)),
    null,
  );
  // A real change still starts identity again: the draft's invites only, then the pair's ids.
  const draft = draftFounderVault({ now: new Date('2026-11-24T00:00:00Z') });
  const invitesOnly = changedFounderEnv('/state', {}, () => JSON.stringify(draft));
  assert.deepEqual(Object.keys(invitesOnly).sort(), ['IDENTITY_FOUNDER_INVITE_EXPIRES_AT', 'IDENTITY_FOUNDER_INVITE_HASHES']);
  assert.deepEqual(
    changedFounderEnv('/state', invitesOnly, () => whole),
    pinned,
  );
  // A vault that is gone gives no founder value, as at start.
  const gone = () => {
    throw new Error('ENOENT');
  };
  assert.deepEqual(changedFounderEnv('/state', pinned, gone), {});
  assert.equal(changedFounderEnv('/state', {}, gone), null);
});
