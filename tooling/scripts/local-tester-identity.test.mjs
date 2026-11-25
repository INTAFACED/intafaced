/**
 * Unit tests for local-tester-identity (svc-identity's wrapper on the tester compose stack): what it starts identity with.
 * No process is started.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftFounderVault } from './local-test-founders.mjs';
import { vaultFounderEnv } from './local-tester-identity.mjs';

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
