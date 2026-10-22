import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  badgeClaimKey,
  badgeEligibility,
  BadgeRefusedError,
  claimBadge,
  type BadgeClaimRecord,
  type BadgeDeps,
  type BadgeStore,
} from './founding-badge.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADDR = '0x00000000000000000000000000000000000000a1';
const TESTNET = { chainId: 84532, mainnet: false };
const MAINNET = { chainId: 8453, mainnet: true };
const WINDOW = { opensAt: new Date('2026-10-01T00:00:00Z'), closesAt: new Date('2026-11-01T00:00:00Z') };

function memStore(listed: string[]): BadgeStore & { rows: Map<string, BadgeClaimRecord> } {
  const rows = new Map<string, BadgeClaimRecord>();
  return {
    rows,
    isListed: async (id) => listed.includes(id),
    findClaim: async (k) => rows.get(k) ?? null,
    putClaim: async (r) => {
      if (!rows.has(r.key)) rows.set(r.key, r);
      return rows.get(r.key)!;
    },
    setTxHash: async (k, tx) => {
      const r = { ...rows.get(k)!, txHash: tx };
      rows.set(k, r);
      return r;
    },
  };
}

function deps(over: Partial<BadgeDeps> = {}, listed = [ACCOUNT]) {
  const mints: Array<{ to: Address; key: string }> = [];
  const store = memStore(listed);
  const d: BadgeDeps = {
    store,
    minter: {
      signerFor: (chainId) =>
        chainId === TESTNET.chainId
          ? {
              mint: async (to, key) => {
                mints.push({ to, key });
                return `0x${String(mints.length).padStart(64, '0')}` as Hex;
              },
            }
          : null,
    },
    window: WINDOW,
    now: () => new Date('2026-10-22T04:00:00Z'),
    ...over,
  };
  return { d, mints, store };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BadgeRefusedError) return e.code;
    throw e;
  }
  throw new Error('expected refusal');
}

describe('founding badge claim (RC-more-catalogue-04)', () => {
  it('claiming twice mints once; the second call returns the stored claim', async () => {
    const { d, mints } = deps();
    const a = await claimBadge(d, ACCOUNT, ADDR, TESTNET);
    const b = await claimBadge(d, ACCOUNT, ADDR, TESTNET);
    expect(mints).toHaveLength(1);
    expect(b).toEqual(a);
    expect(a.key).toBe(`badge:claim:${ACCOUNT}`);
    expect(a.label).toBe('TEST');
    expect(a.audited).toBe(false);
  });

  it('mints only to the account own address', async () => {
    const { d, mints } = deps();
    await claimBadge(d, ACCOUNT, ADDR, TESTNET);
    expect(mints[0]!.to.toLowerCase()).toBe(ADDR);
  });

  it('blank window refuses badge.window_unset and mints nothing', async () => {
    for (const window of [undefined, null, { opensAt: WINDOW.closesAt, closesAt: WINDOW.opensAt }]) {
      const { d, mints } = deps({ window });
      expect(await refusal(claimBadge(d, ACCOUNT, ADDR, TESTNET))).toBe('badge.window_unset');
      expect(await refusal(badgeEligibility(d, ACCOUNT, TESTNET))).toBe('badge.window_unset');
      expect(mints).toHaveLength(0);
    }
  });

  it('mainnet refuses audit.external and mints nothing', async () => {
    const { d, mints } = deps();
    expect(await refusal(claimBadge(d, ACCOUNT, ADDR, MAINNET))).toBe('audit.external');
    expect(mints).toHaveLength(0);
    expect((await badgeEligibility(d, ACCOUNT, MAINNET)).label).toBe('MAINNET');
  });

  it('no signer for the network refuses rail.crypto', async () => {
    const { d, store } = deps();
    expect(await refusal(claimBadge(d, ACCOUNT, ADDR, { chainId: 1337, mainnet: false }))).toBe('rail.crypto');
    expect(store.rows.size).toBe(0);
  });

  it('an account not on the list refuses badge.not_eligible; empty list invents no one', async () => {
    const { d, mints } = deps({}, []);
    expect(await refusal(claimBadge(d, ACCOUNT, ADDR, TESTNET))).toBe('badge.not_eligible');
    expect((await badgeEligibility(d, ACCOUNT, TESTNET)).eligible).toBe(false);
    expect(mints).toHaveLength(0);
  });

  it('outside the window refuses badge.window_closed', async () => {
    const { d } = deps({ now: () => new Date('2026-12-01T00:00:00Z') });
    expect(await refusal(claimBadge(d, ACCOUNT, ADDR, TESTNET))).toBe('badge.window_closed');
  });

  it('a stored key owned by another account refuses badge.already_claimed', async () => {
    const { d, store } = deps();
    store.rows.set(badgeClaimKey(ACCOUNT), {
      key: badgeClaimKey(ACCOUNT),
      accountId: OTHER,
      chainId: 84532,
      to: ADDR as Address,
      txHash: null,
    });
    expect(await refusal(claimBadge(d, ACCOUNT, ADDR, TESTNET))).toBe('badge.already_claimed');
  });

  it('crash after mint submitted: retry reuses the stored tx', async () => {
    const { d, mints, store } = deps();
    const first = await claimBadge(d, ACCOUNT, ADDR, TESTNET);
    // window later blanked/closed or list cleared must not re-mint or refuse a finished claim beyond window_unset
    const again = await claimBadge({ ...d, now: () => new Date('2027-01-01T00:00:00Z') }, ACCOUNT, ADDR, TESTNET);
    expect(again.txHash).toBe(first.txHash);
    expect(mints).toHaveLength(1);
    expect(store.rows.size).toBe(1);
  });

  it('crash after claim stored but before mint: retry mints once with the same key', async () => {
    const { d, mints, store } = deps();
    store.rows.set(badgeClaimKey(ACCOUNT), {
      key: badgeClaimKey(ACCOUNT),
      accountId: ACCOUNT,
      chainId: 84532,
      to: ADDR as Address,
      txHash: null,
    });
    const r = await claimBadge(d, ACCOUNT, ADDR, TESTNET);
    expect(mints).toEqual([{ to: ADDR, key: badgeClaimKey(ACCOUNT) }]);
    expect(r.txHash).not.toBeNull();
  });

  it('eligibility never reports audited and shows TEST on testnet', async () => {
    const { d } = deps();
    expect(await badgeEligibility(d, ACCOUNT, TESTNET)).toEqual({
      eligible: true,
      claimed: false,
      label: 'TEST',
      audited: false,
      txHash: null,
    });
  });
});
