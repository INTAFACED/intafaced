import { describe, expect, it } from 'vitest';
import { AuthError, type AuthErrorCode } from '@intafaced/auth';
import { EXCHANGE_ERROR_CODES, exchangeErrorSchema } from '@intafaced/exchange-contract';
import { InsufficientFundsError, InvalidEntryError, LedgerError, MoneyError } from '@intafaced/ledger-client';
import {
  CCXT_AUTH_MAPPING,
  CCXT_ERROR_MAPPING,
  UNAUTHENTICATED,
  badRequest,
  badSymbol,
  invalidOrder,
  notSupported,
  permissionDenied,
  rateLimited,
  toCcxtError,
} from './ccxt-errors.js';
import { POSTING_FROZEN, SETTLEMENT_PENDING, refusedBeforeEngine } from './ledger-public-code.js';
import { MatchingNoBookError, MatchingUnavailableError } from './spot/matching-client.js';
import { TradeError, type TradeErrorCode } from './spot/types.js';

/**
 * The taxonomy is the contract. These tests assert the properties an integrator
 * actually depends on, not merely that a lookup table has entries:
 *
 *   - every arm is a real CCXT class,
 *   - the class and the HTTP status agree about whether to retry,
 *   - the codes a bot must NEVER retry never arrive as 5xx,
 *   - our internal code survives alongside for support and logs.
 */

const ALL_TRADE_CODES = Object.keys(CCXT_ERROR_MAPPING) as TradeErrorCode[];

/** Classes that instruct a client to back off and try the same call again. */
const RETRYABLE = new Set(['ExchangeNotAvailable', 'OnMaintenance', 'RateLimitExceeded']);

