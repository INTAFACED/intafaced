import { add, compare, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
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
type It = (name: string, fn: () => Promise<void>) => void;
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

    it('a lost answer is read back by client id, and the order exists once', async () => {
      const h = await harness.setup();
      if (!h.loseNextAnswer) return;
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
      expect(compare(fill.venueFee, ZERO) >= 0).toBe(true);
      expect(fill.builderFee).toBe(ZERO);
      const after = await h.venue.balances(h.trader.account);
      expect(freeOf(after.value, h.spot.quote).locked).toBe(ZERO);
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
