import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { venueDepositRef, type UserVenueAccount, type UserVenueDepositRoute, type WithdrawIntent } from '@intafaced/venue-contracts';
import { TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_MARKETS, answerTestVenue } from './http-server.js';
import {
  amountToTokenUnits,
  creditDepositLogs,
  payPendingWithdrawals,
  completeLogs,
  LOST_PAYMENT_AFTER_MS,
  tokenUnitsToAmount,
  type DepositLog,
  type WithdrawalPayer,
  type WithdrawalPayment,
} from './chain-deposits.js';
import type { TestVenueTypedData } from './signing.js';

// J-wallet-09 #3 and #5 on the TEST venue: a deposit is the customer's own transfer to the venue's deposit address,
// credited once by its transfer id; a withdrawal is pending, then paid on chain (the amount less the network fee) and
// done. Every figure is TEST. Nothing here touches a ledger.

const a = parseAmount;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet chain-deposits')));
const owner = key.address.toLowerCase();
const ROUTE: UserVenueDepositRoute = {
  chainId: 84532,
  token: '0x000000000000000000000000000000000000d011',
  tokenDecimals: 6,
  address: '0x00000000000000000000000000000000de905170',
  asset: 'USDC',
};
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function world() {
  let now = Date.UTC(2026, 10, 9, 9, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: TEST_VENUE_MARKETS, chainId: ROUTE.chainId });
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const free = async () => (await sim.balances(account)).value.find((b) => b.asset === 'USDC')?.free ?? 0n;
  const withdraw = async (amount: string, n: number) => {
    const intent: WithdrawIntent = {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a(amount),
      destination: owner,
      withdrawalKey: `withdraw:${owner}:${n}`,
    };
    const prepared = await sim.prepare(account, { role: 'owner', address: owner }, intent);
    const typed = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    const outcome = await sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
    expect(outcome).toMatchObject({ definite: true, accepted: true });
    return prepared.nonce;
  };
  const deposit = (value: bigint, n: number, extra: Partial<DepositLog> = {}): DepositLog => ({
    transactionHash: hash(n),
    logIndex: 0,
    from: owner,
    to: ROUTE.address,
    value,
    ...extra,
  });
  return { sim, account, free, withdraw, deposit, advance: (ms: number) => (now += ms), now: () => new Date(now) };
}

/** A chain payer that records what it sent, mined (or reverted) on demand. */
function fakePayer() {
  const sent: Array<{ to: string; units: bigint; hash: string }> = [];
  const receipts = new Map<string, boolean | null>();
  const loseAnswerOf = new Set<number>();
  let rejectNext = false;
  let sends = 0;
  let holds = 10n ** 12n;
  const payer: WithdrawalPayer = {
    head: async () => 7n,
    holds: async () => holds,
    async send(to, units) {
      sends += 1;
      if (rejectNext) {
        rejectNext = false;
        // The node never took the transfer, and said nothing.
        throw new Error('connection reset');
      }
      const h = hash(1000 + sent.length);
      sent.push({ to, units, hash: h });
      receipts.set(h, null);
      if (loseAnswerOf.delete(sent.length - 1)) {
        // The node took the transfer, and the answer was lost.
        throw new Error('timeout');
      }
      return h;
    },
    async receipt(h) {
      return receipts.get(h) ?? null;
    },
    async find(to, units, fromBlock) {
      expect(fromBlock).toBe(7n);
      return sent.filter((p) => p.to === to && p.units === units).map((p) => p.hash);
    },
  };
  return {
    payer,
    sent,
    sends: () => sends,
    rejectNext: () => {
      rejectNext = true;
    },
    mine: (h: string, ok = true) => receipts.set(h, ok),
    /** What the deposit address holds on the chain. */
    setHolds: (units: bigint) => {
      holds = units;
    },
    loseNextAnswer: () => {
      loseAnswerOf.add(sent.length);
    },
    /** The answer to the n-th transfer the node takes (0-based) is lost. */
    loseAnswerOf: (n: number) => {
      loseAnswerOf.add(n);
    },
  };
}

