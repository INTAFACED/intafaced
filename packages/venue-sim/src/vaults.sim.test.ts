import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PreparedVenueAction, type UserVenueAccount, type VenueIntent } from '@intafaced/venue-contracts';
import { TEST_VENUE_VAULTS, TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_MARKETS } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';

/**
 * J-derivatives-31 at the venue: a vault is the venue's. A deposit and a withdrawal are the owner's own signed transfers,
 * each applied once; the venue keeps the lock-up and refuses a withdrawal before it ends, naming the time; the leader's
 * profit share is taken on the gain; the position counts in the account's value. Every figure is TEST.
 */

const a = parseAmount;
const BTC_USDC = { ...TEST_VENUE_MARKETS.find((m) => m.symbol === 'BTC-USDC')! };
const [PROTOCOL, LEADER] = TEST_VENUE_VAULTS;

function testWallet(name: string) {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet ${name}`)));
  const address = key.address.toLowerCase();
  return {
    address,
    signer: { role: 'owner', address } as const,
    async sign(prepared: PreparedVenueAction) {
      const typed = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      });
      return { digest: prepared.digest, signature, signedBy: address };
    },
  };
}

async function world() {
  let now = Date.UTC(2026, 10, 21, 6, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: [BTC_USDC] });
  const person = testWallet('jd31-person');
  const account: UserVenueAccount = { venueId: sim.venue.id, owner: person.address, subAccount: null };
  sim.deposit(account, 'USDC', a('500'), 'chain:jd31:person');
  const move = (vault: string, direction: 'deposit' | 'withdraw', amount: string, key: string): VenueIntent => ({
    kind: 'vault_transfer',
    vault,
    direction,
    asset: 'USDC',
    amount: a(amount),
    moveKey: key,
  });
  const run = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, person.signer, intent);
    const signature = await person.sign(prepared);
    const outcome = await sim.submit(prepared, signature);
    now += 1000;
    return { outcome, prepared, signature };
  };
  const free = async () => formatAmount((await sim.balances(account)).value.find((b) => b.asset === 'USDC')?.free ?? 0n);
  const holdings = async () => (await sim.vaultHoldings(account)).value;
  const later = (ms: number) => (now += ms);
  return { sim, person, account, move, run, free, holdings, later };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof VenueRefusalError) return e.refusal;
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('J-derivatives-31 venue vaults (TEST)', () => {
  it('lists each vault with its lock-up, profit share, value and past return; a figure it does not publish is null', async () => {
    const { sim } = await world();
    const vaults = (await sim.vaults()).value;
    expect(vaults.map((v) => v.name)).toEqual(['TEST protocol vault', 'TEST leader vault']);
    expect(vaults[0]).toMatchObject({ kind: 'protocol', leader: null, lockUpSeconds: 4 * 86_400, profitShareBps: 0, vaultValue: 0n });
    expect(vaults[0]!.pastReturn).toEqual({ bps: 120, days: 30 });
    expect(vaults[1]).toMatchObject({ kind: 'user', lockUpSeconds: 86_400, profitShareBps: 1_000, pastReturn: null });
  });

  it('a deposit moves free USDC into the position once, sets its lock-up, and counts in the account value', async () => {
    const { sim, move, run, free, holdings } = await world();
    const before = (await holdings()).accountValue;
    expect(before).toEqual({ asset: 'USDC', amount: a('500') });
    const sent = await run(move(PROTOCOL!.address, 'deposit', '100', 'vault-move:jd31:protocol:deposit:d1'));
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
    // The same signed bytes again are the venue's first answer: nothing moves twice.
    expect(await sim.submit(sent.prepared, sent.signature)).toEqual(sent.outcome);
    expect(await free()).toBe('400');
    const held = await holdings();
    expect(held.positions).toHaveLength(1);
    expect(held.positions[0]).toMatchObject({ vault: PROTOCOL!.address, equity: a('100') });
    expect(held.positions[0]!.lockUpEndsAt.getTime()).toBe(sent.prepared.preparedAt.getTime() + 4 * 86_400_000);
    // The account value counts the vault position: 400 free and 100 in the vault, still 500.
    expect(held.accountValue).toEqual({ asset: 'USDC', amount: a('500') });
    expect(held.transfers).toHaveLength(1);
    expect((await sim.vaults()).value[0]!.vaultValue).toBe(a('100'));
  });

  it('refuses a deposit above free USDC before anything is signed', async () => {
    const { sim, person, account, move } = await world();
    const r = await refusal(sim.prepare(account, person.signer, move(PROTOCOL!.address, 'deposit', '600', 'vault-move:jd31:p:d:big')));
    expect(r.code).toBe('insufficient_balance');
  });

  it('refuses a withdrawal before the lock-up ends, naming the time it ends, at prepare and again at submit', async () => {
    const { sim, person, account, move, run, holdings, later } = await world();
    await run(move(PROTOCOL!.address, 'deposit', '100', 'vault-move:jd31:protocol:deposit:d1'));
    const ends = (await holdings()).positions[0]!.lockUpEndsAt;
    const early = move(PROTOCOL!.address, 'withdraw', '100', 'vault-move:jd31:protocol:withdraw:w1');
    const r = await refusal(sim.prepare(account, person.signer, early));
    expect(r.code).toBe('venue_rejected');
    expect(r.detail).toContain(ends.toISOString());
    // The venue checks again at submit: a withdrawal prepared once the lock-up ended, then sent after a new deposit
    // started a new lock-up, is refused on the signed fields, and nothing comes out.
    later(4 * 86_400_000);
    const prepared = await sim.prepare(account, person.signer, early);
    const signature = await person.sign(prepared);
    await run(move(PROTOCOL!.address, 'deposit', '1', 'vault-move:jd31:protocol:deposit:d2'));
    const outcome = await sim.submit(prepared, signature);
    expect(outcome).toMatchObject({ definite: true, accepted: false, refusal: { code: 'venue_rejected' } });
    expect((await holdings()).positions[0]!.equity).toBe(a('101'));
  });

  it('after the lock-up a withdrawal credits free USDC once; the leader takes its share of the gain only', async () => {
    const { sim, account, move, run, free, holdings } = await world();
    await run(move(LEADER!.address, 'deposit', '100', 'vault-move:jd31:leader:deposit:d1'));
    sim.testVaultLockUpPassed(account, LEADER!.address);
    const out = await run(move(LEADER!.address, 'withdraw', '100', 'vault-move:jd31:leader:withdraw:w1'));
    expect(out.outcome).toMatchObject({ definite: true, accepted: true });
    expect(await sim.submit(out.prepared, out.signature)).toEqual(out.outcome);
    // No gain: the leader took nothing, and all 100 came back.
    expect(await free()).toBe('500');
    const held = await holdings();
    expect(held.positions).toEqual([]);
    expect(held.transfers[0]).toMatchObject({ direction: 'withdraw', amount: a('100'), creditedAmount: a('100'), leaderShare: a('0') });
  });

  it('the lock-up control passes one position only', async () => {
    const { sim, account, move, run } = await world();
    const other = testWallet('jd31-other');
    const otherAccount: UserVenueAccount = { venueId: sim.venue.id, owner: other.address, subAccount: null };
    sim.deposit(otherAccount, 'USDC', a('50'), 'chain:jd31:other');
    const p = await sim.prepare(otherAccount, other.signer, {
      kind: 'vault_transfer',
      vault: PROTOCOL!.address,
      direction: 'deposit',
      asset: 'USDC',
      amount: a('50'),
      moveKey: 'vault-move:jd31:other:deposit:d1',
    });
    await sim.submit(p, await other.sign(p));
    await run(move(PROTOCOL!.address, 'deposit', '100', 'vault-move:jd31:protocol:deposit:d1'));
    sim.testVaultLockUpPassed(account, PROTOCOL!.address);
    const r = await refusal(
      sim.prepare(otherAccount, other.signer, {
        kind: 'vault_transfer',
        vault: PROTOCOL!.address,
        direction: 'withdraw',
        asset: 'USDC',
        amount: a('50'),
        moveKey: 'vault-move:jd31:other:withdraw:w1',
      }),
    );
    expect(r.code).toBe('venue_rejected');
  });

  it('refuses an agent key a vault move', async () => {
    const { sim, account, move } = await world();
    const r = await refusal(
      sim.prepare(account, { role: 'agent', address: '0xagent' }, move(PROTOCOL!.address, 'deposit', '1', 'vault-move:a:b:c')),
    );
    expect(r.code).toBe('agent_not_permitted');
  });
});
