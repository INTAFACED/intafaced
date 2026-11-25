/**
 * The user-venue door's REST routes (B1; src/venue/user-venue-door.ts), for the signed-in customer:
 *
 *   GET  /api/v1/venue/status                          `{ enabled: false }` when the door is off; else the venue, TEST label, chain id
 *   GET  /api/v1/venue/markets                         the markets we list, each with `listing` (ours) beside the venue's own status
 *   GET  /api/v1/venue/gated-list                      each perpetual open or blocked for this account, every reason (J-derivatives-01 #2)
 *   GET  /api/v1/venue/eligible-instruments            the perpetuals this account is eligible for, each with its settle
 *                                                      asset, or none with the reason (J-derivatives-12 #5)
 *   GET  /api/v1/venue/builder-fees?owner=&since=<ISO>  our builder fee on each fill of the caller's own orders on the
 *                                                      account, with the ledger transaction it posted (J-derivatives-12 #4)
 *   GET  /api/v1/venue/best-prices?symbol=BTC-USDC         the venue's best bid and ask (a market order's worst price)
 *   GET  /api/v1/venue/margin-rules?base=BTC              public: the venue's maximum leverage and one maintenance rate
 *                                                        on our listed perpetual on that asset (null: not published)
 *   GET  /api/v1/venue/funding-history?base=BTC&since=<ISO>  public: the funding the venue published on our listed
 *                                                      perpetual on that asset (a chart's funding study, J-charts-desk-04 #6)
 *   GET  /api/v1/venue/price-history?symbol=BTC-PERP&kind=mark|index&since=<ISO>  public: the venue's mark or index
 *                                                      series on a perpetual we list; an unpublished index is `series:
 *                                                      null` with its reason (J-derivatives-08 #6)
 *   GET  /api/v1/venue/funding-payments?owner=&since=<ISO>  the funding the venue charged or paid on the account's
 *                                                      positions, one per position per period (J-derivatives-08 #3 #4 #5)
 *   GET  /api/v1/venue/book?symbol=BTC-USDC&depth=20    the venue's own book on a market we list (J-cex-spot-01 #5)
 *   GET  /api/v1/venue/trades?symbol=BTC-USDC&limit=50  the venue's newest prints there, newest first
 *   GET  /api/v1/venue/candles?symbol=BTC-USDC&interval=15m&limit=240   candles of the venue's prints, oldest first
 *   GET  /api/v1/venue/balances?owner=0x…              (and orders/open, positions, agents, builder-fee-approval)
 *   GET  /api/v1/venue/orders/by-client-id?owner=&clientOrderId=|clientOrderKey=   the venue's order, by its venue client id or
 *                                                      by the caller's own client id (the key it placed it under)
 *   GET  /api/v1/venue/fills?owner=&since=<ISO>
 *   GET  /api/v1/venue/withdrawals/:nonce?owner=
 *   GET  /api/v1/venue/withdrawal-terms?owner=&asset=   the venue's published withdrawal fee, network fee and arrival time (J-bank-31 #3)
 *   GET  /api/v1/venue/deposits?owner=                 the on-chain deposits the venue has seen: confirming, credited or not (J-dex-protocol-05 #2)
 *   GET  /api/v1/venue/arrivals?owner=                 the credits into the account from outside it: deposits and transfers in (J-portfolio-06 #3)
 *   GET  /api/v1/venue/deposit-routes                  how the venue takes each asset as a deposit, as it publishes it (J-wallet-24 #5 #6)
 *   GET  /api/v1/venue/leverage?owner=&symbol=
 *   POST /api/v1/venue/preview   { owner, intent }
 *   POST /api/v1/venue/convert/sell-quote   { owner, symbol, amount, quoteKey }   the venue's price for a sell (J-cex-spot-17 #8)
 *   GET  /api/v1/venue/convert/pairs                   what Convert may use now, each pair's limit, the restricted coins, paused
 *   GET  /api/v1/venue/convert/route?from=&to=         the market joining two assets, or why none does (J-cex-spot-11 #11)
 *   POST /api/v1/venue/convert/quote  { owner, from, to, amount, quoteKey }   a price that holds nothing (#3, #12)
 *   POST /api/v1/venue/convert/accept { owner, quoteId }   the quote's one venue order, prepared for the wallet (#5, #13)
 *   POST /api/v1/venue/convert/limit  { owner, from, to, amount, price, limitKey }   a resting venue order (#8)
 *   POST /api/v1/venue/convert/submit { actionKey, signature }   sent, never on a price past its window (#4)
 *   GET  /api/v1/venue/convert/history?owner=          accepted conversions as the venue records them (#10)
 *   POST /api/v1/venue/prepare   { owner, signer, intent, actionKey?, stepUpApprovalId? }
 *   POST /api/v1/venue/submit    { actionKey, signature }    sent on the venue the action was prepared for
 *   GET  /api/v1/venue/markets/:symbol/venues?owner=&side=   every configured venue for the market (J-derivatives-28 #1)
 *   POST /api/v1/venue/route-preview { owner, intent }       the venue chosen for the order, and why (#2, #4)
 *   GET  /api/v1/venue/orders?owner=&cursor=&limit=      this person's orders on the account, oldest first, a page at a time
 *   GET  /api/v1/venue/orders/by-key?idempotencyKey=|actionKey=   one order by its key: accepted, unknown, refused, not_sent
 *   GET  /api/v1/venue/orders/history?owner=&side=&status=&symbol=&from=&to=&limit=&before=   the account's orders as the
 *                                                      venue keeps them, newest first, a page at a time (J-cex-spot-06 #1)
 *   GET  /api/v1/venue/orders/record?owner=&clientOrderId=   our record of one order: the amendments the venue accepted
 *                                                      (#10) and our builder fee on it with any discount (#5)
 *   GET  /api/v1/venue/session?owner=0x…               this sign-in's trading session, read against the venue's agents
 *   POST /api/v1/venue/session/start { owner, agentAddress }   the owner's one approval for a fresh session key (prepared)
 *   POST /api/v1/venue/session/end   { owner }                 the owner's revoke of this sign-in's session key (prepared)
 *
 * The session approval and its revoke are signed by the owner wallet and sent with `/submit`, as any action
 * (src/venue/session-key.ts, J-wallet-22 #8). Orders in the session are prepared with `signer.role: 'agent'`. Sessions
 * are on the primary venue.
 *
 * With several venues configured (TRADE_USER_VENUE_URLS), every read, preview and prepare takes an optional `venueId`
 * (query or body); none named is the primary venue (TRADE_USER_VENUE_URL), as before.
 *
 * IDEMPOTENCY-KEY (J-developer-05; DV-auth-03): an order's prepare and submit may carry an `Idempotency-Key` header instead
 * of a `clientOrderKey` / `actionKey`. The order is stored and placed under that key, sent to the venue as its client
 * order id: a retry of the same key and body gets the stored answer (`idempotent-replayed: true`) and never a second
 * venue order; the same key with a changed order is `idempotency.conflict` (409); a second request while the first is
 * still sending is `idempotency.in_progress` (409, `retry-after`). A send with no definite answer stays `unknown` until
 * the venue answers a read by key.
 *
 * Reads need trade:read, writes trade:write, and every route but `status` the trade jurisdiction (as the grid's
 * routes do). An unverified person's desk reads the `denied.kyc_required` refusal and shows its form with Verify
 * (J-cex-spot-01 #2), never the venue's figures. Every Amount travels as a decimal string (`encodeVenueWire`). A venue refusal answers 422 with
 * `intafacedCode: trade.venue.<code>` and the venue's `refusal` (503 for `venue_down`); a step-up refusal 403.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { VenueMarginSamples } from './venue-margin-samples.js';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { EDGE_PRINCIPAL_HEADER, EDGE_SIGNATURE_HEADER } from '@intafaced/contracts/edge';
import { StepUpCheckError } from '@intafaced/contracts/step-up-check';
import {
  VenueRefusalError,
  hasSubAccountReads,
  VenueWireError,
  decodeVenueWire,
  encodeVenueWire,
  venueBalanceFigures,
  venuePositionFigures,
  type VenueIntent,
  type VenueSignature,
  type VenueSigner,
  type VenueCandleInterval,
  VENUE_CANDLE_INTERVALS,
  venueClientOrderId,
} from '@intafaced/venue-contracts';
import { toCcxtError } from '../ccxt-errors.js';
import { privateRead, privateWrite, publicRead } from '../route-inventory.js';
import { refuseRetailPriceImprovement } from '../spot/rpi.js';
import { UserVenueDoor, UserVenueDoorError, orderKeyOfIdempotencyKey } from './user-venue-door.js';
import type { UserVenueRouter } from './venue-router.js';
import { SessionKeys } from './session-key.js';
import { presentVenueSellQuote, type VenueSellQuotes } from './venue-sell-quotes.js';
import { presentConversion, presentConvertQuote, presentPairs, type VenueConverts } from './venue-convert.js';
import { StatementError } from '../statements/statement-export.js';
import type { VenueStatements } from './venue-statements.js';
import type { VenueAdlAcks } from './venue-adl-acks.js';
import type { UserVenueAccount } from '@intafaced/venue-contracts';
import type { LoggedBuilderFee } from '../builder-fee/builder-fee-store.js';
import { tradeTier } from '@intafaced/auth';

export interface UserVenueRestDeps {
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null;
  requireTradeJurisdiction: (req: FastifyRequest, reply: FastifyReply, principal: Principal) => boolean;
  /** The region and level gate's reason for this caller, or null when it may trade (the gated list reads it as a reason). */
  tradeAccessBlocker?: (req: FastifyRequest, principal: Principal) => { code: string; message: string } | null;
  /**
   * The owner's market price protection in basis points (TRADE_MARKET_SLIPPAGE_CAP_BPS), or null when blank, as
   * `best-prices` answers it. The desk bounds a venue spot market order's worst price by it, and the door enforces the same
   * bound on preview and prepare (UserVenueDoorDeps.slippageCapBps); blank, a spot market order refuses
   * (`trade.slippage_cap_unset`). Never a default.
   */
  slippageCapBps?: number | null;
  /** The owner's spread limit for a spot market order (TRADE_MARKET_SPREAD_LIMIT_BPS), or null when blank, as `best-prices` answers it. */
  spreadLimitBps?: number | null;
  /** Convert's sell quotes priced by the venue (J-cex-spot-17 #8); absent, the route answers the door's own refusal. */
  sellQuotes?: VenueSellQuotes | null;
  /** Convert on the customer's own venue account (J-cex-spot-11); absent, its routes refuse `trade.venue_convert_unwired`. */
  converts?: VenueConverts | null;
  /**
   * True when `principal` is an API key connected to an agent account (J-agents-21 #9; agent-orders.ts `confined`). Such
   * a key trades its agent account through the assistant's own route and nothing else: every other venue route refuses it
   * 403 `auth.scope_denied` (no move, withdraw or read of another account). Absent: no key is confined.
   */
  agentKeyConfined?: (principal: Principal) => Promise<boolean>;
  /** The statement export on the venue's own records (J-cex-spot-07 #5); absent, its routes answer 503 `trade.statements_unmounted`. */
  venueStatements?: VenueStatements | null;
  /** Keeps each margin summary the venue reports, for a founder's ratio history (J-derivatives-26 #8); null: none kept. `keep` never fails the read. */
  marginSamples?: VenueMarginSamples | null;
  /**
   * Each person's acknowledged version of a venue's auto-deleveraging rules (J-derivatives-07 #5); absent, the
   * acknowledgement routes answer 503 `trade.venue_adl_acks_unmounted`.
   */
  venueAdlAcks?: VenueAdlAcks | null;
  /** The clock an acknowledgement is stamped with; absent, the system clock. */
  now?: () => Date;
  /**
   * One person's builder fees on one venue account since a time, each with its ledger transaction (J-derivatives-12 #4;
   * src/builder-fee/builder-fee-store.ts `ofUser`). Absent: `builder-fees` answers 503 `trade.venue_builder_fees_unmounted`.
   */
  builderFeesOf?: ((userId: string, account: UserVenueAccount, since: Date) => Promise<readonly LoggedBuilderFee[]>) | null;
}

