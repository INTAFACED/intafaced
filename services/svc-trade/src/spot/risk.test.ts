import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import {
  assertMarketOpen,
  assertNotional,
  assertPrice,
  assertQty,
  assertSettlementRails,
  assertSpotSurface,
  assertTradable,
  holdFor,
  protectionPriceFor,
  sellProtectionPriceFor,
  requireSupportedType,
} from './risk.js';
import { TradeError, type Market } from './types.js';

/**
 * Risk checks, as pure arithmetic.
 *
 * These run before any value moves, which is the only reason step 3 of the
 * order flow can be trusted: by the time a hold is posted, the order is known
 * to be on the grid, inside the limits, and on a market that is actually open.
 */

const BTCUSDT: Market = {
  id: '00000000-0000-4000-8000-000000000001',
  symbol: 'BTC/USDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  kind: 'spot',
  tickSize: amt('0.01'),
  lotSize: amt('0.0001'),
  minQty: amt('0.0001'),
  maxQty: amt('100'),
  minNotional: amt('1'),
  status: 'active',
  makerBps: 10,
  takerBps: 20,
  listedAt: new Date(),
  assetClass: 'crypto',
  schedule: 'crypto-24x7',
  paper: false,
};

const withMarket = (overrides: Partial<Market>): Market => ({ ...BTCUSDT, ...overrides });

const EURUSD = withMarket({
  symbol: 'EUR/USD',
  baseAsset: 'EUR',
  quoteAsset: 'USD',
  assetClass: 'forex',
  schedule: 'fx-global',
});

const XAUUSD = withMarket({
  symbol: 'XAU/USD',
  baseAsset: 'XAU',
  quoteAsset: 'USD',
  assetClass: 'commodity',
  schedule: 'cme-globex',
});

describe('market status', () => {
  it('accepts an active spot market', () => {
    expect(() => assertTradable(BTCUSDT)).not.toThrow();
  });

  it('refuses a halted market — a hold behind a book nobody is matching is a trapped fund', () => {
    expect(() => assertTradable(withMarket({ status: 'halted' }))).toThrow(TradeError);
    expect(() => assertTradable(withMarket({ status: 'delisted' }))).toThrow(TradeError);
    expect(() => assertTradable(withMarket({ status: 'pending' }))).toThrow(TradeError);
  });

  /**
   * THE DEFAULT IS THE REFUSAL.
   *
   * `assertTradable(market)` with no second argument is the shape every call site
   * had before futures became orderable, and it must keep refusing — a permissive
   * reading that arrives by leaving an argument off is the failure mode the option
   * doc comment names. So this asserts the OLD behaviour survives the new
   * parameter, with the new code.
   */
  it('refuses a futures market by default — omitting the option must not grant it', () => {
    try {
      assertTradable(withMarket({ kind: 'futures' }));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.futures_disabled');
    }
  });

  it('refuses a futures market when the flag is explicitly off, and names the switch', () => {
    try {
      assertTradable(withMarket({ kind: 'futures', symbol: 'BTC/USDT-PERP' }), { futuresEnabled: false });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.futures_disabled');
      // Not `market_kind_unsupported`: that code tells a CCXT client to drop the
      // symbol, and an operator can turn this one on.
      expect((err as TradeError).code).not.toBe('trade.market_kind_unsupported');
      expect((err as Error).message).toContain('TRADE_FUTURES_ENABLED');
    }
  });

  it('accepts a futures market when the flag is on', () => {
    expect(() => assertTradable(withMarket({ kind: 'futures' }), { futuresEnabled: true })).not.toThrow();
  });

  it('refuses a dated futures market without expiry even when futures are on', () => {
    try {
      assertTradable(
        withMarket({
          kind: 'futures',
          symbol: 'BTC/USDT:USDT-251226',
          futuresContractStyle: 'dated',
          futuresExpiryAt: null,
          futuresSettlementFixing: 'owner-dated-fixing',
        }),
        { futuresEnabled: true },
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.dated_futures_expiry_required');
    }
  });

  it('refuses place on a dated futures market after expiry', () => {
    try {
      assertTradable(
        withMarket({
          kind: 'futures',
          symbol: 'BTC/USDT:USDT-251226',
          futuresContractStyle: 'dated',
          futuresExpiryAt: new Date('2026-12-26T08:00:00.000Z'),
          futuresSettlementFixing: 'owner-dated-fixing',
        }),
        { futuresEnabled: true, now: new Date('2026-12-26T08:00:01.000Z') },
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.dated_futures_expired');
    }
  });

  it('still refuses a HALTED futures market with the flag on — orderability is not a status override', () => {
    try {
      assertTradable(withMarket({ kind: 'futures', status: 'halted' }), { futuresEnabled: true });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.market_not_tradable');
    }
  });

  /**
   * Live options (paper=false) refuse. Empty settlement law →
   * trade.unsettled_asset_class_listing (never invent the asset). Law stamped
   * but live engine unpublished → market_kind_unsupported. Paper options are
   * the v1 engine.
   */
  it('refuses a live options market when settlement law is empty', () => {
    try {
      assertTradable(withMarket({ kind: 'options', paper: false }));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.unsettled_asset_class_listing');
    }
  });

  it('refuses a live options market even when settlement law is stamped — paper engine only', () => {
    try {
      assertTradable(withMarket({ kind: 'options', paper: false }), { optionsSettlementLawStamped: true });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.market_kind_unsupported');
    }
  });

  it('accepts a paper options market — European paper engine', () => {
    expect(() => assertTradable(withMarket({ kind: 'options', paper: true }))).not.toThrow();
  });
});

describe('spot-shaped surfaces refuse non-spot on their own account', () => {
  /**
   * Convert and TWAP used to be spot-only for free, by inheriting
   * `assertTradable`'s flat kind refusal. That refusal is now a deployment flag,
   * so an inherited guard would have turned both surfaces on for futures the
   * moment an operator enabled orderability — neither has been designed, priced
   * or tested against a futures market. These assertions are what stops that
   * happening silently.
   */
  it('refuses futures for convert regardless of the futures flag', () => {
    for (const surface of ['convert', 'TWAP']) {
      try {
        assertSpotSurface(withMarket({ kind: 'futures' }), surface);
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as TradeError).code).toBe('trade.market_kind_unsupported');
        expect((err as Error).message).toContain(`${surface} serves spot only`);
      }
    }
  });

  it('lets spot through', () => {
    expect(() => assertSpotSurface(BTCUSDT, 'convert')).not.toThrow();
  });

  it('refuses FX convert/TWAP — separate product, no invented mid', () => {
    for (const surface of ['convert', 'TWAP']) {
      try {
        assertSpotSurface(EURUSD, surface);
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as TradeError).code).toBe('trade.fx_not_spot');
        expect((err as Error).message).toMatch(/FX product/i);
      }
    }
  });
});

