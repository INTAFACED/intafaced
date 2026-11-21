import { beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  LedgerError,
  MemoryLedger,
  formatAmount,
  ownFundsCostAccount,
  parseAmount,
  recipes,
  treasuryWallet,
  venueBuilderAccount,
} from '@intafaced/ledger-client';
import type { UserVenueAccount } from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { MemoryOwnFundsSweepStore } from './own-funds-sweep-store.js';
import { sweepOwnFunds, type OwnFundsSweepDeps } from './own-funds-sweep.js';

/**
 * Move own funds (OWNER 288 Q4; launch money model): our builder fees, claimed into our builder account at the TEST venue,
 * swept above the float to our TEST wallet, and posted once from the venue's own withdrawal record with its costs. TEST
 * keys and amounts only.
 */
const a = parseAmount;
const KEY = privateKeyToAccount(keccak256(toHex('intafaced TEST own-funds-sweep builder')));
const BUILDER = KEY.address.toLowerCase();
const WALLET = { walletId: 'test-chain:rewards', address: '0x00000000000000000000000000000000000ce510' };
const USER = '11111111-1111-4111-8111-1111111111d1';

let sim: TestVenueSimulator;
let ledger: MemoryLedger;
let store: MemoryOwnFundsSweepStore;
let clock: number;
const builderAccount = (): UserVenueAccount => ({ venueId: sim.venue.id, owner: BUILDER, subAccount: null });
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const signer = {
  address: BUILDER,
  sign: async (typedData: unknown) => {
    const t = typedData as TestVenueTypedData;
    return KEY.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  },
};
const deps = (over: Partial<OwnFundsSweepDeps> = {}): OwnFundsSweepDeps => ({
  venue: sim,
  builder: BUILDER,
  signer,
  float: a('2'),
  wallet: WALLET,
  store,
  ledger,
  ...over,
});

/** `amount` of builder fees earned, claimed at the venue, and collected into our book. */
async function collected(amount: string, n: number) {
  sim.deposit(builderAccount(), 'USDC', a(amount), `TEST-claim-${n}`);
  await ledger.post(
    recipes.builderFeeEarn({
      venueId: sim.venue.id,
      venueAccount: '0xtrader',
      fillId: `f${n}`,
      assetId: 'USDC',
      amount: a(amount),
      userId: USER,
    }),
  );
  await ledger.post(recipes.builderFeeReceive({ venueId: sim.venue.id, claimId: `c${n}`, assetId: 'USDC', amount: a(amount) }));
}
const pay = (txHash: string) => {
  const [pending] = sim.pendingWithdrawals();
  expect(sim.settleWithdrawal(pending!.account, pending!.nonce, 'done', txHash)).toBe(true);
};

beforeEach(() => {
  clock = Date.UTC(2026, 10, 14, 13);
  sim = new TestVenueSimulator({ clock: () => new Date((clock += 1000)), markets: TEST_VENUE_MARKETS });
  ledger = new MemoryLedger();
  store = new MemoryOwnFundsSweepStore();
});