/** An acknowledgement of a version the venue no longer publishes (J-derivatives-07 #5): it is not stored. */
export const VENUE_ADL_VERSION_STALE = 'trade.venue_adl_version_stale' as const;

/** The refusal a connected agent key gets on any venue route but the assistant's own (J-agents-21 #9). */
export const AGENT_KEY_CONFINED_CODE = 'auth.scope_denied' as const;

/**
 * Refuse a connected agent key here, answering 403 `auth.scope_denied`; true when it was refused. Nothing is read or
 * prepared first, so the call changes nothing. A failed check refuses too (`trade.agent_key_check_unavailable`, 503).
 */
export async function refusedAgentKey(reply: FastifyReply, principal: Principal, deps: Pick<UserVenueRestDeps, 'agentKeyConfined'>) {
  if (!deps.agentKeyConfined || !principal.kid) return false;
  let confined: boolean;
  try {
    confined = await deps.agentKeyConfined(principal);
  } catch {
    reply.header('retry-after', '1');
    void reply.code(503).send({
      code: 'ExchangeNotAvailable',
      message: 'whether this key is an agent account key could not be read just now; nothing was done',
      intafacedCode: 'trade.agent_key_check_unavailable',
    });
    return true;
  }
  if (!confined) return false;
  void reply.code(403).send({
    code: 'PermissionDenied',
    message:
      "this key is your assistant's: it trades its agent account and can't move money, withdraw, or read or act on any other account",
    intafacedCode: AGENT_KEY_CONFINED_CODE,
  });
  return true;
}

type Query = {
  owner?: string;
  subAccount?: string;
  /** J-derivatives-05 #4: a leverage change's leverage (basis points of 1x) and margin mode. */
  leverageBps?: string;
  marginMode?: string;
  clientOrderId?: string;
  /** J-cex-spot-15 #5: the caller's own client id, the business key its order was placed under. */
  clientOrderKey?: string;
  since?: string;
  symbol?: string;
  cursor?: string;
  limit?: string;
  idempotencyKey?: string;
  actionKey?: string;
  venueId?: string;
  side?: string;
  asset?: string;
};

/** The request's Idempotency-Key header, or undefined when it has none. */
function idempotencyHeader(req: FastifyRequest): string | undefined {
  const v = req.headers['idempotency-key'];
  return Array.isArray(v) ? v.join(',') : v;
}

export function venueRefusalReply(reply: FastifyReply, err: unknown) {
  if (err instanceof VenueRefusalError) {
    const down = err.refusal.code === 'venue_down';
    return reply.code(down ? 503 : 422).send({
      code: down ? 'ExchangeNotAvailable' : 'InvalidOrder',
      message: err.refusal.detail,
      intafacedCode: `trade.venue.${err.refusal.code}`,
      refusal: err.refusal,
    });
  }
  if (err instanceof UserVenueDoorError) {
    if (err.code === 'idempotency.in_progress') reply.header('retry-after', '1');
    return reply.code(err.status).send({
      code:
        err.status === 404 ? 'NotFound' : err.status === 422 ? 'InvalidOrder' : err.status === 503 ? 'ExchangeNotAvailable' : 'BadRequest',
      message: err.message,
      intafacedCode: err.code,
    });
  }
  if (err instanceof StepUpCheckError) {
    const unavailable = err.code === 'identity.step_up_unavailable';
    return reply
      .code(unavailable ? 503 : 403)
      .send({ code: unavailable ? 'ExchangeNotAvailable' : 'PermissionDenied', message: err.message, intafacedCode: err.code });
  }
  if (err instanceof VenueWireError)
    return reply.code(400).send({ code: 'BadRequest', message: err.message, intafacedCode: 'trade.venue_request_invalid' });
  const shared = toCcxtError(err);
  if (shared) return reply.code(shared.status).send(shared.body);
  throw err;
}

