import { describe, expect, it } from 'vitest';
import { isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  badgeClaimKey,
  badgeClaimMessage,
  badgeChainIsMainnet,
  badgeEligibility,
  badgeWindowFromSetting,
  noBadgeSigner,
  BadgeRefusedError,
  claimBadge,
  type BadgeClaimRecord,
  type BadgeDeps,
  type BadgeStore,
} from './founding-badge.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADDR = '0x00000000000000000000000000000000000000a1';
const GENESIS = `0x${'a'.repeat(64)}` as Hex;
/** The same TEST chain id after the chain was started again: a new genesis. */
const RESTARTED = `0x${'b'.repeat(64)}` as Hex;
const TESTNET = { chainId: 84532, genesisHash: GENESIS, mainnet: false };
const MAINNET = { chainId: 8453, genesisHash: GENESIS, mainnet: true };
const WINDOW = { opensAt: new Date('2026-10-01T00:00:00Z'), closesAt: new Date('2026-11-01T00:00:00Z') };

const OWNER_KEY = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const STRANGER_KEY = privateKeyToAccount(`0x${'22'.repeat(32)}`);

async function claim(
  d: BadgeDeps,
  accountId: string,
  addr: string | null | undefined,
  net: { chainId: number; genesisHash: Hex; mainnet: boolean },
  signature?: string | null,
) {
  const sig =
    signature !== undefined
      ? signature
      : addr && isAddress(addr)
        ? await OWNER_KEY.signMessage({ message: badgeClaimMessage({ accountId, chainId: net.chainId, address: addr as Address }) })
        : null;
  return claimBadge(d, accountId, addr ? { address: addr, owner: OWNER_KEY.address } : null, net, sig);
}

import { memMintSlots } from './founding-badge.test-store.js';