describe('sweepOwnFunds', () => {
  it('waits, naming the owner value it needs, and moves nothing', async () => {
    await collected('10', 1);
    expect(await sweepOwnFunds(deps({ float: null }))).toEqual({ status: 'waiting', reason: 'trade.own_funds_float_unset' });
    expect(await sweepOwnFunds(deps({ wallet: null }))).toEqual({ status: 'waiting', reason: 'trade.own_funds_wallet_unset' });
    expect(await sweepOwnFunds(deps({ signer: null }))).toEqual({ status: 'waiting', reason: 'trade.builder_signer_unset' });
    expect(await sweepOwnFunds(deps({ signer: { ...signer, address: WALLET.address } }))).toEqual({
      status: 'waiting',
      reason: 'trade.builder_signer_mismatch',
    });
    expect(sim.pendingWithdrawals()).toEqual([]);
  });

  it('sweeps what is above the float once, and posts the move with its costs from the venue record, once', async () => {
    await collected('10', 1);
    const sent = await sweepOwnFunds(deps());
    expect(sent).toEqual({ status: 'sent', key: `own-funds-sweep:${sim.venue.id}:1` });
    // 8 above the 2 float; the venue takes its 1 fee from what stays, and 0.25 of network fee from what arrives.
    expect(sim.pendingWithdrawals()).toHaveLength(1);
    expect(sim.pendingWithdrawals()[0]!.withdrawal).toMatchObject({ amount: a('8'), destination: WALLET.address });
    expect(await sweepOwnFunds(deps())).toMatchObject({ status: 'pending' });
    expect(sim.pendingWithdrawals()).toHaveLength(1);
    pay('0xabc1');
    const posted = await sweepOwnFunds(deps());
    expect(posted).toMatchObject({ status: 'posted', moved: '8' });
    expect(await bal(venueBuilderAccount(sim.venue.id, 'USDC'))).toBe('-1');
    expect(await bal(treasuryWallet(WALLET.walletId, 'USDC'))).toBe('-7.75');
    expect(await bal(ownFundsCostAccount('venue-withdrawal-fee', sim.venue.id, 'USDC'))).toBe('-1');
    expect(await bal(ownFundsCostAccount('network-fee', 'test-chain', 'USDC'))).toBe('-0.25');
    // The book's builder account matches the venue's own figure.
    const free = (await sim.balances(builderAccount())).value.find((b) => b.asset === 'USDC')!.free;
    expect(formatAmount(free)).toBe('1');
    // Nothing above the float now: no second sweep, no second post.
    expect(await sweepOwnFunds(deps())).toEqual({ status: 'nothing_above_float', held: a('1') });
    expect(ledger.journal().filter((t) => t.reason === 'treasury.own_funds.moved')).toHaveLength(1);
    expect(sim.pendingWithdrawals()).toEqual([]);
  });

  it('sweeps only what the book shows, when the venue holds more than has been collected', async () => {
    await collected('5', 1);
    sim.deposit(builderAccount(), 'USDC', a('100'), 'TEST-unclaimed-in-book');
    expect(await sweepOwnFunds(deps())).toMatchObject({ status: 'sent' });
    expect(sim.pendingWithdrawals()[0]!.withdrawal.amount).toBe(a('3'));
  });

  it('a send whose answer was lost is read back by its nonce and the same bytes sent again, never a new withdrawal', async () => {
    await collected('10', 1);
    sim.loseAnswersOn(builderAccount(), 1);
    expect(await sweepOwnFunds(deps())).toMatchObject({ status: 'sent' });
    // The venue applied it (only its answer was lost): read back as pending, nothing new is prepared.
    expect(await sweepOwnFunds(deps())).toMatchObject({ status: 'pending' });
    expect(sim.pendingWithdrawals()).toHaveLength(1);
    expect(await store.count(sim.venue.id)).toBe(1);
  });

  it('holds, without posting, a done withdrawal whose record names no transaction or no fee', async () => {
    await collected('10', 1);
    await sweepOwnFunds(deps());
    const [pending] = sim.pendingWithdrawals();
    sim.settleWithdrawal(pending!.account, pending!.nonce, 'done');
    expect(await sweepOwnFunds(deps())).toMatchObject({ status: 'held', reason: 'trade.own_funds_sweep_tx_unreported' });
    expect(ledger.journal().filter((t) => t.reason === 'treasury.own_funds.moved')).toHaveLength(0);
    // Still open: no second sweep is started over it.
    expect(await sweepOwnFunds(deps())).toMatchObject({ status: 'held' });
    expect(await store.count(sim.venue.id)).toBe(1);
  });

  it('a withdrawal the venue failed returned the funds: nothing is posted, and the next run sweeps again', async () => {
    await collected('10', 1);
    await sweepOwnFunds(deps());
    const [pending] = sim.pendingWithdrawals();
    sim.settleWithdrawal(pending!.account, pending!.nonce, 'failed');
    expect(await sweepOwnFunds(deps())).toMatchObject({ status: 'failed' });
    expect(ledger.journal().filter((t) => t.reason === 'treasury.own_funds.moved')).toHaveLength(0);
    expect(await sweepOwnFunds(deps())).toEqual({ status: 'sent', key: `own-funds-sweep:${sim.venue.id}:2` });
  });

  it('under the posting freeze the move stays open with its code, and posts once when it lifts', async () => {
    await collected('10', 1);
    await sweepOwnFunds(deps());
    pay('0xabc2');
    const frozen = async () => Promise.reject(new LedgerError('the posting freeze is on', 'ledger.frozen'));
    const held = await sweepOwnFunds(deps({ ledger: { post: frozen, balance: (r) => ledger.balance(r) } }));
    expect(held).toMatchObject({ status: 'held', reason: 'ledger.frozen' });
    expect(ledger.journal().filter((t) => t.reason === 'treasury.own_funds.moved')).toHaveLength(0);
    expect(await sweepOwnFunds(deps())).toMatchObject({ status: 'posted' });
    expect(await sweepOwnFunds(deps())).toMatchObject({ status: 'nothing_above_float' });
    expect(ledger.journal().filter((t) => t.reason === 'treasury.own_funds.moved')).toHaveLength(1);
  });
});