describe('TEST venue deposits from the chain (J-wallet-09 #3)', () => {
  it('credits the sender by the transfer id, once: a replayed log credits nothing', async () => {
    const w = world();
    const first = creditDepositLogs(w.sim, ROUTE, [w.deposit(25_000_000n, 1)]);
    expect(first).toEqual({ credited: [venueDepositRef(84532, hash(1), 0)], replayed: [], confirming: [], notCredited: [] });
    expect(await w.free()).toBe(a('25'));
    // The same log read again (a restarted watcher, an overlapping block range) is the same deposit.
    const again = creditDepositLogs(w.sim, ROUTE, [w.deposit(25_000_000n, 1)]);
    expect(again).toEqual({ credited: [], replayed: [venueDepositRef(84532, hash(1), 0)], confirming: [], notCredited: [] });
    expect(await w.free()).toBe(a('25'));
    // A second log in the same transaction is its own deposit.
    creditDepositLogs(w.sim, ROUTE, [w.deposit(1_500_000n, 1, { logIndex: 1 })]);
    expect(await w.free()).toBe(a('26.5'));
  });

  it('credits nothing for a dropped log, a transfer elsewhere, a zero transfer, or the deposit address paying out', async () => {
    const w = world();
    const result = creditDepositLogs(w.sim, ROUTE, [
      w.deposit(5_000_000n, 2, { removed: true }),
      w.deposit(5_000_000n, 3, { to: '0x0000000000000000000000000000000000000001' }),
      w.deposit(0n, 4),
      w.deposit(5_000_000n, 5, { from: ROUTE.address }),
    ]);
    expect(result).toEqual({ credited: [], replayed: [], confirming: [], notCredited: [] });
    expect(await w.free()).toBe(0n);
    expect((await w.sim.deposits(w.account)).value).toEqual([]);
  });

  it('turns token units into Amounts exactly, and back rounding down', () => {
    expect(tokenUnitsToAmount(25_000_001n, 6)).toBe(a('25.000001'));
    expect(amountToTokenUnits(a('23.7500009'), 6)).toBe(23_750_000n);
    expect(amountToTokenUnits(a('-1'), 6)).toBe(0n);
    expect(() => tokenUnitsToAmount(1n, 19)).toThrow(/0 to 18/);
  });
});

