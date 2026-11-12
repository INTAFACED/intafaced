/**
 * The user-venue door's REST routes (B1; src/venue/user-venue-door.ts), for the signed-in customer:
 *
 *   GET  /api/v1/venue/status                          `{ enabled: false }` when the door is off; else the venue, TEST label, chain id
 *   GET  /api/v1/venue/markets                         the markets we list, each with `listing` (ours) beside the venue's own status
 *   GET  /api/v1/venue/gated-list                      each perpetual open or blocked for this account, every reason (J-derivatives-01 #2)
 *   GET  /api/v1/venue/best-prices?symbol=BTC-USDC         the venue's best bid and ask (a market order's worst price)
 *   GET  /api/v1/venue/balances?owner=0x…              (and orders/open, positions, agents, builder-fee-approval)
 *   GET  /api/v1/venue/orders/by-client-id?owner=&clientOrderId=
 *   GET  /api/v1/venue/fills?owner=&since=<ISO>
 *   GET  /api/v1/venue/withdrawals/:nonce?owner=
 *   GET  /api/v1/venue/deposits?owner=                 the on-chain deposits the venue has seen: confirming, credited or not (J-dex-protocol-05 #2)
 *   GET  /api/v1/venue/leverage?owner=&symbol=
 *   POST /api/v1/venue/preview   { owner, intent }
 *   POST /api/v1/venue/convert/sell-quote   { owner, symbol, amount, quoteKey }   the venue's price for a sell (J-cex-spot-17 #8)
 *   POST /api/v1/venue/prepare   { owner, signer, intent, actionKey?, stepUpApprovalId? }
 *   POST /api/v1/venue/submit    { actionKey, signature }    sent on the venue the action was prepared for
 *   GET  /api/v1/venue/markets/:symbol/venues?owner=&side=   every configured venue for the market (J-derivatives-28 #1)
 *   POST /api/v1/venue/route-preview { owner, intent }       the venue chosen for the order, and why (#2, #4)
 *   GET  /api/v1/venue/orders?owner=&cursor=&limit=      this person's orders on the account, oldest first, a page at a time
 *   GET  /api/v1/venue/orders/by-key?idempotencyKey=|actionKey=   one order by its key: accepted, unknown, refused, not_sent
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
 * routes do). Every Amount travels as a decimal string (`encodeVenueWire`). A venue refusal answers 422 with
 * `intafacedCode: trade.venue.<code>` and the venue's `refusal` (503 for `venue_down`); a step-up refusal 403.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { StepUpCheckError } from '@intafaced/contracts';
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
} from '@intafaced/venue-contracts';
import { toCcxtError } from '../ccxt-errors.js';
import { privateRead, privateWrite } from '../route-inventory.js';
import { UserVenueDoor, UserVenueDoorError, orderKeyOfIdempotencyKey } from './user-venue-door.js';
import type { UserVenueRouter } from './venue-router.js';
import { SessionKeys } from './session-key.js';
import { presentVenueSellQuote, type VenueSellQuotes } from './venue-sell-quotes.js';

export interface UserVenueRestDeps {
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null;
  requireTradeJurisdiction: (req: FastifyRequest, reply: FastifyReply, principal: Principal) => boolean;
  /** The region and level gate's reason for this caller, or null when it may trade (the gated list reads it as a reason). */
  tradeAccessBlocker?: (req: FastifyRequest, principal: Principal) => { code: string; message: string } | null;
  /**
   * The owner's market price protection in basis points (TRADE_MARKET_SLIPPAGE_CAP_BPS), or null when blank, as
   * `best-prices` answers it beside the venue's book, so a desk can bound a venue market order's worst price by it. Never
   * a default: blank answers `{ known: false }`.
   */
  slippageCapBps?: number | null;
  /** Convert's sell quotes priced by the venue (J-cex-spot-17 #8); absent, the route answers the door's own refusal. */
  sellQuotes?: VenueSellQuotes | null;
}

