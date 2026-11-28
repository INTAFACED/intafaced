/**
 * Identity's trading restriction at the user-venue door (J-support-public-20 #7: "the app refuses the customer's new
 * orders"). The door relays the person's own signed venue order and asks no operation decision of identity, so it reads
 * the restriction itself, per order, through identity's record `IDENTITY_TRADING_RESTRICTION`, and keeps no copy. A
 * restriction that can't be read refuses the order too (fail closed). Cancels, withdrawals, grants and an amend (which
 * never raises an order, `assertNoRaise`) stay open, and so does an order that only reduces a position: they take risk
 * off, and a restricted person's own funds are never stranded on the venue by it.
 */
import { IDENTITY_TRADING_RESTRICTION } from '@intafaced/contracts/identity-trading-restriction-procedures';
import { callHttpRecord } from '@intafaced/contracts/procedure-http';
import { serviceCallSigner } from '@intafaced/contracts/service-auth-http';
import type { ServiceAuthMode, ServiceSigner } from '@intafaced/contracts';
import type { VenueIntent } from '@intafaced/venue-contracts';

export interface TradingRestrictionRead {
  /** True while identity refuses a new order for this person. Throws `TradingRestrictionUnavailable` when it can't say. */
  restricted(userId: string): Promise<boolean>;
}

export class TradingRestrictionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradingRestrictionUnavailable';
  }
}

const READ_MS = 3_000;

export function createIdentityTradingRestrictionRead(options: {
  readonly baseUrl: string;
  readonly internalSecret: string;
  readonly s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  readonly fetchFn?: typeof globalThis.fetch;
}): TradingRestrictionRead {
  const sign = serviceCallSigner({
    service: 'svc-trade',
    audience: IDENTITY_TRADING_RESTRICTION.service,
    legacySecret: options.internalSecret,
    s2s: options.s2s,
  });
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const fetcher: typeof fetch = (input, init) => fetchFn(input, { ...init, signal: AbortSignal.timeout(READ_MS) });
  return {
    async restricted(userId) {
      let reply;
      try {
        reply = await callHttpRecord(IDENTITY_TRADING_RESTRICTION, {
          baseUrl: options.baseUrl,
          input: undefined,
          params: { userId },
          sign,
          errorOf: (_path, status) => new TradingRestrictionUnavailable(`identity refused the trading restriction read (${status})`),
          fetcher,
        });
      } catch (err) {
        if (err instanceof TradingRestrictionUnavailable) throw err;
        throw new TradingRestrictionUnavailable('identity did not answer the trading restriction read');
      }
      if (reply.userId.toLowerCase() !== userId.toLowerCase())
        throw new TradingRestrictionUnavailable('identity answered the trading restriction read for another person');
      return reply.restricted;
    },
  };
}

/** For tests: a fixed set of restricted people. */
export class MemoryTradingRestrictionRead implements TradingRestrictionRead {
  readonly restrictedUsers = new Set<string>();
  down = false;
  async restricted(userId: string) {
    if (this.down) throw new TradingRestrictionUnavailable('TEST: identity down');
    return this.restrictedUsers.has(userId);
  }
}

/**
 * Whether an intent is a new order that adds exposure: a place, a batch or a replace, unless every order in it only
 * reduces a position. Everything else (a cancel, an amend that never raises, a withdrawal, a grant) takes risk off.
 */
export function addsExposure(intent: VenueIntent): boolean {
  if (intent.kind === 'place_order') return !intent.reduceOnly;
  if (intent.kind === 'replace_order') return !intent.order.reduceOnly;
  if (intent.kind === 'place_orders') return intent.orders.some((order) => !order.reduceOnly);
  return false;
}
