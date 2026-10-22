import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  badgeClaimKey,
  badgeClaimMessage,
  BadgeMintNotSentError,
  claimBadge,
  resolveStuckBadgeMint,
  type BadgeDeps,
} from './founding-badge.js';
import { memBadgeStore } from './founding-badge.test-store.js';

/** RC-more-catalogue-04 review: single-flight mint, typed "not sent" release, operator clear with chain evidence. */
const ACCOUNT = 'bad9e000-7777-4777-8777-777777777777';
const ADDR = '0x00000000000000000000000000000000000000d1' as Address;
const NET = { chainId: 84532, mainnet: false };
const OWNER_KEY = privateKeyToAccount(`0x${'55'.repeat(32)}`);
const WINDOW = { opensAt: new Date('2026-10-01T00:00:00Z'), closesAt: new Date('2026-11-01T00:00:00Z') };
const TX = `0x${'ef'.repeat(32)}` as Hex;

function setup(fail?: () => Error) {
  const store = memBadgeStore([ACCOUNT]);
  const mints: Array<{ to: Address; key: string }> = [];
  let failNext = fail;
  const deps: BadgeDeps = {
    store,
    window: WINDOW,
    now: () => new Date('2026-10-22T04:00:00Z'),
    minter: {
      signerFor: () => ({
        mint: async (to, key) => {
          await new Promise((r) => setTimeout(r, 5));
          if (failNext) {
            const e = failNext();
            failNext = undefined;
            throw e;
          }
          mints.push({ to, key });
          return `0x${'ab'.repeat(31)}${String(mints.length).padStart(2, '0')}` as Hex;
        },
      }),
    },
  };
  const claim = async () =>
    claimBadge(
      deps,
      ACCOUNT,
      { address: ADDR, owner: OWNER_KEY.address },
      NET,
      await OWNER_KEY.signMessage({ message: badgeClaimMessage({ accountId: ACCOUNT, chainId: NET.chainId, address: ADDR }) }),
    );
  return { store, mints, claim, key: badgeClaimKey(ACCOUNT) };
}

describe('founding badge single-flight mint (RC-more-catalogue-04)', () => {
  it('two concurrent claims from one account mint exactly once', async () => {
    const { store, mints, claim, key } = setup();
    const [a, b] = await Promise.all([claim(), claim()]);
    expect(mints).toHaveLength(1);
    const stored = store.rows.get(key)!;
    expect(stored.txHash).not.toBeNull();
    for (const r of [a, b]) expect([null, stored.txHash]).toContain(r.txHash);
    expect((await claim()).txHash).toBe(stored.txHash);
    expect(mints).toHaveLength(1);
  });

  it('a typed "not sent" signer error releases the slot; a retry mints once', async () => {
    const { store, mints, claim, key } = setup(() => new BadgeMintNotSentError('refused before signing'));
    await expect(claim()).rejects.toBeInstanceOf(BadgeMintNotSentError);
    expect(store.rows.get(key)!.mintingSince ?? null).toBeNull();
    const r = await claim();
    expect(r.txHash).not.toBeNull();
    expect(mints).toHaveLength(1);
  });

  it('any other signer error keeps the slot; a retry returns pending with mintingSince and no second mint', async () => {
    const { store, mints, claim, key } = setup(() => new Error('rpc timeout after broadcast'));
    await expect(claim()).rejects.toThrow(/rpc timeout/);
    const retry = await claim();
    expect(retry.txHash).toBeNull();
    expect(retry.mintingSince).toBeInstanceOf(Date);
    expect(mints).toHaveLength(0);
    expect(store.rows.get(key)!.mintingSince).toBeInstanceOf(Date);
  });

  it('operator clear "minted" stores the chain tx hash; the claim then reads claimed with no mint', async () => {
    const { store, mints, claim } = setup(() => new Error('crash mid-mint'));
    await expect(claim()).rejects.toThrow();
    const cleared = await resolveStuckBadgeMint(store, ACCOUNT, { kind: 'minted', txHash: TX });
    expect(cleared).toMatchObject({ txHash: TX, mintingSince: null });
    expect((await claim()).txHash).toBe(TX);
    expect(mints).toHaveLength(0);
  });

  it('operator clear "not_minted" frees the slot; a retry mints once', async () => {
    const s = setup(() => new Error('crash mid-mint'));
    await expect(s.claim()).rejects.toThrow();
    await resolveStuckBadgeMint(s.store, ACCOUNT, { kind: 'not_minted', attestedBy: 'ops:nino', checkedAt: new Date() });
    expect((await s.claim()).txHash).not.toBeNull();
    expect(s.mints).toHaveLength(1);
  });

  it('operator clear refuses blank evidence and is a no-op when nothing is stuck', async () => {
    const s = setup();
    await expect(resolveStuckBadgeMint(s.store, ACCOUNT, { kind: 'not_minted', attestedBy: ' ', checkedAt: new Date() })).rejects.toThrow(
      /attester/,
    );
    await expect(resolveStuckBadgeMint(s.store, ACCOUNT, { kind: 'minted', txHash: '0x12' as Hex })).rejects.toThrow(/tx hash/);
    expect(await resolveStuckBadgeMint(s.store, ACCOUNT, { kind: 'minted', txHash: TX })).toBeNull();
  });
});
