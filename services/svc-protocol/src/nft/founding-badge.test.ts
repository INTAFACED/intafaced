import { describe, expect, it } from 'vitest';
import { isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  badgeClaimKey,
  badgeClaimMessage,
  badgeChainIsMainnet,
  badgeChainIsRestartable,
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
/** A network on chain `chainId` whose block 0 is `genesisHash`; `restartable` only for a chain started again (local, TEST). */
const net = (chainId: number, mainnet: boolean, genesisHash: Hex = GENESIS, restartable = false) => ({
  chainId,
  mainnet,
  restartable,
  identity: async () => ({ chainId, genesisHash }),
});
const TESTNET = net(84532, false);
const MAINNET = net(8453, true);
const WINDOW = { opensAt: new Date('2026-10-01T00:00:00Z'), closesAt: new Date('2026-11-01T00:00:00Z') };

const OWNER_KEY = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const STRANGER_KEY = privateKeyToAccount(`0x${'22'.repeat(32)}`);

async function claim(
  d: BadgeDeps,
  accountId: string,
  addr: string | null | undefined,
  network: ReturnType<typeof net>,
  signature?: string | null,
) {
  const sig =
    signature !== undefined
      ? signature
      : addr && isAddress(addr)
        ? await OWNER_KEY.signMessage({ message: badgeClaimMessage({ accountId, chainId: network.chainId, address: addr as Address }) })
        : null;
  return claimBadge(d, accountId, addr ? { address: addr, owner: OWNER_KEY.address } : null, network, sig);
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
    putClaim: async (r, opts) => {
      const held = rows.get(r.key);
      const otherGenesis = held?.genesisHash && r.genesisHash && held.genesisHash !== r.genesisHash;
      if (!held || (otherGenesis && opts.replaceOtherGenesis)) rows.set(r.key, r);
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
    const before = await claim(d, ACCOUNT, ADDR, net(84532, false, GENESIS, true));
    expect(before.genesisHash).toBe(GENESIS);
    const restarted = net(84532, false, RESTARTED, true);
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

  it('a chain that is not started again answering with another genesis refuses badge.chain_changed: the claim is kept and nothing mints again', async () => {
    const { d, mints, store } = deps();
    const first = await claim(d, ACCOUNT, ADDR, TESTNET);
    expect(first.txHash).not.toBeNull();
    // Same chain id, a node now answering with another block 0 (a misrouted or wrong RPC on a long-lived testnet).
    const flipped = net(84532, false, RESTARTED);
    expect(await refusal(claim(d, ACCOUNT, ADDR, flipped))).toBe('badge.chain_changed');
    expect(await refusal(badgeEligibility(d, ACCOUNT, flipped))).toBe('badge.chain_changed');
    expect(mints).toHaveLength(1);
    expect(store.rows.get(badgeClaimKey(ACCOUNT))).toMatchObject({ genesisHash: GENESIS, txHash: first.txHash });
    // The chain answering as itself again reads the claim as before.
    expect(await badgeEligibility(d, ACCOUNT, TESTNET)).toMatchObject({ claimed: true, txHash: first.txHash });
  });

  it('eligibility reads the chain again before refusing: a stray reused answer does not refuse when the chain answers as itself', async () => {
    const { d } = deps();
    await claim(d, ACCOUNT, ADDR, TESTNET);
    const reads: Array<boolean> = [];
    // The reused identity is a stray answer from another node; a fresh read is this chain.
    const stray = {
      ...TESTNET,
      identity: async (opts?: { fresh?: boolean }) => (
        reads.push(!!opts?.fresh),
        { chainId: 84532, genesisHash: opts?.fresh ? GENESIS : RESTARTED }
      ),
    };
    expect(await badgeEligibility(d, ACCOUNT, stray)).toMatchObject({ claimed: true });
    expect(reads).toEqual([false, true]);
  });

  it('a claim from another genesis stored by a racing call after the read is not replaced on a chain that is not started again', async () => {
    const { d, mints, store } = deps();
    const key = badgeClaimKey(ACCOUNT);
    // The racing call's row lands between this call's findClaim (none) and its putClaim.
    const findClaim = store.findClaim;
    store.findClaim = async (k) => {
      const seen = await findClaim(k);
      store.rows.set(key, { key, accountId: ACCOUNT, chainId: 84532, genesisHash: RESTARTED, to: ADDR as Address, txHash: null });
      store.findClaim = findClaim;
      return seen;
    };
    expect(await refusal(claim(d, ACCOUNT, ADDR, TESTNET))).toBe('badge.chain_changed');
    expect(mints).toHaveLength(0);
    expect(store.rows.get(key)).toMatchObject({ genesisHash: RESTARTED, txHash: null });
  });

  it('eligibility asks the chain only when a stored claim names a genesis', async () => {
    const { d } = deps();
    let asked = 0;
    const counting = { ...TESTNET, identity: async () => (asked++, { chainId: TESTNET.chainId, genesisHash: GENESIS }) };
    expect(await badgeEligibility(d, ACCOUNT, counting)).toMatchObject({ claimed: false });
    expect(asked).toBe(0);
    await claim(d, ACCOUNT, ADDR, TESTNET);
    expect(await badgeEligibility(d, ACCOUNT, counting)).toMatchObject({ claimed: true });
    expect(asked).toBe(1);
  });

  it('a claim stored before the genesis column keeps its meaning: it is not minted again', async () => {
    const { d, mints, store } = deps();
    await claim(d, ACCOUNT, ADDR, TESTNET);
    const key = badgeClaimKey(ACCOUNT);
    store.rows.set(key, { ...store.rows.get(key)!, genesisHash: null });
    const again = await claim(d, ACCOUNT, ADDR, net(84532, false, RESTARTED));
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
    expect(await refusal(claim(d, ACCOUNT, ADDR, net(1337, false)))).toBe('rail.crypto');
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
    // Only a chain that is started again resets a claim on a new genesis: a `local` registry chain, or APP_ENV dev/test.
    // Only a chain that is started again resets a claim on a new genesis: a `local` registry chain, or the local test
    // stack (APP_ENV dev/test and a loopback RPC). A dev or test service on a public testnet's RPC is not.
    const TESTNET_REG = [{ chainId: 84532, kind: 'testnet' }];
    const ANVIL = 'http://127.0.0.1:8545';
    expect(badgeChainIsRestartable(31337, [{ chainId: 31337, kind: 'local' }], 'production', 'https://rpc.example')).toBe(true);
    expect(badgeChainIsRestartable(84532, TESTNET_REG, 'test', ANVIL)).toBe(true);
    expect(badgeChainIsRestartable(84532, TESTNET_REG, 'dev', 'http://localhost:8545')).toBe(true);
    expect(badgeChainIsRestartable(84532, TESTNET_REG, 'test', 'https://sepolia.base.org')).toBe(false);
    expect(badgeChainIsRestartable(84532, TESTNET_REG, 'dev', undefined)).toBe(false);
    expect(badgeChainIsRestartable(84532, TESTNET_REG, 'staging', ANVIL)).toBe(false);
    expect(badgeChainIsRestartable(84532, TESTNET_REG, undefined, ANVIL)).toBe(false);
    expect(badgeChainIsRestartable(31337, [{ chainId: 84532, kind: 'local' }], undefined, ANVIL)).toBe(false);
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
