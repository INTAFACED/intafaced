import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  badgeClaimKey,
  badgeClaimMessage,
  BadgeMintNotSentError,
  claimBadge,
  resolveStuckBadgeMint,
  BADGE_STUCK_AGE_UNSET,
  BADGE_STUCK_APPROVAL_REFUSED,
  BADGE_STUCK_APPROVAL_UNWIRED,
  BADGE_STUCK_EVIDENCE_REQUIRED,
  BADGE_STUCK_NOT_STALE,
  type BadgeDeps,
  type BadgeRefusedError,
  type BadgeStore,
  type BadgeStuckMintEvidence,
} from './founding-badge.js';
import { memBadgeStore } from './founding-badge.test-store.js';

/** RC-more-catalogue-04 review: single-flight mint, typed "not sent" release, operator clear with chain evidence. */
const ACCOUNT = 'bad9e000-7777-4777-8777-777777777777';
const ADDR = '0x00000000000000000000000000000000000000d1' as Address;
const NET = {
  chainId: 84532,
  mainnet: false,
  restartable: false,
  identity: async () => ({ chainId: 84532, genesisHash: `0x${'a'.repeat(64)}` as const }),
};
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

  const LATER = new Date('2026-10-22T05:00:00Z');
  const approvals = (approverId: string | null = 'ops:second', requesterId = 'ops:first') => ({
    calls: [] as Array<Record<string, string>>,
    async consume(input: Record<string, string>) {
      this.calls.push(input);
      return { status: 'CONSUMED', requesterId, approverId };
    },
  });
  const resolveDeps = (store: BadgeStore, a: ReturnType<typeof approvals> | null = approvals(), age: number | null = 600) => ({
    store,
    approvals: a,
    staleAfterSeconds: age ?? undefined,
    now: () => LATER,
  });
  const input = (evidence: BadgeStuckMintEvidence, reason = 'rpc timeout during mint') => ({
    accountId: ACCOUNT,
    evidence,
    reason,
    actorId: 'ops:actor',
    approvalId: 'appr-1',
    operationId: 'op-1',
  });
  const stuck = async (s: ReturnType<typeof setup>) => {
    await expect(s.claim()).rejects.toThrow();
    const k = badgeClaimKey(ACCOUNT);
    s.store.rows.set(k, { ...s.store.rows.get(k)!, mintingSince: new Date('2026-10-22T04:00:00Z') });
  };

  it('operator clear "minted" stores the chain tx hash with an audit row; the claim then reads claimed with no mint', async () => {
    const s = setup(() => new Error('crash mid-mint'));
    await stuck(s);
    const a = approvals();
    const cleared = await resolveStuckBadgeMint(resolveDeps(s.store, a), input({ kind: 'minted', txHash: TX }));
    expect(cleared).toMatchObject({ txHash: TX, mintingSince: null });
    expect(a.calls[0]).toMatchObject({ targetService: 'svc-protocol', targetId: badgeClaimKey(ACCOUNT), approvalId: 'appr-1' });
    expect(a.calls[0]!.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(s.store.audits).toEqual([
      expect.objectContaining({
        actorId: 'ops:actor',
        requesterId: 'ops:first',
        approverId: 'ops:second',
        reason: 'rpc timeout during mint',
      }),
    ]);
    expect((await s.claim()).txHash).toBe(TX);
    expect(s.mints).toHaveLength(0);
  });

  it('operator clear "not_minted" frees the slot; a retry mints once', async () => {
    const s = setup(() => new Error('crash mid-mint'));
    await stuck(s);
    await resolveStuckBadgeMint(resolveDeps(s.store), input({ kind: 'not_minted', attestedBy: 'ops:nino', checkedAt: LATER }));
    expect(s.store.audits[0]).toMatchObject({ evidence: { kind: 'not_minted', attestedBy: 'ops:nino' } });
    expect((await s.claim()).txHash).not.toBeNull();
    expect(s.mints).toHaveLength(1);
  });

  it('operator clear refuses with typed codes and is a no-op when nothing is stuck', async () => {
    const s = setup(() => new Error('crash mid-mint'));
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'resolved',
        (e: BadgeRefusedError) => e.code,
      );
    expect(await code(resolveStuckBadgeMint(resolveDeps(s.store), input({ kind: 'not_minted', attestedBy: ' ', checkedAt: LATER })))).toBe(
      BADGE_STUCK_EVIDENCE_REQUIRED,
    );
    expect(await code(resolveStuckBadgeMint(resolveDeps(s.store), input({ kind: 'minted', txHash: '0x12' as Hex })))).toBe(
      BADGE_STUCK_EVIDENCE_REQUIRED,
    );
    expect(await code(resolveStuckBadgeMint(resolveDeps(s.store), input({ kind: 'minted', txHash: TX }, ' ')))).toBe(
      BADGE_STUCK_EVIDENCE_REQUIRED,
    );
    expect(await code(resolveStuckBadgeMint(resolveDeps(s.store, approvals(), null), input({ kind: 'minted', txHash: TX })))).toBe(
      BADGE_STUCK_AGE_UNSET,
    );
    expect(await resolveStuckBadgeMint(resolveDeps(s.store), input({ kind: 'minted', txHash: TX }))).toBeNull();

    await stuck(s);
    expect(await code(resolveStuckBadgeMint(resolveDeps(s.store, approvals(), 7200), input({ kind: 'minted', txHash: TX })))).toBe(
      BADGE_STUCK_NOT_STALE,
    );
    expect(await code(resolveStuckBadgeMint(resolveDeps(s.store, null), input({ kind: 'minted', txHash: TX })))).toBe(
      BADGE_STUCK_APPROVAL_UNWIRED,
    );
    expect(await code(resolveStuckBadgeMint(resolveDeps(s.store, approvals('ops:first')), input({ kind: 'minted', txHash: TX })))).toBe(
      BADGE_STUCK_APPROVAL_REFUSED,
    );
    expect(await code(resolveStuckBadgeMint(resolveDeps(s.store, approvals('ops:actor')), input({ kind: 'minted', txHash: TX })))).toBe(
      BADGE_STUCK_APPROVAL_REFUSED,
    );
    expect(await code(resolveStuckBadgeMint(resolveDeps(s.store, approvals(null)), input({ kind: 'minted', txHash: TX })))).toBe(
      BADGE_STUCK_APPROVAL_REFUSED,
    );
    const failing = { consume: async () => Promise.reject(new Error('action_approval.payload_mismatch')) };
    expect(await code(resolveStuckBadgeMint({ ...resolveDeps(s.store), approvals: failing }, input({ kind: 'minted', txHash: TX })))).toBe(
      BADGE_STUCK_APPROVAL_REFUSED,
    );
    expect(s.store.audits).toHaveLength(0);
    expect(s.store.rows.get(badgeClaimKey(ACCOUNT))!.mintingSince).toBeInstanceOf(Date);
  });
});