describe("TEST venue deposits keep the venue's published terms (J-dex-protocol-05 #1, #2)", () => {
  const TERMS: UserVenueDepositRoute = { ...ROUTE, minimum: '5', confirmations: 3, network: 'TEST chain' };

  it('is confirming until its block has the published confirmations, then credited once, and listed throughout', async () => {
    const w = world();
    const ref = venueDepositRef(84532, hash(7), 0);
    // Mined in block 10 with the head at 10: one confirmation of three.
    expect(creditDepositLogs(w.sim, TERMS, [w.deposit(25_000_000n, 7, { blockNumber: 10n })], 10n)).toEqual({
      credited: [],
      replayed: [],
      confirming: [ref],
      notCredited: [],
    });
    expect(await w.free()).toBe(0n);
    const seenAt = w.now();
    expect((await w.sim.deposits(w.account)).value).toEqual([
      {
        depositRef: ref,
        txHash: hash(7),
        asset: 'USDC',
        amount: a('25'),
        status: 'confirming',
        confirmations: 1,
        required: 3,
        reason: null,
        seenAt,
        explorerUrl: null,
      },
    ]);
    // Head 11: two of three, still not credited.
    w.advance(1000);
    creditDepositLogs(w.sim, TERMS, [w.deposit(25_000_000n, 7, { blockNumber: 10n })], 11n);
    expect(await w.free()).toBe(0n);
    expect((await w.sim.deposits(w.account)).value[0]).toMatchObject({ status: 'confirming', confirmations: 2 });
    // Head 12: three of three, credited; a later read credits nothing more, and the first sighting's time is kept.
    expect(creditDepositLogs(w.sim, TERMS, [w.deposit(25_000_000n, 7, { blockNumber: 10n })], 12n).credited).toEqual([ref]);
    expect(creditDepositLogs(w.sim, TERMS, [w.deposit(25_000_000n, 7, { blockNumber: 10n })], 40n).replayed).toEqual([ref]);
    expect(await w.free()).toBe(a('25'));
    expect((await w.sim.deposits(w.account)).value).toEqual([
      {
        depositRef: ref,
        txHash: hash(7),
        asset: 'USDC',
        amount: a('25'),
        status: 'credited',
        confirmations: 3,
        required: 3,
        reason: null,
        seenAt,
        explorerUrl: null,
      },
    ]);
  });

  it('never credits a transfer below the minimum, however deep, and lists it as not credited; exactly the minimum is credited', async () => {
    const w = world();
    const below = creditDepositLogs(w.sim, TERMS, [w.deposit(4_999_999n, 8, { blockNumber: 1n })], 50n);
    expect(below.notCredited).toEqual([venueDepositRef(84532, hash(8), 0)]);
    expect(await w.free()).toBe(0n);
    expect(creditDepositLogs(w.sim, TERMS, [w.deposit(5_000_000n, 9, { blockNumber: 1n })], 50n).credited).toHaveLength(1);
    expect(await w.free()).toBe(a('5'));
    // Newest first: the credited one, then the one below the minimum.
    expect((await w.sim.deposits(w.account)).value.map((d) => [d.amount, d.status, d.reason])).toEqual([
      [a('5'), 'credited', null],
      [a('4.999999'), 'not_credited', 'below_minimum'],
    ]);
  });

  it('lists only the asking account’s deposits, and travels on the wire with its amount as a decimal string', async () => {
    const w = world();
    creditDepositLogs(
      w.sim,
      TERMS,
      [w.deposit(6_000_000n, 10, { blockNumber: 3n }), w.deposit(6_000_000n, 11, { from: '0x' + '1'.repeat(40) })],
      3n,
    );
    const [status, body] = await answerTestVenue(w.sim, 'POST', '/deposits', JSON.stringify({ account: w.account }), TERMS);
    expect(status).toBe(200);
    const wire = body as { value: Array<Record<string, unknown>> };
    expect(wire.value).toHaveLength(1);
    expect(wire.value[0]).toMatchObject({ amount: '6', status: 'confirming', confirmations: 1, required: 3, txHash: hash(10) });
  });

  it('links each deposit to the explorer the venue names, or gives none for a network without one', async () => {
    const w = world();
    creditDepositLogs(w.sim, TERMS, [w.deposit(6_000_000n, 13, { blockNumber: 3n })], 3n);
    expect((await w.sim.deposits(w.account)).value[0]!.explorerUrl).toBeNull();
    const [ok] = await answerTestVenue(w.sim, 'POST', '/test/switches', JSON.stringify({ depositExplorerTxUrl: '/chain/tx/' }), TERMS);
    expect(ok).toBe(200);
    expect((await w.sim.deposits(w.account)).value[0]!.explorerUrl).toBe(`/chain/tx/${hash(13)}`);
    // Only https or a path on the app: a script URL or another scheme is refused, and the link stays as it was.
    for (const bad of ['javascript:alert(1)', 'http://x.test/tx/', '//x.test/tx/']) {
      const [status] = await answerTestVenue(w.sim, 'POST', '/test/switches', JSON.stringify({ depositExplorerTxUrl: bad }), TERMS);
      expect(status, bad).toBeGreaterThanOrEqual(400);
    }
    expect(w.sim.switches.depositExplorerTxUrl).toBe('/chain/tx/');
    await answerTestVenue(w.sim, 'POST', '/test/switches', JSON.stringify({ depositExplorerTxUrl: null }), TERMS);
    expect((await w.sim.deposits(w.account)).value[0]!.explorerUrl).toBeNull();
  });

  it('a route with no published terms credits at once, as before', async () => {
    const w = world();
    expect(creditDepositLogs(w.sim, ROUTE, [w.deposit(1n, 12, { blockNumber: 5n })], 5n).credited).toHaveLength(1);
    expect(await w.free()).toBe(a('0.000001'));
  });
});

