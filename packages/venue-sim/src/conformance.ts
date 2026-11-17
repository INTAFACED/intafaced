import { add, div, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type VenueSignature,
  type VenueSigner,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';

/**
 * THE USER-VENUE CONFORMANCE SUITE — what every `UserVenue` must do, whoever implements it.
 *
 * The TEST simulator runs it in CI on every PR; the Hyperliquid testnet
 * adapter runs the same suite off the PR path. A venue that passes it can
 * carry J-cex-spot-01's and J-derivatives-01's money behaviour: one order per
 * intent, one signature per press, locks the venue reports, an unknown answer
 * read back and never re-sent, and owner-only actions refused to an agent.
 *
 * Test-framework agnostic: the caller passes `describe`, `it` and `expect`, so
 * this file ships with the package and needs no test runner at runtime.
 */

export interface ConformanceWallet {
  readonly signer: VenueSigner;
  sign(prepared: PreparedVenueAction): Promise<VenueSignature>;
}

export interface ConformanceHarness {
  /** True when `setup().loseNextAnswer` exists; otherwise the lost-answer check is reported skipped. */
  readonly canLoseAnswers: boolean;
  /**
   * True when the venue itself answers a second order with a client id it has seen with the first order. The contract
   * does not require it (one prepared action per business key is the caller's guarantee); a venue that does is checked.
   */
  readonly dedupesClientIds: boolean;
  /** A perpetual market the harness can trade with leverage set; `null` skips the perp checks (reported skipped). */
  readonly perp: {
    readonly symbol: string;
    readonly quote: string;
    readonly price: Amount;
    /** A price above `price` the closes trade at; 40 percent of `size` must be a whole lot. */
    readonly closePrice: Amount;
    readonly size: Amount;
    readonly leverageBps: number;
  } | null;
  /** True when `setup().settleWithdrawals` exists; otherwise the withdrawal check is reported skipped. */
  readonly canSettleWithdrawals: boolean;
  /** A fresh venue, with `fund` able to credit both accounts. */
  setup(): Promise<{
    readonly venue: UserVenue;
    readonly trader: { readonly account: UserVenueAccount; readonly wallet: ConformanceWallet; readonly agent: ConformanceWallet };
    /** Another TEST trader who rests liquidity. */
    readonly other: { readonly account: UserVenueAccount; readonly wallet: ConformanceWallet };
    /** A third TEST trader, flat, for the other side of a close. */
    readonly third: { readonly account: UserVenueAccount; readonly wallet: ConformanceWallet };
    readonly spot: {
      readonly symbol: string;
      readonly base: string;
      readonly quote: string;
      readonly price: Amount;
      readonly size: Amount;
    };
    fund(account: UserVenueAccount, asset: string, amount: Amount, ref: string): Promise<void>;
    /** Make the next submit's answer get lost after the venue applied it; `null` when this venue can't. */
    loseNextAnswer: (() => void) | null;
    /** Mark pending withdrawals done (the chain confirmed them); `null` when this venue can't on demand. */
    settleWithdrawals: (() => void) | null;
    /** Make the venue refuse everything as down, and back; `null` when this venue can't on demand. */
    setVenueDown: ((down: boolean) => void) | null;
  }>;
}

type Describe = (name: string, fn: () => void) => void;
type It = ((name: string, fn: () => Promise<void>) => void) & { skip: (name: string, fn: () => Promise<void>) => void };
interface Expect {
  (actual: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    not: { toBeNull(): void; toBe(expected: unknown): void };
    rejects: { toBeInstanceOf(type: unknown): Promise<void> };
  };
}

function limit(symbol: string, side: 'buy' | 'sell', price: Amount, amount: Amount, key: string): PlaceUserOrderIntent {
  return {
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount,
    price,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
  };
}

async function signAndSubmit(
  venue: UserVenue,
  wallet: ConformanceWallet,
  account: UserVenueAccount,
  intent: PlaceUserOrderIntent | Parameters<UserVenue['prepare']>[2],
): Promise<{ prepared: PreparedVenueAction; outcome: VenueSubmitOutcome; signature: VenueSignature }> {
  const prepared = await venue.prepare(account, wallet.signer, intent);
  const signature = await wallet.sign(prepared);
  const outcome = await venue.submit(prepared, signature);
  return { prepared, outcome, signature };
}

/** Free and locked for one asset, after checking the venue's own total equals their sum (a venue mid-incident fails here). */
function freeOf(balances: readonly { asset: string; free: Amount; locked: Amount; total: Amount }[], asset: string) {
  const b = balances.find((x) => x.asset === asset);
  if (b && b.total !== add(b.free, b.locked)) {
    throw new Error(`${asset}: the venue reports total ${b.total} but free + locked is ${add(b.free, b.locked)}`);
  }
  return { free: b?.free ?? ZERO, locked: b?.locked ?? ZERO };
}

export function defineUserVenueConformance(harness: ConformanceHarness, t: { describe: Describe; it: It; expect: Expect }): void {
  const { describe, it, expect } = t;

  describe('UserVenue conformance', () => {
    it('a resting limit buy locks exactly its notional, and the venue reports it with an as-of time', async () => {
      const h = await harness.setup();
      await h.fund(h.trader.account, h.spot.quote, parseAmount('1000'), 'deposit:test:1');
      const before = await h.venue.balances(h.trader.account);
      expect(freeOf(before.value, h.spot.quote).free).toBe(parseAmount('1000'));
      const away = sub(h.spot.price, parseAmount('100'));
      const { outcome, prepared } = await signAndSubmit(
        h.venue,
        h.trader.wallet,
        h.trader.account,
        limit(h.spot.symbol, 'buy', away, h.spot.size, 'order:trader:conf:1'),
      );
      expect(outcome.definite && outcome.accepted).toBe(true);
      const open = await h.venue.openOrders(h.trader.account);
      expect(open.value.map((o) => o.venueClientOrderId)).toEqual([prepared.venueClientOrderId]);
      const after = await h.venue.balances(h.trader.account);
      const locked = freeOf(after.value, h.spot.quote).locked;
      expect(locked).toBe(open.value[0]!.locked);
      expect(add(freeOf(after.value, h.spot.quote).free, locked)).toBe(parseAmount('1000'));
      expect(after.asOf instanceof Date).toBe(true);
    });

    (harness.dedupesClientIds ? it : it.skip)('the same intent pressed twice places one order, even with a fresh signature', async () => {
      const h = await harness.setup();
      // Funded for many orders, so only the venue's client-id check can stop a second one.
      await h.fund(h.trader.account, h.spot.quote, parseAmount('100000'), 'deposit:test:2');
      const intent = limit(h.spot.symbol, 'buy', sub(h.spot.price, parseAmount('100')), h.spot.size, 'order:trader:conf:2');
      const first = await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, intent);
      const second = await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, intent);
      expect(second.prepared.venueClientOrderId).toBe(first.prepared.venueClientOrderId);
      const open = await h.venue.openOrders(h.trader.account);
      expect(open.value.length).toBe(1);
      // One order means one lock: the venue's locked balance is that order's lock, not two.
      const balances = await h.venue.balances(h.trader.account);
      expect(freeOf(balances.value, h.spot.quote).locked).toBe(open.value[0]!.locked);
      expect(add(freeOf(balances.value, h.spot.quote).free, freeOf(balances.value, h.spot.quote).locked)).toBe(parseAmount('100000'));
    });

    it('re-submitting the same signed bytes returns the same answer and does nothing twice', async () => {
      const h = await harness.setup();
      await h.fund(h.trader.account, h.spot.quote, parseAmount('1000'), 'deposit:test:3');
      const { prepared, signature, outcome } = await signAndSubmit(
        h.venue,
        h.trader.wallet,
        h.trader.account,
        limit(h.spot.symbol, 'buy', sub(h.spot.price, parseAmount('100')), h.spot.size, 'order:trader:conf:3'),
      );
      const again = await h.venue.submit(prepared, signature);
      // The first answer again, or "already submitted" (a venue that only knows the nonce is used): never a second action.
      if (again.definite) expect(again).toEqual(outcome);
      else expect(again).toEqual({ definite: false, reason: 'already_submitted' });
      expect((await h.venue.openOrders(h.trader.account)).value.length).toBe(1);
    });

    // A venue that cannot lose an answer on demand shows this as skipped, never as passed.
    (harness.canLoseAnswers ? it : it.skip)('a lost answer is read back by client id, and the order exists once', async () => {
      const h = await harness.setup();
      if (!h.loseNextAnswer) throw new Error('harness.canLoseAnswers is set but setup() gave no loseNextAnswer');
      await h.fund(h.trader.account, h.spot.quote, parseAmount('1000'), 'deposit:test:4');
      h.loseNextAnswer();
      const { prepared, outcome } = await signAndSubmit(
        h.venue,
        h.trader.wallet,
        h.trader.account,
        limit(h.spot.symbol, 'buy', sub(h.spot.price, parseAmount('100')), h.spot.size, 'order:trader:conf:4'),
      );
      expect(outcome.definite).toBe(false);
      const read = await h.venue.orderByClientId(h.trader.account, prepared.venueClientOrderId as string);
      expect(read.value).not.toBeNull();
      expect(read.value!.status).toBe('open');
      expect((await h.venue.openOrders(h.trader.account)).value.length).toBe(1);
    });

    it('a crossing order fills at the resting price with the venue fee and builder fee as separate lines', async () => {
      const h = await harness.setup();
      await h.fund(h.other.account, h.spot.base, parseAmount('10'), 'deposit:other:5');
      await h.fund(h.trader.account, h.spot.quote, parseAmount('100000'), 'deposit:test:5');
      await signAndSubmit(
        h.venue,
        h.other.wallet,
        h.other.account,
        limit(h.spot.symbol, 'sell', h.spot.price, h.spot.size, 'order:other:conf:5'),
      );
      const since = new Date(0);
      const { outcome } = await signAndSubmit(
        h.venue,
        h.trader.wallet,
        h.trader.account,
        limit(h.spot.symbol, 'buy', h.spot.price, h.spot.size, 'order:trader:conf:5'),
      );
      expect(outcome.definite && outcome.accepted && outcome.order?.status).toBe('filled');
      const fills = await h.venue.fills(h.trader.account, since);
      expect(fills.value.length).toBe(1);
      const fill = fills.value[0]!;
      expect(fill.price).toBe(h.spot.price);
      expect(fill.role).toBe('taker');
      expect(fill.builderFee).toBe(ZERO);
      // A buyer pays in the base it receives; what it received is the size less the fee lines, exactly.
      expect(fill.feeAsset).toBe(h.spot.base);
      const market = (await h.venue.markets(h.trader.account)).value.find((m) => m.symbol === h.spot.symbol)!;
      if (market.takerFeeBps.known) {
        expect(fill.venueFee).toBe(div(mul(h.spot.size, market.takerFeeBps.value, 'ceil'), parseAmount('10000'), 'ceil'));
      }
      const after = await h.venue.balances(h.trader.account);
      expect(freeOf(after.value, h.spot.quote)).toEqual({
        free: sub(parseAmount('100000'), mul(h.spot.price, h.spot.size, 'ceil')),
        locked: ZERO,
      });
      expect(freeOf(after.value, h.spot.base).free).toBe(sub(h.spot.size, add(fill.venueFee, fill.builderFee)));
      // The maker's side: its base left, its quote came in less its own fee lines, nothing stays locked.
      const makerFill = (await h.venue.fills(h.other.account, since)).value[0]!;
      expect([makerFill.role, makerFill.amount, makerFill.feeAsset]).toEqual(['maker', h.spot.size, h.spot.quote]);
      const makerAfter = await h.venue.balances(h.other.account);
      expect(freeOf(makerAfter.value, h.spot.base)).toEqual({ free: sub(parseAmount('10'), h.spot.size), locked: ZERO });
      expect(freeOf(makerAfter.value, h.spot.quote).free).toBe(
        sub(mul(h.spot.price, h.spot.size, 'ceil'), add(makerFill.venueFee, makerFill.builderFee)),
      );
    });

    it('cancel releases the lock once, and a repeat cancel reports the same outcome', async () => {
      const h = await harness.setup();
      await h.fund(h.trader.account, h.spot.quote, parseAmount('1000'), 'deposit:test:6');
      const intent = limit(h.spot.symbol, 'buy', sub(h.spot.price, parseAmount('100')), h.spot.size, 'order:trader:conf:6');
      await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, intent);
      const cancel = { kind: 'cancel_order', symbol: h.spot.symbol, clientOrderKey: intent.clientOrderKey } as const;
      const first = await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, cancel);
      const second = await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, cancel);
      expect(first.outcome.definite && first.outcome.accepted && first.outcome.order?.status).toBe('canceled');
      expect(second.outcome.definite && second.outcome.accepted && second.outcome.order?.status).toBe('canceled');
      const after = await h.venue.balances(h.trader.account);
      expect(freeOf(after.value, h.spot.quote)).toEqual({ free: parseAmount('1000'), locked: ZERO });
    });

    it("authority is the venue's at submit: an agent withdrawal or a stranger's owner claim, built by hand, moves nothing", async () => {
      const h = await harness.setup();
      await h.fund(h.trader.account, h.spot.quote, parseAmount('1000'), 'deposit:test:auth');
      await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, {
        kind: 'approve_agent',
        agentAddress: h.trader.agent.signer.address,
        agentName: 'TEST bot',
        validUntil: null,
      });
      const withdraw = {
        kind: 'withdraw',
        asset: h.spot.quote,
        amount: parseAmount('900'),
        destination: h.trader.account.owner,
        withdrawalKey: 'withdraw:trader:auth',
      } as const;
      // Prepared as the owner, then re-labelled to the agent and signed by the agent key.
      const asOwner = await h.venue.prepare(h.trader.account, h.trader.wallet.signer, withdraw);
      const relabelled = { ...asOwner, signer: h.trader.agent.signer };
      const agentTry = h.venue.submit(relabelled, await h.trader.agent.sign(relabelled)).then(
        (o) => o,
        () => null,
      );
      const agentOutcome = await agentTry;
      expect(agentOutcome === null || (agentOutcome.definite && !agentOutcome.accepted)).toBe(true);
      // Prepared on the stranger's own account, then pointed at the trader's.
      const strangerOwn = await h.venue.prepare(h.other.account, h.other.wallet.signer, withdraw);
      const pointed = { ...strangerOwn, account: h.trader.account };
      const strangerOutcome = await h.venue.submit(pointed, await h.other.wallet.sign(pointed)).then(
        (o) => o,
        () => null,
      );
      expect(strangerOutcome === null || (strangerOutcome.definite && !strangerOutcome.accepted)).toBe(true);
      expect(freeOf((await h.venue.balances(h.trader.account)).value, h.spot.quote).free).toBe(parseAmount('1000'));
    });

    (harness.canSettleWithdrawals ? it : it.skip)('an owner withdrawal is pending, then done, with its fee or "not known"', async () => {
      const h = await harness.setup();
      await h.fund(h.trader.account, h.spot.quote, parseAmount('1000'), 'deposit:test:wd');
      const { prepared, outcome } = await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, {
        kind: 'withdraw',
        asset: h.spot.quote,
        amount: parseAmount('10'),
        destination: h.trader.account.owner,
        withdrawalKey: 'withdraw:trader:wd',
      });
      expect(outcome.definite && outcome.accepted).toBe(true);
      const pending = (await h.venue.withdrawal(h.trader.account, prepared.nonce)).value!;
      expect(pending.status).toBe('pending');
      expect(pending.amount).toBe(parseAmount('10'));
      h.settleWithdrawals!();
      const done = (await h.venue.withdrawal(h.trader.account, prepared.nonce)).value!;
      expect(done.status).toBe('done');
      const fee = done.fee.known ? done.fee.value : null;
      if (fee !== null)
        expect(freeOf((await h.venue.balances(h.trader.account)).value, h.spot.quote).free).toBe(sub(parseAmount('990'), fee));
    });

    (harness.perp ? it : it.skip)(
      'perp: no leverage set refuses; one long opens; closing 40 percent then the rest sums to the full close',
      async () => {
        const h = await harness.setup();
        const p = harness.perp!;
        const lev = (who: ConformanceWallet, acct: UserVenueAccount) =>
          signAndSubmit(h.venue, who, acct, {
            kind: 'update_leverage',
            symbol: p.symbol,
            leverageBps: p.leverageBps,
            marginMode: 'isolated',
          });
        const perpOrder = (side: 'buy' | 'sell', amount: Amount, key: string, extra: Partial<PlaceUserOrderIntent> = {}) => ({
          ...limit(p.symbol, side, p.price, amount, key),
          ...extra,
        });
        await h.fund(h.trader.account, p.quote, parseAmount('100000'), 'deposit:test:perp');
        await h.fund(h.other.account, p.quote, parseAmount('100000'), 'deposit:other:perp');
        await expect(
          h.venue.prepare(h.trader.account, h.trader.wallet.signer, perpOrder('buy', p.size, 'order:trader:perp:0')),
        ).rejects.toBeInstanceOf(VenueRefusalError);
        await lev(h.trader.wallet, h.trader.account);
        await lev(h.other.wallet, h.other.account);
        await signAndSubmit(h.venue, h.other.wallet, h.other.account, perpOrder('sell', p.size, 'order:other:perp:1'));
        await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, perpOrder('buy', p.size, 'order:trader:perp:1'));
        const open = (await h.venue.positions(h.trader.account)).value;
        expect(open.map((x) => [x.symbol, x.side, x.size])).toEqual([[p.symbol, 'long', p.size]]);
        const leverage = (await h.venue.leverage(h.trader.account, p.symbol)).value;
        expect(leverage?.leverageBps).toBe(p.leverageBps);
        expect(freeOf((await h.venue.balances(h.trader.account)).value, p.quote).locked).toBe(open[0]!.margin);
        // The other side of the closes: a third, flat trader rests a bid at the close price.
        await h.fund(h.third.account, p.quote, parseAmount('100000'), 'deposit:third:perp');
        await lev(h.third.wallet, h.third.account);
        await signAndSubmit(h.venue, h.third.wallet, h.third.account, limit(p.symbol, 'buy', p.closePrice, p.size, 'order:third:perp:bid'));
        const forty = div(mul(p.size, parseAmount('40'), 'floor'), parseAmount('100'), 'floor');
        const close = (amount: Amount, key: string) => ({
          ...limit(p.symbol, 'sell', p.closePrice, amount, key),
          reduceOnly: true,
          timeInForce: 'IOC' as const,
        });
        await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, close(forty, 'order:trader:perp:close40'));
        expect((await h.venue.positions(h.trader.account)).value.map((x) => x.size)).toEqual([sub(p.size, forty)]);
        await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, close(sub(p.size, forty), 'order:trader:perp:close60'));
        expect((await h.venue.positions(h.trader.account)).value).toEqual([]);
        const results = (await h.venue.fills(h.trader.account, new Date(0))).value
          .filter((f) => f.realisedPnl !== null)
          .map((f) => f.realisedPnl!);
        // The split results sum to the result of the full close, as the venue reports them.
        expect(results.length).toBe(2);
        expect(add(results[0]!, results[1]!)).toBe(mul(sub(p.closePrice, p.price), p.size));
        expect(freeOf((await h.venue.balances(h.trader.account)).value, p.quote).locked).toBe(ZERO);
      },
    );

    it('an agent key can trade but is refused a withdrawal before anything is signed', async () => {
      const h = await harness.setup();
      await h.fund(h.trader.account, h.spot.quote, parseAmount('1000'), 'deposit:test:7');
      await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, {
        kind: 'approve_agent',
        agentAddress: h.trader.agent.signer.address,
        agentName: 'TEST bot',
        validUntil: null,
      });
      const placed = await signAndSubmit(
        h.venue,
        h.trader.agent,
        h.trader.account,
        limit(h.spot.symbol, 'buy', sub(h.spot.price, parseAmount('100')), h.spot.size, 'order:trader:agent:7'),
      );
      expect(placed.outcome.definite && placed.outcome.accepted).toBe(true);
      await expect(
        h.venue.prepare(h.trader.account, h.trader.agent.signer, {
          kind: 'withdraw',
          asset: h.spot.quote,
          amount: parseAmount('10'),
          destination: h.trader.account.owner,
          withdrawalKey: 'withdraw:trader:7',
        }),
      ).rejects.toBeInstanceOf(VenueRefusalError);
    });

    it('a part-filled limit rests on the book and the next crossing order fills it', async () => {
      const h = await harness.setup();
      await h.fund(h.other.account, h.spot.base, parseAmount('10'), 'deposit:other:9');
      await h.fund(h.trader.account, h.spot.quote, parseAmount('100000'), 'deposit:test:9');
      await signAndSubmit(
        h.venue,
        h.other.wallet,
        h.other.account,
        limit(h.spot.symbol, 'sell', h.spot.price, h.spot.size, 'order:other:conf:9a'),
      );
      const double = add(h.spot.size, h.spot.size);
      const { prepared } = await signAndSubmit(
        h.venue,
        h.trader.wallet,
        h.trader.account,
        limit(h.spot.symbol, 'buy', h.spot.price, double, 'order:trader:conf:9'),
      );
      expect((await h.venue.orderByClientId(h.trader.account, prepared.venueClientOrderId!)).value?.status).toBe('partially_filled');
      await signAndSubmit(
        h.venue,
        h.other.wallet,
        h.other.account,
        limit(h.spot.symbol, 'sell', h.spot.price, h.spot.size, 'order:other:conf:9b'),
      );
      expect((await h.venue.orderByClientId(h.trader.account, prepared.venueClientOrderId!)).value?.status).toBe('filled');
      expect((await h.venue.openOrders(h.other.account)).value).toEqual([]);
      expect(freeOf((await h.venue.balances(h.trader.account)).value, h.spot.quote).locked).toBe(ZERO);
    });

    it('a market buy fills within its worst price and leaves nothing locked or open', async () => {
      const h = await harness.setup();
      await h.fund(h.other.account, h.spot.base, parseAmount('10'), 'deposit:other:10');
      await h.fund(h.trader.account, h.spot.quote, parseAmount('100000'), 'deposit:test:10');
      await signAndSubmit(
        h.venue,
        h.other.wallet,
        h.other.account,
        limit(h.spot.symbol, 'sell', h.spot.price, h.spot.size, 'order:other:conf:10'),
      );
      const worst = add(h.spot.price, parseAmount('100'));
      const { outcome } = await signAndSubmit(h.venue, h.trader.wallet, h.trader.account, {
        ...limit(h.spot.symbol, 'buy', worst, add(h.spot.size, h.spot.size), 'order:trader:conf:10'),
        type: 'market',
        timeInForce: 'IOC',
      });
      expect(outcome.definite && outcome.accepted && outcome.order?.filled).toBe(h.spot.size);
      expect((await h.venue.openOrders(h.trader.account)).value).toEqual([]);
      const after = await h.venue.balances(h.trader.account);
      expect(freeOf(after.value, h.spot.quote)).toEqual({
        free: sub(parseAmount('100000'), mul(h.spot.price, h.spot.size, 'ceil')),
        locked: ZERO,
      });
    });

    it('a payload changed after signing is refused, whichever field carries the change', async () => {
      const h = await harness.setup();
      await h.fund(h.trader.account, h.spot.quote, parseAmount('100000'), 'deposit:test:11');
      const away = sub(h.spot.price, parseAmount('100'));
      const small = await h.venue.prepare(
        h.trader.account,
        h.trader.wallet.signer,
        limit(h.spot.symbol, 'buy', away, h.spot.size, 'order:trader:conf:11'),
      );
      const big = await h.venue.prepare(
        h.trader.account,
        h.trader.wallet.signer,
        limit(h.spot.symbol, 'buy', away, add(h.spot.size, h.spot.size), 'order:trader:conf:11'),
      );
      const signed = await h.trader.wallet.sign(small);
      // The intent says big, the typed data and digest say small.
      await expect(
        h.venue.submit({ ...big, typedData: small.typedData, digest: small.digest, nonce: small.nonce }, signed),
      ).rejects.toBeInstanceOf(VenueRefusalError);
      // The wallet was shown the small payload; the intent, digest and the wallet's claim all say big.
      await expect(h.venue.submit({ ...big, typedData: small.typedData }, { ...signed, digest: big.digest })).rejects.toBeInstanceOf(
        VenueRefusalError,
      );
      // The wallet signed the big payload; it is presented as the small one's signature.
      const signedBig = await h.trader.wallet.sign(big);
      await expect(h.venue.submit(small, { ...signedBig, digest: small.digest })).rejects.toBeInstanceOf(VenueRefusalError);
      expect((await h.venue.openOrders(h.trader.account)).value).toEqual([]);
    });

    it('a signature from another key is refused with nothing sent', async () => {
      const h = await harness.setup();
      await h.fund(h.trader.account, h.spot.quote, parseAmount('1000'), 'deposit:test:8');
      const prepared = await h.venue.prepare(
        h.trader.account,
        h.trader.wallet.signer,
        limit(h.spot.symbol, 'buy', sub(h.spot.price, parseAmount('100')), h.spot.size, 'order:trader:conf:8'),
      );
      const forged = await h.other.wallet.sign(prepared);
      await expect(h.venue.submit(prepared, { ...forged, signedBy: h.trader.wallet.signer.address })).rejects.toBeInstanceOf(
        VenueRefusalError,
      );
      expect((await h.venue.openOrders(h.trader.account)).value.length).toBe(0);
    });
  });
}