export function attachUserVenueRoutes(app: FastifyInstance, router: UserVenueRouter | null, deps: UserVenueRestDeps): void {
  async function admit(req: FastifyRequest, reply: FastifyReply, scope: Scope): Promise<Principal | null> {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return null;
    if (await refusedAgentKey(reply, principal, deps)) return null;
    try {
      requireScope(principal, scope);
    } catch (error) {
      void venueRefusalReply(reply, error);
      return null;
    }
    return deps.requireTradeJurisdiction(req, reply, principal) ? principal : null;
  }

  /** Run `run` on the door of `venueId` (the primary venue when none is named); `replayed` marks a stored answer. */
  async function answer(
    reply: FastifyReply,
    run: (d: UserVenueDoor, r: UserVenueRouter) => Promise<unknown>,
    venueId?: string | null,
    replayed?: (value: unknown) => boolean,
  ) {
    try {
      if (!router)
        throw new UserVenueDoorError(
          'the user-venue door is off on this deployment (TRADE_USER_VENUE_URL unset)',
          'trade.user_venue_off',
          404,
        );
      const value = await run(await router.door(venueId), router);
      if (replayed?.(value)) reply.header('idempotent-replayed', 'true');
      return reply.code(200).send(encodeVenueWire(value));
    } catch (error) {
      return venueRefusalReply(reply, error);
    }
  }

  function body<T>(req: FastifyRequest): T {
    const raw = req.body;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new VenueWireError('the body must be a JSON object');
    return decodeVenueWire<T>(raw);
  }

  app.get('/api/v1/venue/status', privateRead, async (req, reply) => {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return;
    try {
      requireScope(principal, 'trade:read');
    } catch (error) {
      return venueRefusalReply(reply, error);
    }
    if (!router) return reply.code(200).send({ enabled: false });
    // The primary venue's status as before, and every configured venue with its health (J-derivatives-28).
    const primary = await router.primary.status();
    return reply.code(200).send(encodeVenueWire({ ...primary, routes: router.routes, venues: await router.venues() }));
  });

  app.get('/api/v1/venue/markets', privateRead, async (req, reply) => {
    if (!(await admit(req, reply, 'trade:read'))) return;
    // Only the markets two operators listed, each with our listing beside the venue's own state (J-cex-spot-16).
    return answer(reply, async (d) => d.markets(), (req.query as Query).venueId);
  });

  // J-derivatives-01 #2: each perpetual open or blocked for this account, with every reason. The region and level gate is
  // a reason here, not a refusal, so a person it blocks still sees why.
  app.get<{ Querystring: Query }>('/api/v1/venue/gated-list', privateRead, async (req, reply) => {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return;
    try {
      requireScope(principal, 'trade:read');
    } catch (error) {
      return venueRefusalReply(reply, error);
    }
    const account = deps.tradeAccessBlocker ? deps.tradeAccessBlocker(req, principal) : null;
    return answer(reply, async (d) => d.gatedList(account, tradeTier(principal)), req.query.venueId);
  });

  // J-derivatives-12 #5: the perpetuals this account is eligible for, each with its settle asset; none, with the reason,
  // when the owner's eligibility level is blank or the account is below it. A read: nothing is prepared or sent.
  app.get<{ Querystring: Query }>('/api/v1/venue/eligible-instruments', privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (d) => d.eligibleInstruments(tradeTier(principal)), req.query.venueId);
  });

  // J-derivatives-12 #4: our builder fee on each fill of the caller's own orders on this venue account, as the poster
  // recorded it, with the ledger transaction it posted (null until it is posted, with the ledger's refusal if it refused).
  // Only the caller's own: rows are read by their user id, so another person's fees on the same wallet are never shown.
  app.get<{ Querystring: Query }>('/api/v1/venue/builder-fees', privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(
      reply,
      async (d) => {
        const rowsOf = deps.builderFeesOf;
        if (!rowsOf) throw new UserVenueDoorError('builder-fee records are not mounted here', 'trade.venue_builder_fees_unmounted', 503);
        const since = new Date(req.query.since ?? '');
        if (Number.isNaN(since.getTime())) throw new VenueWireError('since is required (an ISO time)');
        const account = await d.readableAccount(req.query.owner ?? '', req.query.subAccount ?? null);
        const rows = await rowsOf(principal.userId, account, since);
        return {
          venueId: account.venueId,
          value: rows.map((r) => ({
            fillId: r.fillId,
            amount: r.amount,
            asset: r.assetId,
            filledAt: r.filledAt,
            status: r.status,
            refusalCode: r.refusalCode,
            ledgerTxId: r.ledgerTxId,
          })),
          asOf: (deps.now ?? (() => new Date()))(),
        };
      },
      req.query.venueId,
    );
  });

  // J-derivatives-28 #1: every configured venue for one market, with its own price, depth and fees, our builder fee,
  // whether the person can sign there, and its health. A down venue is a row with since when and why.
  app.get<{ Params: { symbol: string }; Querystring: Query }>('/api/v1/venue/markets/:symbol/venues', privateRead, async (req, reply) => {
    if (!(await admit(req, reply, 'trade:read'))) return;
    const side = req.query.side === 'sell' ? 'sell' : 'buy';
    return answer(reply, async (_d, r) => r.marketVenues(req.query.owner ?? null, req.params.symbol, side));
  });

  // J-derivatives-28 #2 and #4: which venue this order goes to, its expected fill and fees, and why.
  app.post('/api/v1/venue/route-preview', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (_d, r) => {
      const b = body<{ owner?: string; intent?: VenueIntent }>(req);
      return r.routePreview(principal, b.owner ?? '', b.intent as never);
    });
  });

  app.get<{ Querystring: Query }>('/api/v1/venue/best-prices', privateRead, async (req, reply) => {
    if (!(await admit(req, reply, 'trade:read'))) return;
    return answer(reply, async (d) => {
      if (!req.query.symbol) throw new VenueWireError('symbol is required');
      const venue = await d.venue();
      if (!venue.bestPrices)
        throw new VenueRefusalError({ venueId: venue.venue.id, code: 'not_offered', detail: 'this venue publishes no book' });
      const best = await venue.bestPrices(req.query.symbol);
      const cap = deps.slippageCapBps ?? null;
      const spread = deps.spreadLimitBps ?? null;
      return {
        ...best,
        slippageCapBps: cap === null ? { known: false } : { known: true, value: String(cap) },
        spreadLimitBps: spread === null ? { known: false } : { known: true, value: String(spread) },
      };
    });
  });

  // J-algo-dev-02 #5: the venue's published margin rules for the perpetual on an asset, public market data as the
  // funding history is; no account and no sign-in. A margin backtest reads them.
  app.get<{ Querystring: Query & { base?: string } }>('/api/v1/venue/margin-rules', publicRead, async (req, reply) => {
    return answer(
      reply,
      async (d) => {
        const base = req.query.base ?? '';
        if (!/^[A-Za-z0-9]{1,20}$/.test(base)) throw new VenueWireError('base is the asset, as BTC');
        return d.marginRules(base);
      },
      req.query.venueId,
    );
  });

  const isCandleInterval = (raw: string): raw is VenueCandleInterval => Object.hasOwn(VENUE_CANDLE_INTERVALS, raw);
  // J-algo-dev-04 #2: the venue's candles on the spot market we list on an asset, public market data as the margin rules
  // are; no account and no sign-in. A paper run prices from them.
  app.get<{ Querystring: Query & { base?: string; interval?: string; limit?: string } }>(
    '/api/v1/venue/spot-candles',
    publicRead,
    async (req, reply) => {
      return answer(
        reply,
        async (d) => {
          const base = req.query.base ?? '';
          if (!/^[A-Za-z0-9]{1,20}$/.test(base)) throw new VenueWireError('base is the asset, as BTC');
          const interval = req.query.interval ?? '';
          if (!isCandleInterval(interval)) throw new VenueWireError(`interval is one of ${Object.keys(VENUE_CANDLE_INTERVALS).join(', ')}`);
          return d.spotCandles(base, interval, whole(req.query.limit, 'limit', 500, 240));
        },
        req.query.venueId,
      );
    },
  );

  // J-charts-desk-01: public venue markets and candles for the chart workbench, signed in or signed out.
  // Door off refuses 404 trade.user_venue_off so the workbench falls back only when the venue door is switched off.
  app.get<{ Querystring: Query }>('/api/v1/venue/chart-markets', publicRead, async (req, reply) => {
    return answer(reply, async (d) => d.chartMarkets(), req.query.venueId);
  });
  app.get<{ Querystring: Query & { symbol?: string; interval?: string; limit?: string; since?: string } }>(
    '/api/v1/venue/chart-candles',
    publicRead,
    async (req, reply) => {
      return answer(
        reply,
        async (d) => {
          const interval = req.query.interval ?? '';
          if (!isCandleInterval(interval)) throw new VenueWireError(`interval is one of ${Object.keys(VENUE_CANDLE_INTERVALS).join(', ')}`);
          const sinceRaw = req.query.since;
          let since: Date | undefined;
          if (sinceRaw !== undefined && sinceRaw !== '') {
            since = new Date(sinceRaw);
            if (Number.isNaN(since.getTime())) throw new VenueWireError('since must be an ISO time');
          }
          return d.chartCandles({
            symbol: symbolOf(req.query.symbol),
            interval,
            limit: whole(req.query.limit, 'limit', UserVenueDoor.CHART_CANDLE_DEPTH, 240),
            since,
          });
        },
        req.query.venueId,
      );
    },
  );

  // J-charts-desk-04 #6: public market data, as the candle and trade routes are; no account and no sign-in.
  app.get<{ Querystring: Query & { base?: string; since?: string } }>('/api/v1/venue/funding-history', publicRead, async (req, reply) => {
    return answer(reply, async (d) => {
      const base = req.query.base ?? '';
      if (!/^[A-Za-z0-9]{1,20}$/.test(base)) throw new VenueWireError('base is the asset, as BTC');
      const since = new Date(req.query.since ?? '');
      if (Number.isNaN(since.getTime())) throw new VenueWireError('since is required (an ISO time)');
      return d.fundingHistory(base, since);
    });
  });

  // J-derivatives-08 #6: public market data, as the funding history is; no account and no sign-in.
  app.get<{ Querystring: Query & { symbol?: string; kind?: string; since?: string } }>(
    '/api/v1/venue/price-history',
    publicRead,
    async (req, reply) => {
      return answer(reply, async (d) => {
        const symbol = req.query.symbol ?? '';
        if (!/^[A-Za-z0-9][A-Za-z0-9/._-]{0,63}$/.test(symbol)) throw new VenueWireError('symbol is a perpetual, as BTC-PERP');
        const kind = req.query.kind;
        if (kind !== 'mark' && kind !== 'index') throw new VenueWireError('kind is mark or index');
        const since = new Date(req.query.since ?? '');
        if (Number.isNaN(since.getTime())) throw new VenueWireError('since is required (an ISO time)');
        return d.priceHistory(symbol, kind, since);
      });
    },
  );

  // J-derivatives-14 #4: a perpetual's open interest and the venue's long and short count, and its risk-limit tiers (or
  // `ladder_unset`): public market data, as the price history is; no account and no sign-in.
  app.get<{ Querystring: MarketQuery }>('/api/v1/venue/open-interest', publicRead, async (req, reply) => {
    return answer(reply, async (d) => d.openInterestStats(symbolOf(req.query.symbol)), req.query.venueId);
  });
  app.get<{ Querystring: MarketQuery }>('/api/v1/venue/risk-limits', publicRead, async (req, reply) => {
    return answer(reply, async (d) => d.riskLimits(symbolOf(req.query.symbol)), req.query.venueId);
  });

  // J-cex-spot-10 #2: the public fee page, signed in or not: the venue's tiers and rates, its builder-fee cap and ours.
  app.get<{ Querystring: Query }>('/api/v1/venue/fees', publicRead, async (req, reply) => {
    return answer(reply, async (d) => d.publicFees(), req.query.venueId);
  });

  // J-cex-spot-14 #1 #2 #5 #6 #7: each market we show with the venue's own trading state, session, opening window, zone,
  // our listing and upcoming maintenance beside them, signed in or not.
  app.get<{ Querystring: Query }>('/api/v1/venue/market-states', publicRead, async (req, reply) => {
    return answer(reply, async (d) => d.marketStates(), req.query.venueId);
  });

  // J-cex-spot-14 #8: public venue depth book, tickers and spreads, signed in or not.
  app.get<{ Querystring: MarketQuery & { depth?: string } }>('/api/v1/venue/public-book', publicRead, async (req, reply) => {
    return answer(reply, async (d) => d.publicBook(symbolOf(req.query.symbol), whole(req.query.depth, 'depth', 50, 20)), req.query.venueId);
  });
  app.get<{ Querystring: Query }>('/api/v1/venue/tickers', publicRead, async (req, reply) => {
    return answer(reply, async (d) => d.publicTickers(), req.query.venueId);
  });
  app.get<{ Querystring: Query }>('/api/v1/venue/spreads', publicRead, async (req, reply) => {
    return answer(reply, async (d) => d.publicSpreads(), req.query.venueId);
  });

  // J-cex-spot-14 #9: public market analytics from the venue's own trade tape; blank window refuses trade.analytics_window_unset.
  app.get<{ Querystring: Query & { window?: string } }>('/api/v1/venue/analytics', publicRead, async (req, reply) => {
    return answer(reply, async (d) => d.publicAnalytics(symbolOf(req.query.symbol), req.query.window), req.query.venueId);
  });

  // J-derivatives-31 #1: the vaults the venue lists, signed in or not, each with its lock-up, leader profit share, value and
  // past return as the venue publishes them (null: not published). A venue that lists none refuses not_offered.
  app.get<{ Querystring: Query }>('/api/v1/venue/vaults', publicRead, async (req, reply) => {
    return answer(
      reply,
      async (d) => {
        const venue = await d.venue();
        if (!venue.vaults)
          throw new VenueRefusalError({
            venueId: venue.venue.id,
            code: 'not_offered',
            detail: `${venue.venue.displayName} lists no vaults`,
          });
        return venue.vaults();
      },
      req.query.venueId,
    );
  });

  // J-cex-spot-21 #1: the venue's staking terms, signed in or not: its validators with their commission, stake and status,
  // its reward rate, discount tiers, lock-up, queue and limit as it publishes them (null: not published).
  app.get<{ Querystring: Query }>('/api/v1/venue/staking', publicRead, async (req, reply) => {
    return answer(
      reply,
      async (d) => {
        const venue = await d.venue();
        if (!venue.staking)
          throw new VenueRefusalError({
            venueId: venue.venue.id,
            code: 'not_offered',
            detail: `${venue.venue.displayName} lists no staking`,
          });
        return venue.staking();
      },
      req.query.venueId,
    );
  });

  // J-derivatives-07 #4: the venue's own insurance fund or vault and where to read it, signed in or not. A venue that
  // publishes none answers `known: false`, read as "not published by this venue", never a zero. INTAFACED runs no fund.
  app.get<{ Querystring: Query }>('/api/v1/venue/insurance-fund', publicRead, async (req, reply) => {
    return answer(
      reply,
      async (d) => {
        const venue = await d.venue();
        const read = venue.insuranceFund
          ? await venue.insuranceFund()
          : { venueId: venue.venue.id, value: { known: false }, asOf: new Date() };
        return { ...read, venueName: venue.venue.displayName };
      },
      req.query.venueId,
    );
  });

  // J-derivatives-07 #7: the venue's public liquidation and auto-deleveraging alerts on the markets we list, newest first:
  // the market, side, size and price, and no account identity. Signed in or not.
  app.get<{ Querystring: MarketQuery }>('/api/v1/venue/liquidation-alerts', publicRead, async (req, reply) => {
    return answer(
      reply,
      async (d) => {
        const symbol = req.query.symbol === undefined ? null : symbolOf(req.query.symbol);
        const limit = whole(req.query.limit, 'limit', 500, 50);
        const venue = await d.venue();
        if (!venue.liquidationAlerts)
          throw new VenueRefusalError({
            venueId: venue.venue.id,
            code: 'not_offered',
            detail: `${venue.venue.displayName} publishes no liquidation alerts`,
          });
        const listed = new Set((await d.markets()).value.map((m) => m.symbol));
        if (symbol !== null && !listed.has(symbol))
          throw new VenueRefusalError({ venueId: venue.venue.id, code: 'not_offered', detail: `${symbol} is not a market listed here` });
        const read = await venue.liquidationAlerts(symbol, limit);
        // Only what a public alert carries, so nothing a venue adds to one can name an account.
        return {
          ...read,
          value: read.value
            .filter((x) => listed.has(x.symbol))
            .map((x) => ({ kind: x.kind, symbol: x.symbol, side: x.side, size: x.size, price: x.price, alertedAt: x.alertedAt })),
        };
      },
      req.query.venueId,
    );
  });

  // J-derivatives-07 #5: the venue's auto-deleveraging rules with their version, and whether this person has read that
  // version. "I have read this" stores the version read; a version the venue has since replaced does not count.
  const adlDisclosure = async (d: UserVenueDoor, userId: string) => {
    const acks = deps.venueAdlAcks;
    if (!acks)
      throw new UserVenueDoorError('auto-deleveraging acknowledgements are not mounted here', 'trade.venue_adl_acks_unmounted', 503);
    const venue = await d.venue();
    if (!venue.adlRules)
      throw new VenueRefusalError({
        venueId: venue.venue.id,
        code: 'not_offered',
        detail: `${venue.venue.displayName} publishes no auto-deleveraging rules`,
      });
    const rules = await venue.adlRules();
    const ack = await acks.get(userId, venue.venue.id);
    const current = rules.value !== null && ack !== null && ack.version === rules.value.version;
    return {
      venueId: venue.venue.id,
      venueName: venue.venue.displayName,
      asOf: rules.asOf,
      rules: rules.value,
      acknowledged: current,
      acknowledgedVersion: ack?.version ?? null,
      acknowledgedAt: ack?.acknowledgedAt ?? null,
    };
  };
  app.get<{ Querystring: Query }>('/api/v1/venue/adl-disclosure', privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (d) => adlDisclosure(d, principal.userId), req.query.venueId);
  });
  app.post('/api/v1/venue/adl-disclosure/ack', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    let b: { version?: unknown; venueId?: unknown };
    try {
      b = body<{ version?: unknown; venueId?: unknown }>(req);
    } catch (error) {
      return venueRefusalReply(reply, error);
    }
    const venueId = typeof b.venueId === 'string' ? b.venueId : null;
    return answer(
      reply,
      async (d) => {
        if (typeof b.version !== 'string' || b.version.trim() === '') throw new VenueWireError('version is the version you read');
        const now = await adlDisclosure(d, principal.userId);
        if (!now.rules)
          throw new VenueRefusalError({
            venueId: now.venueId,
            code: 'not_offered',
            detail: `${now.venueName} publishes no auto-deleveraging rules to acknowledge`,
          });
        if (b.version !== now.rules.version)
          throw new UserVenueDoorError(
            `version ${b.version} is not the one ${now.venueName} publishes now (${now.rules.version}): read the current rules and acknowledge them`,
            VENUE_ADL_VERSION_STALE,
            409,
          );
        await deps.venueAdlAcks!.record(principal.userId, now.venueId, now.rules.version, (deps.now ?? (() => new Date()))());
        return adlDisclosure(d, principal.userId);
      },
      venueId,
    );
  });

  // J-cex-spot-01 #5: the venue's public book, prints and candles on a market we list, as the spot desk draws them. Gated
  // as `markets` and `best-prices` are: venue market data is for a person the trade jurisdiction admits.
  const whole = (raw: string | undefined, name: string, most: number, fallback: number) => {
    if (raw === undefined) return fallback;
    const n = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
    if (!(n >= 1 && n <= most)) throw new VenueWireError(`${name} is a whole number from 1 to ${most}`);
    return n;
  };
  const symbolOf = (raw: string | undefined) => {
    if (!raw || !/^[A-Za-z0-9]{1,20}-[A-Za-z0-9]{1,20}$/.test(raw)) throw new VenueWireError('symbol is the venue market, as BTC-USDC');
    return raw;
  };
  type MarketQuery = Query & { depth?: string; limit?: string; interval?: string; since?: string };
  app.get<{ Querystring: MarketQuery }>('/api/v1/venue/book', privateRead, async (req, reply) => {
    if (!(await admit(req, reply, 'trade:read'))) return;
    return answer(reply, async (d) => d.marketBook(symbolOf(req.query.symbol), whole(req.query.depth, 'depth', 50, 20)));
  });
  app.get<{ Querystring: MarketQuery }>('/api/v1/venue/trades', privateRead, async (req, reply) => {
    if (!(await admit(req, reply, 'trade:read'))) return;
    return answer(reply, async (d) => d.marketTrades(symbolOf(req.query.symbol), whole(req.query.limit, 'limit', 500, 50)));
  });
  app.get<{ Querystring: MarketQuery }>('/api/v1/venue/candles', privateRead, async (req, reply) => {
    if (!(await admit(req, reply, 'trade:read'))) return;
    return answer(reply, async (d) => {
      const interval = req.query.interval ?? '';
      if (!Object.hasOwn(VENUE_CANDLE_INTERVALS, interval))
        throw new VenueWireError(`interval is one of ${Object.keys(VENUE_CANDLE_INTERVALS).join(', ')}`);
      const sinceRaw = req.query.since;
      let since: Date | undefined;
      if (sinceRaw !== undefined && sinceRaw !== '') {
        since = new Date(sinceRaw);
        if (Number.isNaN(since.getTime())) throw new VenueWireError('since must be an ISO time');
      }
      return d.marketCandles({
        symbol: symbolOf(req.query.symbol),
        interval: interval as VenueCandleInterval,
        limit: whole(req.query.limit, 'limit', UserVenueDoor.CHART_CANDLE_DEPTH, 240),
        since,
      });
    });
  });

  type Account = Awaited<ReturnType<UserVenueDoor['account']>>;
  type AccountRead = { account: Account; principal: Principal };
  // The venue's account reads, by path. Registered in one literal loop so the published route list can see every one
  // (apps/customer developers-reference.test.ts reads `for (const path of [...])`).
  const accountReads: Record<string, (d: UserVenueDoor, q: Query, ctx: AccountRead) => Promise<unknown>> = {
    // b2 change 6: every figure the person sees of their venue money is the venue's, with its own time and a state.
    '/api/v1/venue/balances': async (d, _q, { account: a }) => {
      const venue = await d.venue();
      const read = await venue.balances(a);
      return { ...read, figures: venueBalanceFigures(venue.venue, read, new Date()) };
    },
    '/api/v1/venue/orders/open': async (d, _q, { account: a, principal: p }) => d.openOrders(p, a),
    '/api/v1/venue/positions': async (d, _q, { account: a }) => {
      const venue = await d.venue();
      const read = await venue.positions(a);
      return { ...read, figures: venuePositionFigures(venue.venue, read, new Date()) };
    },
    '/api/v1/venue/agents': async (d, _q, { account: a }) => (await d.venue()).agents(a),
    // The owner's sub-accounts, read on the main account (J-agents-08 #2: the accounts a person may give their agent).
    '/api/v1/venue/sub-accounts': async (d, _q, { account: a }) => {
      const venue = await d.venue();
      if (a.subAccount !== null) throw new VenueWireError('sub-accounts are read on the main account: send no subAccount');
      if (!hasSubAccountReads(venue))
        throw new VenueRefusalError({
          venueId: a.venueId,
          code: 'not_offered',
          detail: `${venue.venue.displayName} offers no sub-accounts`,
        });
      return venue.subAccounts(a);
    },
    // J-cex-spot-15 #5: a bot looks its order up by its own client id (`clientOrderKey`, the business key it placed the
    // order under), or by the venue's client order id; the venue answers with the order's own state.
    '/api/v1/venue/orders/by-client-id': async (d, q, { account: a, principal: p }) => {
      if (q.clientOrderId && q.clientOrderKey) throw new VenueWireError('send clientOrderId or clientOrderKey, not both');
      const id = q.clientOrderKey ? venueClientOrderId(a.venueId, q.clientOrderKey) : q.clientOrderId;
      if (!id) throw new VenueWireError('clientOrderId or clientOrderKey is required');
      return d.orderByClientId(p, a, id);
    },
    '/api/v1/venue/fills': async (d, q, { account: a }) => {
      const since = new Date(q.since ?? '');
      if (Number.isNaN(since.getTime())) throw new VenueWireError('since is required (an ISO time)');
      return (await d.venue()).fills(a, since);
    },
    // J-dex-protocol-05 #2: the venue's own list of the deposits it has seen; a venue that publishes none refuses not_offered.
    '/api/v1/venue/deposits': async (d, _q, { account: a }) => {
      const venue = await d.venue();
      if (!venue.deposits)
        throw new VenueRefusalError({ venueId: venue.venue.id, code: 'not_offered', detail: 'this venue publishes no deposit list' });
      return venue.deposits(a);
    },
    // J-portfolio-06 #3: the credits into the account from outside it (deposits, transfers in); a venue that publishes none refuses not_offered.
    '/api/v1/venue/arrivals': async (d, _q, { account: a }) => {
      const venue = await d.venue();
      if (!venue.arrivals)
        throw new VenueRefusalError({ venueId: venue.venue.id, code: 'not_offered', detail: 'this venue publishes no credit list' });
      return venue.arrivals(a);
    },
    // J-bank-31 #3: the venue's published withdrawal terms for an asset, read before anything is signed; a venue that
    // publishes none refuses not_offered, and the review shows every term as not known.
    '/api/v1/venue/withdrawal-terms': async (d, q) => {
      if (!q.asset || !/^[A-Z0-9]{2,12}$/.test(q.asset)) throw new VenueWireError('asset is required');
      const venue = await d.venue();
      if (!venue.withdrawalTerms)
        throw new VenueRefusalError({ venueId: venue.venue.id, code: 'not_offered', detail: 'this venue publishes no withdrawal terms' });
      return venue.withdrawalTerms(q.asset);
    },
    // J-wallet-24 #5 #6: how the venue takes each of its assets as a deposit, as it publishes it; a venue that publishes
    // none refuses not_offered.
    '/api/v1/venue/deposit-routes': async (d) => {
      const venue = await d.venue();
      if (!venue.depositRoutes)
        throw new VenueRefusalError({ venueId: venue.venue.id, code: 'not_offered', detail: 'this venue publishes no deposit routes' });
      return venue.depositRoutes();
    },
    '/api/v1/venue/leverage': async (d, q, { account: a }) => {
      if (!q.symbol) throw new VenueWireError('symbol is required');
      return (await d.venue()).leverage(a, q.symbol);
    },
    // J-derivatives-05 #4: what a leverage change would do to the open position's margin, by the venue's own rule, read
    // before anything is signed; a venue that reads none refuses not_offered, and the app says it states no difference.
    '/api/v1/venue/leverage-change': async (d, q, { account: a }) => {
      if (!q.symbol) throw new VenueWireError('symbol is required');
      const bps = Number(q.leverageBps);
      if (!Number.isInteger(bps) || bps < 1) throw new VenueWireError('leverageBps is a whole number of basis points of 1x');
      if (q.marginMode !== 'cross' && q.marginMode !== 'isolated') throw new VenueWireError('marginMode is cross or isolated');
      const venue = await d.venue();
      if (!venue.leverageChange)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} states no margin difference for a leverage change`,
        });
      return venue.leverageChange(a, q.symbol, bps, q.marginMode);
    },
    // J-derivatives-06 #2 #3: an open isolated position's margin and the venue's own limit for removing it, read before
    // anything is signed; a venue that reads none refuses not_offered.
    '/api/v1/venue/isolated-margin': async (d, q, { account: a }) => {
      if (!q.symbol) throw new VenueWireError('symbol is required');
      const venue = await d.venue();
      if (!venue.isolatedMargin)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} reads no isolated position margin`,
        });
      return venue.isolatedMargin(a, q.symbol);
    },
    // J-derivatives-06 #1: the account's equity, free, used margin, maintenance and margin ratio as the venue reports them.
    '/api/v1/venue/account-summary': async (d, _q, { account: a }) => {
      const venue = await d.venue();
      if (!venue.accountSummary)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} reports no account margin summary`,
        });
      const read = await venue.accountSummary(a);
      // The venue keeps no history of the margin: our door keeps this reading for a founder's ratio history (J-derivatives-26
      // #8). A reading that cannot be kept never fails the person's own read; it is logged.
      await deps.marginSamples?.keep(a, read);
      return read;
    },
    // J-derivatives-29 #1 #9 #11: the account's mode, its spot and perps balances in standard mode, and the day's action
    // count, as the venue reports them; a venue that reads none refuses not_offered, and the app says "not known".
    '/api/v1/venue/account-mode': async (d, _q, { account: a }) => {
      const venue = await d.venue();
      if (!venue.accountMode)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} does not report the account mode`,
        });
      return venue.accountMode(a);
    },
    // J-derivatives-05 #3: the position mode the account holds one perpetual in, as the venue reports it; a venue with one
    // mode that reads none refuses not_offered, and the room shows that one mode.
    '/api/v1/venue/position-mode': async (d, q, { account: a }) => {
      if (!q.symbol) throw new VenueWireError('symbol is required');
      const venue = await d.venue();
      if (!venue.positionMode)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} does not report a position mode`,
        });
      return venue.positionMode(a, q.symbol);
    },
    // J-derivatives-31 #2 #3 #5: the account's vault positions with their lock-up ends, its account value as the venue
    // counts it, and its vault transfers; a venue that reads none refuses not_offered.
    '/api/v1/venue/vault-holdings': async (d, _q, { account: a }) => {
      const venue = await d.venue();
      if (!venue.vaultHoldings)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} reports no vault positions`,
        });
      return venue.vaultHoldings(a);
    },
    // J-cex-spot-21 #2 #3 #6 #7 #8: the account's staking balance, delegations with their lock-up ends, queued and arrived
    // withdrawals and rewards; a venue that reads none refuses not_offered.
    '/api/v1/venue/staking-account': async (d, _q, { account: a }) => {
      const venue = await d.venue();
      if (!venue.stakingAccount)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} reports no staking`,
        });
      return venue.stakingAccount(a);
    },
    // J-derivatives-07 #1 #3: the position's liquidation state on one market and the venue's price and fee rules, in its
    // own words; a venue that reads none refuses not_offered.
    '/api/v1/venue/liquidation': async (d, q, { account: a }) => {
      if (!q.symbol) throw new VenueWireError('symbol is required');
      const venue = await d.venue();
      if (!venue.liquidationStatus)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} reports no liquidation state`,
        });
      return venue.liquidationStatus(a, q.symbol);
    },
    // J-derivatives-07 #2 #3: each liquidation the venue reports for the account, with every part's price, size, fee and
    // the venue's ids; since an ISO time, or every one the venue keeps.
    '/api/v1/venue/liquidations': async (d, q, { account: a }) => {
      const since = new Date(q.since ?? 0);
      if (Number.isNaN(since.getTime())) throw new VenueWireError('since is an ISO time');
      const venue = await d.venue();
      if (!venue.liquidations)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} reports no liquidations`,
        });
      return venue.liquidations(a, since);
    },
    // J-derivatives-07 #6: each auto-deleveraging of the account's positions, with the venue's notice.
    '/api/v1/venue/deleverages': async (d, q, { account: a }) => {
      const since = new Date(q.since ?? 0);
      if (Number.isNaN(since.getTime())) throw new VenueWireError('since is an ISO time');
      const venue = await d.venue();
      if (!venue.deleverages)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} reports no auto-deleveraging`,
        });
      return venue.deleverages(a, since);
    },
    // J-derivatives-27 #7: the person's balance in the margin account a market's deployer keeps for it, on the main
    // account; a venue that reads none refuses not_offered.
    '/api/v1/venue/market-margin': async (d, q, { account: a }) => {
      if (!q.symbol) throw new VenueWireError('symbol is required');
      const venue = await d.venue();
      if (!venue.marketMargin)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} reads no market margin account`,
        });
      return venue.marketMargin(a, q.symbol);
    },
    // J-derivatives-27 #9 #10: the person's settlements in a market deployer's halt or a split, as the venue records them.
    '/api/v1/venue/settlements': async (d, q, { account: a }) => {
      const since = new Date(q.since ?? '');
      if (Number.isNaN(since.getTime())) throw new VenueWireError('since is required (an ISO time)');
      const venue = await d.venue();
      if (!venue.settlements)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} reports no market settlements`,
        });
      return venue.settlements(a, since);
    },
    // J-derivatives-08 #3 #4 #5: the funding the venue charged or paid on the person's positions, as it booked it.
    '/api/v1/venue/funding-payments': async (d, q, { account: a }) => {
      const since = new Date(q.since ?? '');
      if (Number.isNaN(since.getTime())) throw new VenueWireError('since is required (an ISO time)');
      const venue = await d.venue();
      if (!venue.fundingPayments)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} reports no funding payments`,
        });
      return venue.fundingPayments(a, since);
    },
    // J-cex-spot-07: the venue's own scheduled cancel for this account; a venue that offers none refuses not_offered.
    '/api/v1/venue/scheduled-cancel': async (d, _q, { account: a }) => {
      const venue = await d.venue();
      if (!venue.venue.scheduledCancel || !venue.scheduledCancel)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'not_offered',
          detail: `${venue.venue.displayName} offers no scheduled cancel`,
        });
      return venue.scheduledCancel(a);
    },
    // J-cex-spot-10 #6: the account's own fee tier, volume and rates as the venue reports them.
    '/api/v1/venue/fee-tier': async (d, _q, { account: a }) => d.accountFees(a),
    // Read against our builder address alone, so an approval stays readable while the fee is blank (J-derivatives-30 #1).
    '/api/v1/venue/builder-fee-approval': async (d, _q, { account: a }) => {
      const builder = d.publishedBuilderAddress();
      if (!builder)
        throw new VenueRefusalError({
          venueId: a.venueId,
          code: 'builder_fee_not_published',
          detail: 'our builder is not published (owner value blank)',
        });
      return (await d.venue()).builderFeeApproval(a, builder);
    },
  };
  for (const path of [
    '/api/v1/venue/balances',
    '/api/v1/venue/orders/open',
    '/api/v1/venue/positions',
    '/api/v1/venue/agents',
    '/api/v1/venue/sub-accounts',
    '/api/v1/venue/orders/by-client-id',
    '/api/v1/venue/fills',
    '/api/v1/venue/deposits',
    '/api/v1/venue/arrivals',
    '/api/v1/venue/withdrawal-terms',
    '/api/v1/venue/deposit-routes',
    '/api/v1/venue/leverage',
    '/api/v1/venue/leverage-change',
    '/api/v1/venue/isolated-margin',
    '/api/v1/venue/account-summary',
    '/api/v1/venue/account-mode',
    '/api/v1/venue/position-mode',
    '/api/v1/venue/vault-holdings',
    '/api/v1/venue/staking-account',
    '/api/v1/venue/liquidation',
    '/api/v1/venue/liquidations',
    '/api/v1/venue/deleverages',
    '/api/v1/venue/market-margin',
    '/api/v1/venue/settlements',
    '/api/v1/venue/funding-payments',
    '/api/v1/venue/scheduled-cancel',
    '/api/v1/venue/builder-fee-approval',
    '/api/v1/venue/fee-tier',
  ]) {
    const read = accountReads[path]!;
    app.get<{ Querystring: Query }>(path, privateRead, async (req, reply) => {
      const principal = await admit(req, reply, 'trade:read');
      if (!principal) return;
      return answer(
        reply,
        async (d) =>
          read(d, req.query, { account: await d.readableAccount(req.query.owner ?? '', req.query.subAccount ?? null), principal }),
        req.query.venueId,
      );
    });
  }

  // J-cex-spot-07 #5: a statement of the venue account's orders, trades and money movements for a range, from the venue's
  // own records. `POST` creates the job for its request key once and builds it once; the file is read by the job's id.
  const statementRefused = (reply: FastifyReply, err: unknown) => {
    if (err instanceof StatementError) {
      const code =
        err.status === 404 ? 'NotFound' : err.status === 409 ? 'InvalidOrder' : err.status === 429 ? 'RateLimitExceeded' : 'BadRequest';
      return reply.code(err.status).send({ code, message: err.message, intafacedCode: err.code });
    }
    return venueRefusalReply(reply, err);
  };
  const statementsUnmounted = (reply: FastifyReply) =>
    reply.code(503).send({
      code: 'ExchangeNotAvailable',
      message: 'venue statement export is not mounted',
      intafacedCode: 'trade.statements_unmounted',
    });
  app.post('/api/v1/venue/statements', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    const statements = deps.venueStatements ?? null;
    if (!statements) return statementsUnmounted(reply);
    try {
      if (!router)
        throw new UserVenueDoorError(
          'the user-venue door is off on this deployment (TRADE_USER_VENUE_URL unset)',
          'trade.user_venue_off',
          404,
        );
      const b = (req.body ?? {}) as { owner?: unknown; venueId?: unknown; from?: unknown; to?: unknown; requestKey?: unknown };
      const d = await router.door(typeof b.venueId === 'string' ? b.venueId : null);
      const job = await statements.request(principal, { from: b.from, to: b.to, requestKey: b.requestKey }, async () => {
        const account = await d.account(typeof b.owner === 'string' ? b.owner : '');
        return { venue: await d.venue(), account, withdrawalNonces: await d.withdrawalNonces(principal, account) };
      });
      return reply.code(200).send(job);
    } catch (err) {
      return statementRefused(reply, err);
    }
  });
  app.get<{ Params: { id: string } }>('/api/v1/venue/statements/:id/file', privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    const statements = deps.venueStatements ?? null;
    if (!statements) return statementsUnmounted(reply);
    try {
      const file = await statements.file(principal, req.params.id);
      // JSON, for a browser client that reads JSON only and saves the bytes itself. A statement is personal: no cache.
      return reply.code(200).header('cache-control', 'private, no-store').send(file);
    } catch (err) {
      return statementRefused(reply, err);
    }
  });

  app.get<{ Params: { nonce: string }; Querystring: Query }>('/api/v1/venue/withdrawals/:nonce', privateRead, async (req, reply) => {
    if (!(await admit(req, reply, 'trade:read'))) return;
    return answer(
      reply,
      async (d) => (await d.venue()).withdrawal(await d.account(req.query.owner ?? '', req.query.subAccount ?? null), req.params.nonce),
      req.query.venueId,
    );
  });

  /** The body, or the typed 400 already sent (`null`). */
  function bodyOr<T>(req: FastifyRequest, reply: FastifyReply): T | null {
    try {
      return body<T>(req);
    } catch (error) {
      void venueRefusalReply(reply, error);
      return null;
    }
  }

  /** Refuse the retail price improvement flag on any venue preview or prepare (J-cex-spot-14 #11). */
  function checkNoRpi(req: FastifyRequest, reply: FastifyReply): boolean {
    try {
      refuseRetailPriceImprovement(req.body);
      if (typeof req.body === 'object' && req.body !== null && 'intent' in req.body) {
        refuseRetailPriceImprovement(req.body.intent);
      }
      return true;
    } catch (err) {
      void venueRefusalReply(reply, err);
      return false;
    }
  }

  app.post('/api/v1/venue/preview', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    if (!checkNoRpi(req, reply)) return;
    const b = bodyOr<{ owner?: string; intent?: VenueIntent; venueId?: string | null; requestDeadline?: string | null }>(req, reply);
    if (!b) return;
    return answer(
      reply,
      async (d) => {
        d.assertRequestDeadline(b.requestDeadline ?? null);
        return d.preview(principal, b.owner ?? '', b.intent as VenueIntent);
      },
      b.venueId,
    );
  });

  // A Convert sell priced by the venue's own preview on the customer's account, stored under its business key. Sends
  // nothing to the venue and moves no money; a trade:write scope, as the preview it is made from.
  app.post('/api/v1/venue/convert/sell-quote', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async () => {
      if (!deps.sellQuotes)
        throw new UserVenueDoorError('venue sell quotes are not wired on this deployment', 'trade.venue_sell_quote_unwired', 503);
      const b = body<{ owner?: string; symbol?: string; amount?: bigint; quoteKey?: string }>(req);
      const quote = await deps.sellQuotes.quote(principal, {
        owner: b.owner ?? '',
        symbol: b.symbol ?? '',
        amount: b.amount as bigint,
        quoteKey: b.quoteKey ?? '',
      });
      return presentVenueSellQuote(quote);
    });
  });

  // Convert on the customer's own venue account (src/venue/venue-convert.ts, J-cex-spot-11), on the primary venue.
  /** The edge-signed principal of this request, byte for byte, for svc-bank to answer the person's own cash leg (#11). */
  const forwardedOf = (req: FastifyRequest): Record<string, string> => {
    const h = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const raw = h(EDGE_PRINCIPAL_HEADER);
    const sig = h(EDGE_SIGNATURE_HEADER);
    if (!raw || !sig) return {};
    return { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: sig, 'x-intafaced-region': h('x-intafaced-region') ?? 'XX' };
  };
  const converts = (): VenueConverts => {
    if (!deps.converts) throw new UserVenueDoorError('venue Convert is not wired on this deployment', 'trade.venue_convert_unwired', 503);
    return deps.converts;
  };
  app.get('/api/v1/venue/convert/pairs', privateRead, async (req, reply) => {
    if (!(await admit(req, reply, 'trade:read'))) return;
    return answer(reply, async (d) => presentPairs(await converts().forPerson(forwardedOf(req)).pairs(d)));
  });
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/v1/venue/convert/route', privateRead, async (req, reply) => {
    if (!(await admit(req, reply, 'trade:read'))) return;
    return answer(reply, async (d) => {
      const { market, side, cash } = await converts()
        .forPerson(forwardedOf(req))
        .route(d, req.query.from ?? '', req.query.to ?? '');
      return cash
        ? { kind: 'linked', symbol: market.symbol, side, cash: { asset: cash.cash, via: cash.coin, label: cash.label, test: cash.test } }
        : { kind: 'direct', symbol: market.symbol, side };
    });
  });
  app.post('/api/v1/venue/convert/quote', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (d) => {
      const b = body<{ owner?: string; from?: string; to?: string; amount?: bigint; quoteKey?: string }>(req);
      const quote = await converts()
        .forPerson(forwardedOf(req))
        .quote(d, principal, {
          owner: b.owner ?? '',
          from: b.from ?? '',
          to: b.to ?? '',
          amount: b.amount ?? 0n,
          quoteKey: b.quoteKey ?? '',
        });
      return presentConvertQuote(quote);
    });
  });
  app.post('/api/v1/venue/convert/accept', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (d) => {
      const b = body<{ owner?: string; quoteId?: string }>(req);
      return converts()
        .forPerson(forwardedOf(req))
        .accept(d, principal, { owner: b.owner ?? '', quoteId: b.quoteId ?? '' });
    });
  });
  app.post('/api/v1/venue/convert/limit', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (d) => {
      const b = body<{ owner?: string; from?: string; to?: string; amount?: bigint; price?: bigint; limitKey?: string }>(req);
      return converts().limit(d, principal, {
        owner: b.owner ?? '',
        from: b.from ?? '',
        to: b.to ?? '',
        amount: b.amount ?? 0n,
        price: b.price ?? 0n,
        limitKey: b.limitKey ?? '',
      });
    });
  });
  app.post('/api/v1/venue/convert/submit', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (d) => {
      const b = body<{ actionKey?: string; signature?: VenueSignature }>(req);
      return converts().submit(d, principal, { actionKey: b.actionKey ?? '', signature: b.signature });
    });
  });
  app.get<{ Querystring: { owner?: string } }>('/api/v1/venue/convert/history', privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (d) => {
      const read = await converts()
        .forPerson(forwardedOf(req))
        .history(d, principal, req.query.owner ?? '');
      return { conversions: read.conversions.map(presentConversion), asOf: read.asOf?.toISOString() ?? null };
    });
  });

  app.post('/api/v1/venue/prepare', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    if (!checkNoRpi(req, reply)) return;
    const b = bodyOr<{
      owner?: string;
      subAccount?: string | null;
      signer?: VenueSigner;
      intent?: VenueIntent;
      actionKey?: string | null;
      stepUpApprovalId?: string | null;
      venueId?: string | null;
      requestDeadline?: string | null;
    }>(req, reply);
    if (!b) return;
    return answer(
      reply,
      async (d) =>
        d.prepare(principal, {
          owner: b.owner ?? '',
          subAccount: b.subAccount ?? null,
          signer: b.signer as VenueSigner,
          intent: b.intent as VenueIntent,
          actionKey: b.actionKey ?? null,
          stepUpApprovalId: b.stepUpApprovalId ?? null,
          idempotencyKey: idempotencyHeader(req) ?? null,
          requestDeadline: b.requestDeadline ?? null,
        }),
      b.venueId,
      (v) => (v as { reused?: boolean }).reused === true,
    );
  });

  // `answer` refuses `trade.user_venue_off` before `run` when the door is off, so `sessions` is set whenever it runs.
  // Trading sessions (J-wallet-22) are on the primary venue.
  const door = router?.primary ?? null;
  const sessions = door ? new SessionKeys({ door, ...door.sessionDeps }) : null;
  const session = (run: (s: SessionKeys) => Promise<unknown>) => () => run(sessions!);

  app.get<{ Querystring: Query }>('/api/v1/venue/session', privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(
      reply,
      session((s) => s.status(principal, req.query.owner ?? '')),
    );
  });

  app.post('/api/v1/venue/session/start', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(
      reply,
      session((s) => {
        const b = body<{ owner?: string; agentAddress?: string }>(req);
        return s.start(principal, b.owner ?? '', b.agentAddress ?? '');
      }),
    );
  });

  app.post('/api/v1/venue/session/end', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(
      reply,
      session((s) => s.end(principal, body<{ owner?: string }>(req).owner ?? '')),
    );
  });

  // Sent on the venue the stored action was prepared for, whatever venue the request names (venue-router.ts submit).
  app.post('/api/v1/venue/submit', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    const b = bodyOr<{ actionKey?: string; signature?: VenueSignature; requestDeadline?: string | null }>(req, reply);
    if (!b) return;
    return answer(
      reply,
      async (_d, r) => {
        const header = idempotencyHeader(req);
        let key = b.actionKey ?? '';
        if (header !== undefined) {
          const fromHeader = orderKeyOfIdempotencyKey(header);
          if (key !== '' && key !== fromHeader) throw new VenueWireError('with an Idempotency-Key, leave actionKey out');
          key = fromHeader;
        }
        return r.submitRequest(principal, {
          actionKey: key,
          signature: b.signature as VenueSignature,
          requestDeadline: b.requestDeadline ?? null,
        });
      },
      null,
      (v) => (v as { replayed?: boolean }).replayed === true,
    );
  });

  app.get<{ Querystring: Query }>('/api/v1/venue/orders', privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (d) => d.orders(principal, req.query.owner ?? '', req.query.cursor, req.query.limit), req.query.venueId);
  });

  // J-cex-spot-06 #1 #7; J-derivatives-04 #1 #2: the account's order history as the venue keeps it, filtered and paged; #10: our record of one order.
  app.get<{ Querystring: Query & Record<string, string | undefined> }>('/api/v1/venue/orders/history', privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(
      reply,
      async (d) => d.orderHistory(principal, await d.account(req.query.owner ?? '', req.query.subAccount ?? null), req.query),
      req.query.venueId,
    );
  });
  app.get<{ Querystring: Query }>('/api/v1/venue/orders/record', privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(
      reply,
      async (d) =>
        d.orderRecord(principal, await d.account(req.query.owner ?? '', req.query.subAccount ?? null), req.query.clientOrderId ?? ''),
      req.query.venueId,
    );
  });

  // Read on the venue the order was prepared for (venue-router.ts doorOfAction).
  app.get<{ Querystring: Query }>('/api/v1/venue/orders/by-key', privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (_d, r) => {
      const { idempotencyKey, actionKey } = req.query;
      if ((idempotencyKey === undefined) === (actionKey === undefined)) {
        throw new VenueWireError('give exactly one of idempotencyKey (the header you sent) or actionKey');
      }
      const key = idempotencyKey !== undefined ? orderKeyOfIdempotencyKey(idempotencyKey) : actionKey!;
      return (await r.doorOfAction(principal, key)).orderByKey(principal, key);
    });
  });
}
