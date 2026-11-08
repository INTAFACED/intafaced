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
  /** A fresh venue, with `fund` able to credit both accounts. */
  setup(): Promise<{
    readonly venue: UserVenue;
    readonly trader: { readonly account: UserVenueAccount; readonly wallet: ConformanceWallet; readonly agent: ConformanceWallet };
    /** Another TEST trader who rests liquidity. */
    readonly other: { readonly account: UserVenueAccount; readonly wallet: ConformanceWallet };
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

function freeOf(balances: readonly { asset: string; free: Amount; locked: Amount }[], asset: string) {
  const b = balances.find((x) => x.asset === asset);
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

    it('the same intent pressed twice places one order, even with a fresh signature', async () => {
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
      expect(again).toEqual(outcome);
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