describe('TEST venue withdrawals paid on the chain (J-wallet-09 #5)', () => {
  it('is pending, then paid once (the amount less the network fee) and done, with the venue fee and network fee', async () => {
    const w = world();
    creditDepositLogs(w.sim, ROUTE, [w.deposit(25_000_000n, 1)]);
    const nonce = await w.withdraw('10', 1);
    const pending = (await w.sim.withdrawal(w.account, nonce)).value;
    expect(pending).toMatchObject({
      status: 'pending',
      amount: a('10'),
      fee: { known: true, value: a('1') },
      networkFee: { known: true, value: a('0.25') },
    });
    // The venue takes the amount and its fee from free; the network fee comes out of what arrives.
    expect(await w.free()).toBe(a('14'));
    const chain = fakePayer();
    const paid = new Map<string, WithdrawalPayment>();
    // Before the venue's delay nothing is paid.
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [], failed: [] });
    expect(chain.sent).toEqual([]);
    w.advance(5000);
    // Sent, not yet mined: still pending, and a second pass waits on the same payment instead of sending again.
    await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000);
    await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000);
    expect(chain.sent).toEqual([{ to: owner, units: 9_750_000n, hash: hash(1000) }]);
    expect((await w.sim.withdrawal(w.account, nonce)).value?.status).toBe('pending');
    chain.mine(hash(1000));
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [nonce], failed: [] });
    expect((await w.sim.withdrawal(w.account, nonce)).value?.status).toBe('done');
    // The venue's record names the chain transaction that paid it.
    expect((await w.sim.withdrawal(w.account, nonce)).value?.txHash).toBe(hash(1000).toLowerCase());
    // Done stays done: nothing is paid again.
    await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000);
    expect(chain.sent).toHaveLength(1);
    expect(await w.free()).toBe(a('14'));
  });

  it('a payment whose answer was lost is found on chain and never sent again', async () => {
    const w = world();
    creditDepositLogs(w.sim, ROUTE, [w.deposit(25_000_000n, 1)]);
    const nonce = await w.withdraw('10', 4);
    const chain = fakePayer();
    const paid = new Map<string, WithdrawalPayment>();
    w.advance(5000);
    chain.loseNextAnswer();
    const errors: string[] = [];
    await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000, (n, err) => errors.push(`${n}: ${(err as Error).message}`));
    expect(errors).toEqual([`${nonce}: timeout`]);
    chain.mine(hash(1000));
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [nonce], failed: [] });
    expect(chain.sent).toHaveLength(1);
  });

  it('two withdrawals to the same wallet for the same amount are settled by two transfers, never one', async () => {
    const w = world();
    creditDepositLogs(w.sim, ROUTE, [w.deposit(25_000_000n, 1)]);
    const first = await w.withdraw('5', 6);
    const second = await w.withdraw('5', 7);
    const chain = fakePayer();
    const paid = new Map<string, WithdrawalPayment>();
    w.advance(5000);
    // The first send is answered and not mined yet; the second is taken by the node and its answer is lost.
    chain.loseAnswerOf(1);
    await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000);
    expect(chain.sent).toHaveLength(2);
    // Only the first transfer is mined: the second withdrawal may not claim it, so it waits for its own.
    chain.mine(hash(1000));
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [first], failed: [] });
    expect((await w.sim.withdrawal(w.account, second)).value?.status).toBe('pending');
    chain.mine(hash(1001));
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [second], failed: [] });
    expect(chain.sent).toHaveLength(2);
  });

  it('a send the node never took settles failed after LOST_PAYMENT_AFTER_MS, returns the funds, and is never sent again', async () => {
    const w = world();
    creditDepositLogs(w.sim, ROUTE, [w.deposit(25_000_000n, 1)]);
    const nonce = await w.withdraw('10', 8);
    const chain = fakePayer();
    const paid = new Map<string, WithdrawalPayment>();
    w.advance(5000);
    chain.rejectNext();
    await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000);
    // Not found yet, and not long enough to give up: still pending, nothing sent again.
    w.advance(LOST_PAYMENT_AFTER_MS - 1);
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [], failed: [] });
    expect((await w.sim.withdrawal(w.account, nonce)).value?.status).toBe('pending');
    w.advance(1);
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [], failed: [nonce] });
    expect(await w.free()).toBe(a('25'));
    expect(chain.sends()).toBe(1);
    expect(chain.sent).toEqual([]);
  });

  it("one withdrawal's chain error does not stop the others in the same pass", async () => {
    const w = world();
    creditDepositLogs(w.sim, ROUTE, [w.deposit(25_000_000n, 1)]);
    const first = await w.withdraw('5', 9);
    const second = await w.withdraw('6', 10);
    const chain = fakePayer();
    const paid = new Map<string, WithdrawalPayment>();
    w.advance(5000);
    chain.rejectNext();
    const errors: string[] = [];
    await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000, (n) => errors.push(n));
    expect(errors).toEqual([first]);
    // The second was still paid in the same pass.
    expect(chain.sent).toEqual([{ to: owner, units: 5_750_000n, hash: hash(1000) }]);
    chain.mine(hash(1000));
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [second], failed: [] });
  });

  it('a log without its transfer id is not credited, and the next read starts again from its block', () => {
    const logs = [
      { transactionHash: hash(1), logIndex: 0, blockNumber: 5n },
      { transactionHash: null, logIndex: null, blockNumber: 8n },
      { transactionHash: hash(2), logIndex: null, blockNumber: 7n },
      { transactionHash: hash(3), logIndex: 1, blockNumber: 9n },
    ];
    expect(completeLogs(logs, 3n, 10n)).toEqual({ complete: [logs[0], logs[3]], nextFromBlock: 7n });
    // One with no block either: read again from where this read started.
    expect(completeLogs([{ transactionHash: null, logIndex: 0, blockNumber: null }], 3n, 10n).nextFromBlock).toBe(3n);
    // All complete: the next read starts after the head.
    expect(completeLogs([logs[0]!], 3n, 10n)).toEqual({ complete: [logs[0]], nextFromBlock: 11n });
  });

  it('a withdrawal settled elsewhere meanwhile is not reported again', async () => {
    const w = world();
    creditDepositLogs(w.sim, ROUTE, [w.deposit(25_000_000n, 1)]);
    await w.withdraw('10', 5);
    const chain = fakePayer();
    const paid = new Map<string, WithdrawalPayment>();
    w.advance(5000);
    // A TEST control settles it while the payment's receipt is awaited.
    const settledMeanwhile: WithdrawalPayer = {
      ...chain.payer,
      receipt: async () => {
        w.sim.settleWithdrawals('failed');
        return true;
      },
    };
    expect(await payPendingWithdrawals(w.sim, ROUTE, settledMeanwhile, paid, w.now(), 4000)).toEqual({ done: [], failed: [] });
  });

  it('a network fee the venue does not publish is "not known", never 0, and is still taken from what arrives', async () => {
    const w = world();
    creditDepositLogs(w.sim, ROUTE, [w.deposit(25_000_000n, 1)]);
    w.sim.switches.networkFee = { known: false };
    const nonce = await w.withdraw('10', 2);
    expect((await w.sim.withdrawal(w.account, nonce)).value?.networkFee).toEqual({ known: false });
    const chain = fakePayer();
    w.advance(5000);
    await payPendingWithdrawals(w.sim, ROUTE, chain.payer, new Map(), w.now(), 4000);
    expect(chain.sent[0]?.units).toBe(9_500_000n);
  });

  it('a payment that reverts settles failed, and the venue returns the amount and its fee', async () => {
    const w = world();
    creditDepositLogs(w.sim, ROUTE, [w.deposit(25_000_000n, 1)]);
    const nonce = await w.withdraw('10', 3);
    const chain = fakePayer();
    const paid = new Map<string, WithdrawalPayment>();
    w.advance(5000);
    await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000);
    chain.mine(hash(1000), false);
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [], failed: [nonce] });
    expect((await w.sim.withdrawal(w.account, nonce)).value?.status).toBe('failed');
    expect(await w.free()).toBe(a('25'));
  });

  it('a withdrawal the deposit address cannot cover on chain is never sent and stays pending; the TEST settle control still ends it done', async () => {
    const w = world();
    // Credited by the TEST venue's deposit control, not on chain: the deposit address holds less than the payment.
    creditDepositLogs(w.sim, ROUTE, [w.deposit(25_000_000n, 1)]);
    const nonce = await w.withdraw('10', 6);
    const chain = fakePayer();
    chain.setHolds(9_749_999n);
    const paid = new Map<string, WithdrawalPayment>();
    w.advance(5000);
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [], failed: [] });
    // Long past LOST_PAYMENT_AFTER_MS it is still not sent, and not given up as failed.
    w.advance(LOST_PAYMENT_AFTER_MS * 2);
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [], failed: [] });
    expect(chain.sends()).toBe(0);
    expect(paid.size).toBe(0);
    expect((await w.sim.withdrawal(w.account, nonce)).value?.status).toBe('pending');
    expect(w.sim.settleWithdrawals()).toBe(1);
    expect((await w.sim.withdrawal(w.account, nonce)).value?.status).toBe('done');
    // Settled by the TEST control, not by a payment: the record names no chain transaction.
    expect((await w.sim.withdrawal(w.account, nonce)).value).not.toHaveProperty('txHash');
    // Covered exactly (the amount less the 0.25 network fee), the next one is paid.
    const next = await w.withdraw('1', 7);
    chain.setHolds(750_000n);
    w.advance(5000);
    await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000);
    expect(chain.sent.map((p) => p.units)).toEqual([750_000n]);
    chain.mine(hash(1000));
    expect(await payPendingWithdrawals(w.sim, ROUTE, chain.payer, paid, w.now(), 4000)).toEqual({ done: [next], failed: [] });
  });

  it('a withdrawal above the free balance is refused, and nothing is pending', async () => {
    const w = world();
    creditDepositLogs(w.sim, ROUTE, [w.deposit(5_000_000n, 1)]);
    const intent: WithdrawIntent = {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10'),
      destination: owner,
      withdrawalKey: `withdraw:${owner}:9`,
    };
    const prepared = await w.sim.prepare(w.account, { role: 'owner', address: owner }, intent);
    const typed = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    const outcome = await w.sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
    expect(outcome).toMatchObject({ definite: true, accepted: false, refusal: { code: 'insufficient_balance' } });
    expect(w.sim.pendingWithdrawals()).toEqual([]);
    expect(await w.free()).toBe(a('5'));
  });
});