describe('order types', () => {
  it('accepts limit and market', () => {
    expect(requireSupportedType('limit')).toBe('limit');
    expect(requireSupportedType('market')).toBe('market');
  });

  it('refuses stops — funding one honestly is not solved (SOCKET §13)', () => {
    for (const type of ['stop', 'stop_limit', 'take_profit', 'nonsense']) {
      try {
        requireSupportedType(type);
        throw new Error(`should have refused ${type}`);
      } catch (err) {
        expect((err as TradeError).code).toBe('trade.order_type_unsupported');
      }
    }
  });
});

describe('size limits', () => {
  it('accepts a quantity on the lot grid and inside the bounds', () => {
    expect(() => assertQty(BTCUSDT, amt('1.5'))).not.toThrow();
    expect(() => assertQty(BTCUSDT, amt('0.0001'))).not.toThrow();
    expect(() => assertQty(BTCUSDT, amt('100'))).not.toThrow();
  });

  it('refuses an off-grid quantity — the engine matches on exact equality', () => {
    expect(() => assertQty(BTCUSDT, amt('1.00005'))).toThrow(TradeError);
  });

  it('refuses zero, below the floor, and above the ceiling', () => {
    expect(() => assertQty(BTCUSDT, amt('0'))).toThrow(TradeError);
    expect(() => assertQty(withMarket({ minQty: amt('0.01') }), amt('0.001'))).toThrow(TradeError);
    expect(() => assertQty(BTCUSDT, amt('100.0001'))).toThrow(TradeError);
  });

  it('allows an unbounded market to take any on-grid size', () => {
    expect(() => assertQty(withMarket({ maxQty: null }), amt('1000000'))).not.toThrow();
  });
});

describe('price grid', () => {
  it('accepts a price on the tick grid', () => {
    expect(() => assertPrice(BTCUSDT, amt('60000.25'))).not.toThrow();
  });

  it('refuses an off-grid price — it would rest at a level nobody can meet', () => {
    expect(() => assertPrice(BTCUSDT, amt('60000.255'))).toThrow(TradeError);
    expect(() => assertPrice(BTCUSDT, amt('0'))).toThrow(TradeError);
  });
});