type Query = {
  owner?: string;
  subAccount?: string;
  clientOrderId?: string;
  since?: string;
  symbol?: string;
  cursor?: string;
  limit?: string;
  idempotencyKey?: string;
  actionKey?: string;
  venueId?: string;
  side?: string;
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
  function admit(req: FastifyRequest, reply: FastifyReply, scope: Scope): Principal | null {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return null;
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
    if (!admit(req, reply, 'trade:read')) return;
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
    return answer(reply, async (d) => d.gatedList(account), req.query.venueId);
  });

  // J-derivatives-28 #1: every configured venue for one market, with its own price, depth and fees, our builder fee,
  // whether the person can sign there, and its health. A down venue is a row with since when and why.
  app.get<{ Params: { symbol: string }; Querystring: Query }>('/api/v1/venue/markets/:symbol/venues', privateRead, async (req, reply) => {
    if (!admit(req, reply, 'trade:read')) return;
    const side = req.query.side === 'sell' ? 'sell' : 'buy';
    return answer(reply, async (_d, r) => r.marketVenues(req.query.owner ?? null, req.params.symbol, side));
  });

  // J-derivatives-28 #2 and #4: which venue this order goes to, its expected fill and fees, and why.
  app.post('/api/v1/venue/route-preview', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (_d, r) => {
      const b = body<{ owner?: string; intent?: VenueIntent }>(req);
      return r.routePreview(principal, b.owner ?? '', b.intent as never);
    });
  });

  app.get<{ Querystring: Query }>('/api/v1/venue/best-prices', privateRead, async (req, reply) => {
    if (!admit(req, reply, 'trade:read')) return;
    return answer(reply, async (d) => {
      if (!req.query.symbol) throw new VenueWireError('symbol is required');
      const venue = await d.venue();
      if (!venue.bestPrices)
        throw new VenueRefusalError({ venueId: venue.venue.id, code: 'not_offered', detail: 'this venue publishes no book' });
      const best = await venue.bestPrices(req.query.symbol);
      const cap = deps.slippageCapBps ?? null;
      return { ...best, slippageCapBps: cap === null ? { known: false } : { known: true, value: String(cap) } };
    });
  });

  type Account = Awaited<ReturnType<UserVenueDoor['account']>>;
  // The venue's account reads, by path. Registered in one literal loop so the published route list can see every one
  // (apps/customer developers-reference.test.ts reads `for (const path of [...])`).
  const accountReads: Record<string, (d: UserVenueDoor, q: Query, a: Account) => Promise<unknown>> = {
    // b2 change 6: every figure the person sees of their venue money is the venue's, with its own time and a state.
    '/api/v1/venue/balances': async (d, _q, a) => {
      const venue = await d.venue();
      const read = await venue.balances(a);
      return { ...read, figures: venueBalanceFigures(venue.venue, read, new Date()) };
    },
    '/api/v1/venue/orders/open': async (d, _q, a) => (await d.venue()).openOrders(a),
    '/api/v1/venue/positions': async (d, _q, a) => {
      const venue = await d.venue();
      const read = await venue.positions(a);
      return { ...read, figures: venuePositionFigures(venue.venue, read, new Date()) };
    },
    '/api/v1/venue/agents': async (d, _q, a) => (await d.venue()).agents(a),
    // The owner's sub-accounts, read on the main account (J-agents-08 #2: the accounts a person may give their agent).
    '/api/v1/venue/sub-accounts': async (d, _q, a) => {
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
    '/api/v1/venue/orders/by-client-id': async (d, q, a) => {
      if (!q.clientOrderId) throw new VenueWireError('clientOrderId is required');
      return (await d.venue()).orderByClientId(a, q.clientOrderId);
    },
    '/api/v1/venue/fills': async (d, q, a) => {
      const since = new Date(q.since ?? '');
      if (Number.isNaN(since.getTime())) throw new VenueWireError('since is required (an ISO time)');
      return (await d.venue()).fills(a, since);
    },
    // J-dex-protocol-05 #2: the venue's own list of the deposits it has seen; a venue that publishes none refuses not_offered.
    '/api/v1/venue/deposits': async (d, _q, a) => {
      const venue = await d.venue();
      if (!venue.deposits)
        throw new VenueRefusalError({ venueId: venue.venue.id, code: 'not_offered', detail: 'this venue publishes no deposit list' });
      return venue.deposits(a);
    },
    '/api/v1/venue/leverage': async (d, q, a) => {
      if (!q.symbol) throw new VenueWireError('symbol is required');
      return (await d.venue()).leverage(a, q.symbol);
    },
    // J-derivatives-27 #7: the person's balance in the margin account a market's deployer keeps for it, on the main
    // account; a venue that reads none refuses not_offered.
    '/api/v1/venue/market-margin': async (d, q, a) => {
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
    '/api/v1/venue/settlements': async (d, q, a) => {
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
    '/api/v1/venue/builder-fee-approval': async (d, _q, a) => {
      const status = await d.status();
      const builder = 'builder' in status ? status.builder : null;
      if (!builder)
        throw new VenueRefusalError({
          venueId: a.venueId,
          code: 'builder_fee_not_published',
          detail: 'our builder is not published (owner value blank)',
        });
      return (await d.venue()).builderFeeApproval(a, builder.address);
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
    '/api/v1/venue/leverage',
    '/api/v1/venue/market-margin',
    '/api/v1/venue/settlements',
    '/api/v1/venue/builder-fee-approval',
  ]) {
    const read = accountReads[path]!;
    app.get<{ Querystring: Query }>(path, privateRead, async (req, reply) => {
      if (!admit(req, reply, 'trade:read')) return;
      return answer(
        reply,
        async (d) => read(d, req.query, await d.account(req.query.owner ?? '', req.query.subAccount ?? null)),
        req.query.venueId,
      );
    });
  }

  app.get<{ Params: { nonce: string }; Querystring: Query }>('/api/v1/venue/withdrawals/:nonce', privateRead, async (req, reply) => {
    if (!admit(req, reply, 'trade:read')) return;
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

  app.post('/api/v1/venue/preview', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    const b = bodyOr<{ owner?: string; intent?: VenueIntent; venueId?: string | null }>(req, reply);
    if (!b) return;
    return answer(reply, async (d) => d.preview(principal, b.owner ?? '', b.intent as VenueIntent), b.venueId);
  });

  // A Convert sell priced by the venue's own preview on the customer's account, stored under its business key. Sends
  // nothing to the venue and moves no money; a trade:write scope, as the preview it is made from.
  app.post('/api/v1/venue/convert/sell-quote', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
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

  app.post('/api/v1/venue/prepare', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    const b = bodyOr<{
      owner?: string;
      subAccount?: string | null;
      signer?: VenueSigner;
      intent?: VenueIntent;
      actionKey?: string | null;
      stepUpApprovalId?: string | null;
      venueId?: string | null;
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
    const principal = admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(
      reply,
      session((s) => s.status(principal, req.query.owner ?? '')),
    );
  });

  app.post('/api/v1/venue/session/start', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
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
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(
      reply,
      session((s) => s.end(principal, body<{ owner?: string }>(req).owner ?? '')),
    );
  });

  // Sent on the venue the stored action was prepared for, whatever venue the request names (venue-router.ts submit).
  app.post('/api/v1/venue/submit', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    const b = bodyOr<{ actionKey?: string; signature?: VenueSignature }>(req, reply);
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
        return r.submit(principal, key, b.signature as VenueSignature);
      },
      null,
      (v) => (v as { replayed?: boolean }).replayed === true,
    );
  });

  app.get<{ Querystring: Query }>('/api/v1/venue/orders', privateRead, async (req, reply) => {
    const principal = admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (d) => d.orders(principal, req.query.owner ?? '', req.query.cursor, req.query.limit), req.query.venueId);
  });

  // Read on the venue the order was prepared for (venue-router.ts doorOfAction).
  app.get<{ Querystring: Query }>('/api/v1/venue/orders/by-key', privateRead, async (req, reply) => {
    const principal = admit(req, reply, 'trade:read');
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