describe('the TEST venue over HTTP names its deposit route and takes the network-fee switch', () => {
  it('GET /venue names the route; /test/switches sets the network fee, and refuses a fee that is not a MaybeKnown', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(), markets: TEST_VENUE_MARKETS, chainId: ROUTE.chainId });
    const [, venue] = await answerTestVenue(sim, 'GET', '/venue', '', ROUTE);
    expect(venue).toMatchObject({ label: 'TEST', chainId: 84532, deposit: ROUTE });
    const [, none] = await answerTestVenue(sim, 'GET', '/venue', '');
    expect(none).toMatchObject({ deposit: null });
    const [status, body] = await answerTestVenue(sim, 'POST', '/test/switches', JSON.stringify({ networkFee: { known: false } }));
    expect([status, body]).toMatchObject([200, { networkFee: { known: false } }]);
    expect(sim.switches.networkFee).toEqual({ known: false });
    await answerTestVenue(sim, 'POST', '/test/switches', JSON.stringify({ networkFee: { known: true, value: '0.4' } }));
    expect(sim.switches.networkFee).toEqual({ known: true, value: a('0.4') });
    const [bad] = await answerTestVenue(sim, 'POST', '/test/switches', JSON.stringify({ networkFee: 0.4 }));
    expect(bad).toBe(400);
  });
});