describe('minimum notional', () => {
  it('accepts an order worth at least the floor', () => {
    expect(() => assertNotional(BTCUSDT, amt('100'), amt('0.01'))).not.toThrow();
  });

  it('refuses dust — a fill worth nothing is a fill the ledger will not post', () => {
    expect(() => assertNotional(BTCUSDT, amt('100'), amt('0.0001'))).toThrow(TradeError);
  });

  it('floors the value, matching how a fill is settled', () => {
    // 3 x 0.3333 = 0.99990 -> below a 1.0 floor even though it "rounds to" 1.
    expect(() => assertNotional(withMarket({ tickSize: amt('0.0001') }), amt('3'), amt('0.3333'))).toThrow(TradeError);
  });
});

describe('the hold', () => {
  it('holds QUOTE for a buy, rounded up', () => {
    const hold = holdFor(BTCUSDT, 'buy', amt('100'), amt('2'));
    expect(hold.assetId).toBe('USDT');
    expect(formatAmount(hold.amount)).toBe('200');
  });

  it('rounds a buy hold UP — a hold one wei short is a fill that cannot settle', () => {
    // 0.000000000000000001 x 3 needs a 19th decimal place it cannot have.
    const hold = holdFor(BTCUSDT, 'buy', amt('0.000000000000000001'), amt('0.3'));
    expect(formatAmount(hold.amount)).toBe('0.000000000000000001');
  });

  it('holds BASE for a sell, exactly the quantity', () => {
    const hold = holdFor(BTCUSDT, 'sell', amt('100'), amt('2.5'));
    expect(hold.assetId).toBe('BTC');
    expect(formatAmount(hold.amount)).toBe('2.5');
  });

  it('a sell hold does not depend on the price at all', () => {
    const cheap = holdFor(BTCUSDT, 'sell', amt('1'), amt('2.5'));
    const dear = holdFor(BTCUSDT, 'sell', amt('1000000'), amt('2.5'));
    expect(cheap.amount).toBe(dear.amount);
  });
});

describe('market buy protection price', () => {
  it('funds above the best ask by the slippage cap, on the tick grid', () => {
    // 100 + 150 bps = 101.5, already a multiple of 0.01.
    expect(formatAmount(protectionPriceFor(BTCUSDT, amt('100'), 150))).toBe('101.5');
  });

  it('rounds UP to the tick — rounding down would fund below the price submitted', () => {
    // 100.005 + 150 bps = 101.505075 -> 101.51 at a 0.01 tick.
    expect(formatAmount(protectionPriceFor(withMarket({ tickSize: amt('0.01') }), amt('100.005'), 150))).toBe('101.51');
  });

  it('is always at or above the best ask, so a marketable order can actually cross', () => {
    for (const ask of ['0.01', '1', '100', '65432.10']) {
      expect(protectionPriceFor(BTCUSDT, amt(ask), 150)).toBeGreaterThanOrEqual(amt(ask));
    }
  });

  it('refuses when there is no ask to price against, rather than guessing', () => {
    try {
      protectionPriceFor(BTCUSDT, null, 150);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.no_reference_price');
    }
  });

  it('refuses blank/unset/non-integer cap rather than inventing 200', () => {
    for (const cap of [null, undefined, Number.NaN, 1.5, 0, 5001]) {
      try {
        protectionPriceFor(BTCUSDT, amt('100'), cap);
        throw new Error(`should have thrown for ${String(cap)}`);
      } catch (err) {
        expect((err as TradeError).code).toBe('trade.slippage_cap_unset');
      }
    }
  });
});

describe('market sell protection floor', () => {
  it('floors under the best bid by the slippage cap, rounded up onto the tick', () => {
    // 100 - 150 bps = 98.5, already a multiple of 0.01.
    expect(formatAmount(sellProtectionPriceFor(BTCUSDT, amt('100'), 150))).toBe('98.5');
  });

  it('rounds UP to the tick so the floor is never worse than bid minus the cap', () => {
    // 99 - 150 bps = 97.515 -> 97.52 at a 0.01 tick.
    expect(formatAmount(sellProtectionPriceFor(withMarket({ tickSize: amt('0.01') }), amt('99'), 150))).toBe('97.52');
  });

  it('refuses an unpublished cap with trade.protection_unset', () => {
    for (const cap of [null, undefined, Number.NaN, 0, 5001]) {
      try {
        sellProtectionPriceFor(BTCUSDT, amt('100'), cap);
        throw new Error(`should have thrown for ${String(cap)}`);
      } catch (err) {
        expect((err as TradeError).code).toBe('trade.protection_unset');
      }
    }
  });

  it('refuses a missing bid with trade.no_reference_price', () => {
    try {
      sellProtectionPriceFor(BTCUSDT, null, 150);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.no_reference_price');
    }
  });
});