function memStore(listed: string[]): BadgeStore & { rows: Map<string, BadgeClaimRecord> } {
  const rows = new Map<string, BadgeClaimRecord>();
  return {
    rows,
    ...memMintSlots(rows),
    isListed: async (id) => listed.includes(id),
    findClaim: async (k) => rows.get(k) ?? null,
    findClaimByAddress: async (c, to) =>
      [...rows.values()].find(
        (r) => r.chainId === c.chainId && (r.genesisHash ?? c.genesisHash) === c.genesisHash && r.to.toLowerCase() === to.toLowerCase(),
      ) ?? null,
    putClaim: async (r) => {
      const held = rows.get(r.key);
      if (!held || (held.genesisHash && r.genesisHash && held.genesisHash !== r.genesisHash)) rows.set(r.key, r);
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
    const a = await claim(d, ACCOUNT, ADDR, TESTNET);
    const b = await claim(d, ACCOUNT, ADDR, TESTNET);
    expect(mints).toHaveLength(1);
    expect(b).toEqual(a);
    expect(a.key).toBe(`badge:claim:${ACCOUNT}`);
    expect(a.label).toBe('TEST');
    expect(a.audited).toBe(false);
  });

  it('a TEST chain started again: the old claim reads as none, the account claims and mints again, and an old claim to the address blocks nobody', async () => {
    const { d, mints, store } = deps({}, [ACCOUNT, OTHER]);
    const before = await claim(d, ACCOUNT, ADDR, TESTNET);
    expect(before.genesisHash).toBe(GENESIS);
    const restarted = { ...TESTNET, genesisHash: RESTARTED };
    // The mint on the old chain did not happen on this one.
    expect(await badgeEligibility(d, ACCOUNT, restarted)).toMatchObject({ claimed: false, txHash: null });
    const after = await claim(d, ACCOUNT, ADDR, restarted);
    expect(mints).toHaveLength(2);
    expect(after).toMatchObject({ genesisHash: RESTARTED, txHash: `0x${'2'.padStart(64, '0')}` });
    expect(store.rows.size).toBe(1);
    // Still one badge per address on the new chain.
    expect(await refusal(claim(d, OTHER, ADDR, restarted))).toBe('badge.already_claimed');
    // The new claim is this chain's, and eligibility reads it.
    expect(await badgeEligibility(d, ACCOUNT, restarted)).toMatchObject({ claimed: true, txHash: after.txHash });
  });

  it('a claim stored before the genesis column keeps its meaning: it is not minted again', async () => {
    const { d, mints, store } = deps();
    await claim(d, ACCOUNT, ADDR, TESTNET);
    const key = badgeClaimKey(ACCOUNT);
    store.rows.set(key, { ...store.rows.get(key)!, genesisHash: null });
    const again = await claim(d, ACCOUNT, ADDR, { ...TESTNET, genesisHash: RESTARTED });
    expect(mints).toHaveLength(1);
    expect(again.genesisHash).toBeNull();
  });

  it('mints only to the account own address', async () => {
    const { d, mints } = deps();
    await claim(d, ACCOUNT, ADDR, TESTNET);
    expect(mints[0]!.to.toLowerCase()).toBe(ADDR);
  });

  it('blank window refuses badge.window_unset and mints nothing', async () => {
    for (const window of [undefined, null, { opensAt: WINDOW.closesAt, closesAt: WINDOW.opensAt }]) {
      const { d, mints } = deps({ window });
      expect(await refusal(claim(d, ACCOUNT, ADDR, TESTNET))).toBe('badge.window_unset');
      expect(await refusal(badgeEligibility(d, ACCOUNT, TESTNET))).toBe('badge.window_unset');
      expect(mints).toHaveLength(0);
    }
  });

  it('mainnet refuses audit.external and mints nothing', async () => {
    const { d, mints } = deps();
    expect(await refusal(claim(d, ACCOUNT, ADDR, MAINNET))).toBe('audit.external');
    expect(mints).toHaveLength(0);
    expect((await badgeEligibility(d, ACCOUNT, MAINNET)).label).toBe('MAINNET');
  });

  it('no signer for the network refuses rail.crypto', async () => {
    const { d, store } = deps();
    expect(await refusal(claim(d, ACCOUNT, ADDR, { chainId: 1337, genesisHash: GENESIS, mainnet: false }))).toBe('rail.crypto');
    expect(store.rows.size).toBe(0);
  });

  it('an account not on the list refuses badge.not_eligible; empty list invents no one', async () => {
    const { d, mints } = deps({}, []);
    expect(await refusal(claim(d, ACCOUNT, ADDR, TESTNET))).toBe('badge.not_eligible');
    expect((await badgeEligibility(d, ACCOUNT, TESTNET)).eligible).toBe(false);
    expect(mints).toHaveLength(0);
  });

  it('outside the window refuses badge.not_eligible', async () => {
    const { d } = deps({ now: () => new Date('2026-12-01T00:00:00Z') });
    expect(await refusal(claim(d, ACCOUNT, ADDR, TESTNET))).toBe('badge.not_eligible');
  });

  it('no registered own address refuses badge.not_eligible', async () => {
    const { d, mints } = deps();
    for (const a of [null, undefined, '', 'nope']) {
      expect(await refusal(claim(d, ACCOUNT, a, TESTNET))).toBe('badge.not_eligible');
    }
    expect(mints).toHaveLength(0);
  });

  it('a badge already claimed to the same address by another account refuses badge.already_claimed', async () => {
    const { d, mints } = deps({}, [ACCOUNT, OTHER]);
    await claim(d, OTHER, ADDR, TESTNET);
    expect(await refusal(claim(d, ACCOUNT, ADDR, TESTNET))).toBe('badge.already_claimed');
    expect(mints).toHaveLength(1);
  });

  it('crash after mint submitted: retry reuses the stored tx', async () => {
    const { d, mints, store } = deps();
    const first = await claim(d, ACCOUNT, ADDR, TESTNET);
    // window later blanked/closed or list cleared must not re-mint or refuse a finished claim beyond window_unset
    const again = await claim({ ...d, now: () => new Date('2027-01-01T00:00:00Z') }, ACCOUNT, ADDR, TESTNET);
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
    const r = await claim(d, ACCOUNT, ADDR, TESTNET);
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

  it('boot wiring helpers: blank window is null, unknown chain is mainnet, no signer refuses rail.crypto', async () => {
    expect(badgeWindowFromSetting(undefined, '2026-11-01T00:00:00Z')).toBeNull();
    expect(badgeWindowFromSetting('2026-10-01T00:00:00Z', undefined)).toBeNull();
    expect(badgeWindowFromSetting('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')).toEqual(WINDOW);
    expect(badgeChainIsMainnet(84532, [{ chainId: 84532, kind: 'testnet' }])).toBe(false);
    expect(badgeChainIsMainnet(31337, [{ chainId: 31337, kind: 'local' }])).toBe(false);
    expect(badgeChainIsMainnet(1, [])).toBe(true);
    expect(badgeChainIsMainnet(5, [{ chainId: 5, kind: 'unconfirmed' }])).toBe(true);
    const { d } = deps({ minter: noBadgeSigner });
    expect(await refusal(claim(d, ACCOUNT, ADDR, TESTNET))).toBe('rail.crypto');
  });

  it('missing signature refuses badge.not_eligible and stores nothing', async () => {
    const { d, mints, store } = deps();
    for (const sig of [null, '', '0xzz']) {
      expect(await refusal(claim(d, ACCOUNT, ADDR, TESTNET, sig))).toBe('badge.not_eligible');
    }
    expect(store.rows.size).toBe(0);
    expect(mints).toHaveLength(0);
  });

  it('a signature from another key, or over another account or chain, refuses badge.not_eligible', async () => {
    const { d, mints, store } = deps();
    const strangers = await STRANGER_KEY.signMessage({
      message: badgeClaimMessage({ accountId: ACCOUNT, chainId: TESTNET.chainId, address: ADDR as Address }),
    });
    const otherAccount = await OWNER_KEY.signMessage({
      message: badgeClaimMessage({ accountId: OTHER, chainId: TESTNET.chainId, address: ADDR as Address }),
    });
    const otherChain = await OWNER_KEY.signMessage({
      message: badgeClaimMessage({ accountId: ACCOUNT, chainId: 1, address: ADDR as Address }),
    });
    for (const sig of [strangers, otherAccount, otherChain]) {
      expect(await refusal(claim(d, ACCOUNT, ADDR, TESTNET, sig))).toBe('badge.not_eligible');
    }
    expect(store.rows.size).toBe(0);
    expect(mints).toHaveLength(0);
  });

  it('the claim message names badge:claim:<account> and the chain', () => {
    const m = badgeClaimMessage({ accountId: ACCOUNT, chainId: 84532, address: ADDR as Address });
    expect(m).toContain(`badge:claim:${ACCOUNT}`);
    expect(m).toContain('84532');
  });
});