describe('CCXT error taxonomy', () => {
  it('maps every TradeErrorCode to a code that exists in the CCXT taxonomy', () => {
    expect(ALL_TRADE_CODES.length).toBeGreaterThan(0);
    for (const code of ALL_TRADE_CODES) {
      expect(EXCHANGE_ERROR_CODES, code).toContain(CCXT_ERROR_MAPPING[code].ccxt);
    }
    for (const code of Object.keys(CCXT_AUTH_MAPPING) as AuthErrorCode[]) {
      expect(EXCHANGE_ERROR_CODES, code).toContain(CCXT_AUTH_MAPPING[code].ccxt);
    }
  });

  it('emits a body that validates against exchangeErrorSchema for every TradeErrorCode', () => {
    for (const code of ALL_TRADE_CODES) {
      const mapped = toCcxtError(new TradeError('boom', code));
      expect(mapped, code).not.toBeNull();
      const parsed = exchangeErrorSchema.safeParse(mapped!.body);
      expect(parsed.success, `${code} → ${JSON.stringify(mapped!.body)}`).toBe(true);
      // Our own code survives for support and dashboards.
      expect(mapped!.body.intafacedCode).toBe(code);
    }
  });

  /**
   * The single most consequential property here. A retryable class carried on a
   * 4xx that clients treat as permanent — or a permanent class on a 5xx that
   * transport wrappers retry blindly — makes the two disagree, and the client
   * follows whichever it read first.
   */
  it('keeps the CCXT class and the HTTP status agreeing about retry', () => {
    for (const code of ALL_TRADE_CODES) {
      const { ccxt, status } = CCXT_ERROR_MAPPING[code];
      if (RETRYABLE.has(ccxt)) {
        expect(status, `${code} is retryable and must not be a permanent 4xx`).toBeGreaterThanOrEqual(429);
      } else if (status >= 500 && status !== 501) {
        // A 5xx that is not a capability refusal is a genuine venue fault.
        expect(ccxt, `${code} answers ${status} so it must read as a venue fault`).toBe('ExchangeError');
      }
    }
  });

  it('never answers a non-retryable failure with a status that invites a retry loop', () => {
    // InsufficientFunds retried in a loop is a hot loop against a wall, and on
    // a venue that rate-limits, a ban.
    const funds = toCcxtError(new InsufficientFundsError('acct-1', 'USDT', '100', '5'));
    expect(funds!.body.code).toBe('InsufficientFunds');
    expect(funds!.status).toBe(400);
    expect(funds!.body.intafacedCode).toBe('ledger.insufficient_funds');
  });

  it('separates an unknown symbol from a temporarily closed one', () => {
    // Drop the symbol permanently.
    const unknown = toCcxtError(new TradeError('no market', 'trade.market_not_found'));
    expect(unknown!.body.code).toBe('BadSymbol');

    // Retry on Monday. A bot that treats an FX weekend as BadSymbol drops
    // EUR/USD every Saturday and never trades it again.
    const closed = toCcxtError(new TradeError('between sessions', 'trade.market_closed'));
    expect(closed!.body.code).toBe('ExchangeNotAvailable');
    expect(closed!.status).toBe(503);
    expect(unknown!.body.code).not.toBe(closed!.body.code);
  });

  it('reports the operator kill-switch as maintenance, not as a permission problem', () => {
    const mapped = toCcxtError(new TradeError('killed', 'trade.spot_disabled'));
    expect(mapped!.body.code).toBe('OnMaintenance');
    expect(mapped!.status).toBe(503);
  });

  it('separates a bad credential from a valid credential with too few scopes', () => {
    const expired = toCcxtError(new AuthError('expired', 'token.expired'));
    expect(expired!.body.code).toBe('AuthenticationError');
    expect(expired!.status).toBe(401);

    const scope = toCcxtError(new AuthError('needs trade:write', 'scope.denied'));
    expect(scope!.body.code).toBe('PermissionDenied');
    expect(scope!.status).toBe(403);
  });

  it('maps an unreachable engine to a retryable ExchangeNotAvailable', () => {
    const mapped = toCcxtError(new MatchingUnavailableError('svc-matching down'));
    expect(mapped!.body.code).toBe('ExchangeNotAvailable');
    expect(mapped!.status).toBe(502);
    expect(mapped!.body.intafacedCode).toBe('trade.matching_unavailable');
  });

  it('maps matching 404 MarketNotFound to 404 trade.no_book, not BadSymbol and not 502', () => {
    const mapped = toCcxtError(new MatchingNoBookError('m-1'));
    expect(mapped!.status).toBe(404);
    expect(mapped!.body.code).toBe('ExchangeError');
    expect(mapped!.body.intafacedCode).toBe('trade.no_book');
    expect(exchangeErrorSchema.safeParse(mapped!.body).success).toBe(true);
    const viaTrade = toCcxtError(new TradeError('matching holds no book', 'trade.no_book'));
    expect(viaTrade!.status).toBe(404);
    expect(viaTrade!.body.intafacedCode).toBe('trade.no_book');
  });

  /**
   * InsufficientFundsError extends LedgerError, so the order of the instanceof
   * checks decides whether "not enough funds" is reported as a generic ledger
   * fault. Getting this backwards is silent and total.
   */
  it('checks the ledger error subclass before its superclass', () => {
    expect(toCcxtError(new InsufficientFundsError('a', 'USDT', '1', '0'))!.body.code).toBe('InsufficientFunds');
    expect(toCcxtError(new InvalidEntryError('bad entry'))!.body.code).toBe('ExchangeError');
    expect(toCcxtError(new LedgerError('nope', 'ledger.other'))!.body.code).toBe('ExchangeError');
    expect(toCcxtError(new LedgerError('nope', 'ledger.other'))!.body.intafacedCode).toBe('ledger.other');
    expect(toCcxtError(new InvalidEntryError('bad entry'))!.body.intafacedCode).toBe('ledger.invalid_entry');
    expect(toCcxtError(new MoneyError('bad decimal'))!.body.code).toBe('BadRequest');
  });

  /**
   * The platform posting freeze (DV-errors-02, J-developer-04 #6). `posting_frozen` only where the order's first hold
   * was refused before the engine; any other freeze is an unknown outcome, never a refusal.
   */
  it('a freeze proven before the engine is posting_frozen, 400 OnMaintenance', () => {
    const mapped = toCcxtError(refusedBeforeEngine(new LedgerError('Ledger posting is frozen: TEST', 'ledger.frozen')));
    expect(mapped).toEqual({
      status: 400,
      body: { code: 'OnMaintenance', message: 'Ledger posting is frozen: TEST', intafacedCode: POSTING_FROZEN },
    });
    expect(POSTING_FROZEN).toBe('posting_frozen');
    expect(exchangeErrorSchema.safeParse(mapped!.body).success).toBe(true);
  });

  it('a freeze nobody proved was before the engine is trade.settlement_pending, 503: the order may exist', () => {
    const mapped = toCcxtError(new LedgerError('Ledger posting is frozen: TEST', 'ledger.frozen'));
    expect(mapped).toMatchObject({ status: 503, body: { code: 'ExchangeNotAvailable', intafacedCode: SETTLEMENT_PENDING } });
    expect(mapped!.body.intafacedCode).not.toBe(POSTING_FROZEN);
    expect(mapped!.body.message).toMatch(/settlement is not confirmed: read the order or trade before sending it again/);
    expect(exchangeErrorSchema.safeParse(mapped!.body).success).toBe(true);
    // Every other ledger refusal keeps its own code and its 400, marked or not.
    for (const err of [
      new LedgerError('x', 'ledger.idempotency_conflict'),
      refusedBeforeEngine(new LedgerError('x', 'ledger.idempotency_conflict')),
    ]) {
      expect(toCcxtError(err)).toMatchObject({
        status: 400,
        body: { code: 'ExchangeError', intafacedCode: 'ledger.idempotency_conflict' },
      });
    }
  });

  /**
   * An unrecognised throw is a bug. It must reach Fastify's handler as a 500
   * rather than be relabelled into something a client will retry forever.
   */
  it('returns null for an error it does not recognise, rather than guessing', () => {
    expect(toCcxtError(new Error('something unexpected'))).toBeNull();
    expect(toCcxtError('a string')).toBeNull();
    expect(toCcxtError(undefined)).toBeNull();
  });

  it('always carries retryAfter on RateLimitExceeded', () => {
    const mapped = rateLimited(2.1);
    expect(mapped.status).toBe(429);
    expect(mapped.body.code).toBe('RateLimitExceeded');
    // Rounded up and at least 1 — a throttler that reads 0 retries immediately.
    expect(mapped.body.retryAfter).toBe(3);
    expect(rateLimited(0).body.retryAfter).toBe(1);
    expect(exchangeErrorSchema.safeParse(mapped.body).success).toBe(true);
  });

  it('gives every constructed refusal a valid CCXT body', () => {
    const bodies = [
      UNAUTHENTICATED.body,
      badSymbol('NOPE/USDT').body,
      badRequest('bad since', 'trade.invalid_since').body,
      notSupported('no futures', 'trade.leverage_unsupported').body,
      permissionDenied('region blocked', 'geo.blocked').body,
      invalidOrder('a limit order requires a price').body,
      rateLimited(5).body,
    ];
    for (const body of bodies) {
      expect(exchangeErrorSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
    expect(UNAUTHENTICATED.status).toBe(401);
    expect(badSymbol('X').status).toBe(404);
    expect(notSupported('x', 'y').status).toBe(501);
    expect(notSupported('x', 'y').body.retryAfter).toBeUndefined();
    expect(invalidOrder('x').body.code).toBe('InvalidOrder');
  });

  it('never leaks a raw internal code as the CCXT class', () => {
    for (const code of ALL_TRADE_CODES) {
      const mapped = toCcxtError(new TradeError('boom', code))!;
      expect(mapped.body.code.startsWith('trade.')).toBe(false);
      expect(mapped.body.code.startsWith('ledger.')).toBe(false);
    }
  });
});