describe('venue hours', () => {
  /**
   * Nothing checked this before. A weekend forex order was accepted, funded and
   * rested into a book that could not fill it until Monday — the user's balance
   * held for two days against an order that was never live.
   *
   * `status` and the schedule are deliberately separate questions, so these
   * assert a market that is `active` throughout and still closed.
   */

  it('crypto is open at every instant, including the forex weekend', () => {
    // Saturday.
    expect(() => assertMarketOpen(BTCUSDT, new Date('2026-01-10T12:00:00Z'))).not.toThrow();
    // Sunday, before the forex open.
    expect(() => assertMarketOpen(BTCUSDT, new Date('2026-01-11T09:00:00Z'))).not.toThrow();
  });

  it('refuses a forex order on a Saturday', () => {
    expect(() => assertMarketOpen(EURUSD, new Date('2026-01-10T12:00:00Z'))).toThrow(TradeError);
    try {
      assertMarketOpen(EURUSD, new Date('2026-01-10T12:00:00Z'));
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.market_closed');
      expect((err as TradeError).message).toContain('EUR/USD');
    }
  });

  it('names unpublished FX holiday calendar mid-week (empty list is not open)', () => {
    // Wednesday noon UTC — inside the session windows, calendar still unpublished.
    try {
      assertMarketOpen(EURUSD, new Date('2026-01-14T12:00:00Z'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.fx_holiday_calendar_unpublished');
    }
  });

  /**
   * The forex week is defined by the 17:00 New York open and close, so the UTC
   * instant of both moves with US daylight saving. Asserting a fixed UTC hour
   * would pass in one half of the year and fail in the other, which is exactly
   * the bug this check exists to prevent.
   */
  it('tracks the New York boundary across daylight saving', () => {
    // January: New York is UTC-5, so 17:00 local Sunday is 22:00Z.
    try {
      assertMarketOpen(EURUSD, new Date('2026-01-11T21:59:00Z'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.market_closed');
    }
    try {
      assertMarketOpen(EURUSD, new Date('2026-01-11T22:01:00Z'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.fx_holiday_calendar_unpublished');
    }

    // July: New York is UTC-4, so the same local moment is 21:00Z.
    try {
      assertMarketOpen(EURUSD, new Date('2026-07-12T20:59:00Z'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.market_closed');
    }
    try {
      assertMarketOpen(EURUSD, new Date('2026-07-12T21:01:00Z'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.fx_holiday_calendar_unpublished');
    }
  });

  it('names when the session reopens, so the caller can say something useful', () => {
    try {
      assertMarketOpen(EURUSD, new Date('2026-01-10T12:00:00Z'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as TradeError).message).toMatch(/reopens at \d{4}-\d{2}-\d{2}T/);
    }
  });

  it('a halted market is refused by status, not by the clock', () => {
    // Both checks exist and neither substitutes for the other.
    expect(() => assertTradable(withMarket({ status: 'halted' }))).toThrow(TradeError);
    expect(() => assertMarketOpen(withMarket({ status: 'halted' }), new Date('2026-01-14T12:00:00Z'))).not.toThrow();
  });

  /**
   * The mirror of the case above, and the one that actually bites: a market that
   * is CLOSED but perfectly `active`. Neither check alone accepts this order and
   * only one of them is the reason.
   */
  it('an active market is still refused when the venue is shut', () => {
    expect(() => assertTradable(EURUSD)).not.toThrow();
    expect(() => assertMarketOpen(EURUSD, new Date('2026-01-10T12:00:00Z'))).toThrow(TradeError);
  });

  it('W4 U1: production forex/commodity without rails refuse before hold', () => {
    // EURUSD fixture is production-shaped (paper false) like migration seeds.
    expect(() => assertSettlementRails(EURUSD)).toThrow(TradeError);
    try {
      assertSettlementRails(EURUSD);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(TradeError);
      expect((e as TradeError).code).toBe('trade.unsettled_asset_class_listing');
      expect((e as TradeError).message).toContain('socket.forex-settlement');
    }
    expect(() => assertSettlementRails({ ...EURUSD, paper: true })).not.toThrow();
    expect(() => assertSettlementRails(BTCUSDT)).not.toThrow();
  });

  /**
   * A commodity closes DAILY, not only at the weekend, so the gap a forex-only
   * test leaves open is an hour wide every weekday — long enough to hold a
   * user's balance against a book in settlement.
   */
  it('refuses a commodity order during the daily settlement break', () => {
    // Wednesday 15:59 Chicago — inside the session.
    expect(() => assertMarketOpen(XAUUSD, new Date('2026-01-14T21:59:00Z'))).not.toThrow();
    // 16:01 and 16:59 Chicago — the 60-minute break.
    expect(() => assertMarketOpen(XAUUSD, new Date('2026-01-14T22:01:00Z'))).toThrow(TradeError);
    expect(() => assertMarketOpen(XAUUSD, new Date('2026-01-14T22:59:00Z'))).toThrow(TradeError);
    // 17:01 Chicago — reopened.
    expect(() => assertMarketOpen(XAUUSD, new Date('2026-01-14T23:01:00Z'))).not.toThrow();
  });

  it('refuses a commodity order on a Saturday', () => {
    expect(() => assertMarketOpen(XAUUSD, new Date('2026-01-10T12:00:00Z'))).toThrow(TradeError);
  });

  /**
   * Same DST trap as forex, on a different zone and a different boundary. The
   * break is 16:00 CHICAGO, so its UTC instant moves by an hour in March and
   * November — and Chicago does not shift on the same weekend as Europe.
   */
  it('tracks the Chicago settlement break across daylight saving', () => {
    // January: Chicago is UTC-6, so 16:00 local Wednesday is 22:00Z.
    expect(() => assertMarketOpen(XAUUSD, new Date('2026-01-14T21:59:00Z'))).not.toThrow();
    expect(() => assertMarketOpen(XAUUSD, new Date('2026-01-14T22:01:00Z'))).toThrow();

    // July: Chicago is UTC-5, so the same local moment is 21:00Z. Asserting the
    // January instant here would report the market open mid-break.
    expect(() => assertMarketOpen(XAUUSD, new Date('2026-07-15T20:59:00Z'))).not.toThrow();
    expect(() => assertMarketOpen(XAUUSD, new Date('2026-07-15T21:01:00Z'))).toThrow();
  });

  /**
   * THE FAIL-SAFE DIRECTION.
   *
   * `schedule` reaches this function as a bare cast of a Postgres enum value
   * (`rows.ts` — no runtime parse), so a migration that adds a schedule to the
   * database enum without adding it to `TRADING_SCHEDULES` puts an unknown key
   * on this path. For an hours check the safe answer is REFUSE: passing would
   * fund an order into a venue whose hours we cannot evaluate.
   *
   * It must also be a refusal rather than a crash. Reading `.kind` off the
   * missing lookup throws a TypeError, which reaches the caller as a 500 — and a
   * 500 is not something a client can act on, where `trade.unknown_schedule` is.
   * Distinct from `trade.market_closed` (session boundary — retry Monday).
   */
  it('refuses a schedule it does not recognise instead of failing open', () => {
    const drifted = withMarket({ schedule: 'lse-equities' as Market['schedule'] });

    expect(() => assertMarketOpen(drifted, new Date('2026-01-14T12:00:00Z'))).toThrow(TradeError);
    try {
      assertMarketOpen(drifted, new Date('2026-01-14T12:00:00Z'));
      expect.unreachable('an unknown schedule must not be accepted');
    } catch (err) {
      // A TradeError, not a TypeError — assert the type, not only that it threw.
      expect(err).toBeInstanceOf(TradeError);
      expect((err as TradeError).code).toBe('trade.unknown_schedule');
      expect((err as TradeError).message).toContain('lse-equities');
    }
  });

  /** Undefined and null arrive the same way from a row that predates the column. */
  it('refuses a missing schedule rather than reading through it', () => {
    for (const bad of [undefined, null, '']) {
      const market = withMarket({ schedule: bad as unknown as Market['schedule'] });
      expect(() => assertMarketOpen(market, new Date('2026-01-14T12:00:00Z'))).toThrow(TradeError);
    }
  });
});
