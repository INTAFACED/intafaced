import { describe, expect, it } from 'vitest';
import {
  SUPPORT_TRADE_SUMMARY_CALLERS,
  SUPPORT_TRADE_SUMMARY_ERROR_CODES,
  SUPPORT_TRADE_SUMMARY_LIMIT_MAX,
  SUPPORT_TRADE_SUMMARY_PROCEDURE,
  supportTradeLiquidationSchema,
  supportTradeOrderSchema,
  supportTradePositionSchema,
  supportTradeSummaryErrorCodeSchema,
  supportTradeSummaryInputSchema,
  supportTradeSummaryMatches,
  supportTradeSummarySchema,
  type SupportTradeSummary,
} from './support-trade-summary.js';
import { SERVICE_NAMES } from './service-keys.js';
import * as root from './index.js';

const USER = '11111111-1111-4111-8111-111111111111';
const CASE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const AUDIT = '44444444-4444-4444-8444-444444444444';
const RUNG = '55555555-5555-4555-8555-555555555555';
const AT = '2026-10-20T10:00:00.000Z';

const position = {
  positionId: '66666666-6666-4666-8666-666666666666',
  symbol: 'BTC/USDT-PERP',
  side: 'long' as const,
  status: 'open' as const,
  closingReason: null,
  contracts: '0.5',
  entryPrice: '60000',
  liquidationPrice: '31000.25',
  marginMode: 'isolated' as const,
  marginAsset: 'USDT',
  collateral: '2900.5',
  initialMargin: '3000',
  maintenanceMargin: null,
  leverage: '10',
  openedAt: AT,
  closedAt: null,
  fieldReasons: { maintenanceMargin: 'mark_missing' },
};

const rung = {
  rungId: RUNG,
  positionId: position.positionId,
  kind: 'partial' as const,
  state: 'applied' as const,
  startedAt: AT,
  updatedAt: AT,
};

const order = {
  orderId: '77777777-7777-4777-8777-777777777777',
  symbol: 'BTC/USDT-PERP',
  side: 'buy' as const,
  type: 'limit' as const,
  status: 'rejected' as const,
  qty: '0.5',
  filledQty: '0',
  limitPrice: '59000',
  rejectCode: 'post_only_would_cross',
  recoveryRequired: false,
  createdAt: AT,
};

function summary(): SupportTradeSummary {
  return {
    userId: USER,
    caseId: CASE,
    agentId: AGENT,
    auditId: AUDIT,
    readAt: AT,
    limit: 20,
    positions: { items: [position], truncated: false },
    liquidations: { items: [rung], truncated: false },
    orders: { items: [order], truncated: true },
  };
}

describe('support trade summary: input', () => {
  const valid = { userId: USER, caseId: CASE, agentId: AGENT, limit: 20 };

  it('round-trips and keeps the three ids', () => {
    expect(supportTradeSummaryInputSchema.parse(valid)).toEqual(valid);
  });

  it('refuses a call with no case id, no agent id or no customer', () => {
    for (const key of ['caseId', 'agentId', 'userId'] as const) {
      const { [key]: _omitted, ...rest } = valid;
      expect(supportTradeSummaryInputSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('refuses an id that is not a uuid, including an empty case id', () => {
    expect(supportTradeSummaryInputSchema.safeParse({ ...valid, caseId: '' }).success).toBe(false);
    expect(supportTradeSummaryInputSchema.safeParse({ ...valid, caseId: 'case-1' }).success).toBe(false);
    expect(supportTradeSummaryInputSchema.safeParse({ ...valid, agentId: 'agent' }).success).toBe(false);
  });

  it('lets limit be omitted so the service can name the refusal, and bounds it when given', () => {
    const { limit: _limit, ...noLimit } = valid;
    expect(supportTradeSummaryInputSchema.safeParse(noLimit).success).toBe(true);
    expect(supportTradeSummaryInputSchema.safeParse({ ...valid, limit: 0 }).success).toBe(false);
    expect(supportTradeSummaryInputSchema.safeParse({ ...valid, limit: 1.5 }).success).toBe(false);
    expect(supportTradeSummaryInputSchema.safeParse({ ...valid, limit: SUPPORT_TRADE_SUMMARY_LIMIT_MAX + 1 }).success).toBe(false);
    expect(supportTradeSummaryInputSchema.safeParse({ ...valid, limit: SUPPORT_TRADE_SUMMARY_LIMIT_MAX }).success).toBe(true);
  });

  it('refuses a field that is not named, so no write instruction rides along', () => {
    expect(supportTradeSummaryInputSchema.safeParse({ ...valid, action: 'close' }).success).toBe(false);
  });
});

describe('support trade summary: output', () => {
  it('round-trips', () => {
    expect(supportTradeSummarySchema.parse(summary())).toEqual(summary());
  });

  it('accepts a position whose unrecorded figures are null, and a position with no field reasons', () => {
    const bare = { ...position, liquidationPrice: null, collateral: null, initialMargin: null, leverage: null, marginMode: null };
    delete (bare as { fieldReasons?: unknown }).fieldReasons;
    expect(supportTradePositionSchema.safeParse(bare).success).toBe(true);
  });

  it('accepts empty lists, so a customer with no trades is an empty summary and not an error', () => {
    const empty = {
      ...summary(),
      positions: { items: [], truncated: false },
      liquidations: { items: [], truncated: false },
      orders: { items: [], truncated: false },
    };
    expect(supportTradeSummarySchema.safeParse(empty).success).toBe(true);
  });

  it('refuses a JS number for every money field', () => {
    const numbers: [string, unknown][] = [
      ['contracts', { ...position, contracts: 0.5 }],
      ['entryPrice', { ...position, entryPrice: 60000 }],
      ['liquidationPrice', { ...position, liquidationPrice: 31000.25 }],
      ['collateral', { ...position, collateral: 2900.5 }],
      ['initialMargin', { ...position, initialMargin: 3000 }],
      ['maintenanceMargin', { ...position, maintenanceMargin: 1 }],
      ['leverage', { ...position, leverage: 10 }],
    ];
    for (const [name, value] of numbers) {
      expect(supportTradePositionSchema.safeParse(value).success, name).toBe(false);
    }
    for (const field of ['qty', 'filledQty', 'limitPrice'] as const) {
      expect(supportTradeOrderSchema.safeParse({ ...order, [field]: 1 }).success, field).toBe(false);
    }
    expect(
      supportTradeSummarySchema.safeParse({ ...summary(), positions: { items: [{ ...position, contracts: 1 }], truncated: false } })
        .success,
    ).toBe(false);
  });

  it('refuses a decimal string that is signed, in exponent form, empty or over 18 places', () => {
    for (const bad of ['-1', '1e3', '', ' 1', '1.', '.5', '1.1234567890123456789', 'NaN']) {
      expect(supportTradePositionSchema.safeParse({ ...position, entryPrice: bad }).success, bad).toBe(false);
    }
  });

  it('refuses an answer with a missing case id, agent id or audit id', () => {
    for (const key of ['caseId', 'agentId', 'userId', 'auditId'] as const) {
      const { [key]: _omitted, ...rest } = summary();
      expect(supportTradeSummarySchema.safeParse(rest).success, key).toBe(false);
    }
  });

  it('refuses a list with no truncated flag, so a cut list cannot pass as the whole history', () => {
    const { truncated: _t, ...noFlag } = summary().orders;
    expect(supportTradeSummarySchema.safeParse({ ...summary(), orders: noFlag }).success).toBe(false);
  });

  it('carries no insurance, ledger or fee field: an unnamed field fails the parse', () => {
    expect(supportTradeLiquidationSchema.safeParse({ ...rung, insuranceAmount: '10' }).success).toBe(false);
    expect(supportTradeLiquidationSchema.safeParse({ ...rung, fromInsurance: '10' }).success).toBe(false);
    expect(supportTradePositionSchema.safeParse({ ...position, realizedPnl: '1' }).success).toBe(false);
    expect(supportTradeOrderSchema.safeParse({ ...order, fee: { cost: '1', currency: 'USDT' } }).success).toBe(false);
    expect(supportTradeSummarySchema.safeParse({ ...summary(), insuranceFund: '1' }).success).toBe(false);
  });

  it('bounds the rung vocabulary to the stored states', () => {
    for (const state of ['planned', 'posted', 'applied', 'abandoned', 'resolved']) {
      expect(supportTradeLiquidationSchema.safeParse({ ...rung, state }).success, state).toBe(true);
    }
    expect(supportTradeLiquidationSchema.safeParse({ ...rung, state: 'done' }).success).toBe(false);
  });

  it('keeps an unresolved order distinguishable from a plain open one', () => {
    expect(supportTradeOrderSchema.parse({ ...order, status: 'open', rejectCode: null, recoveryRequired: true }).recoveryRequired).toBe(
      true,
    );
    const { recoveryRequired: _r, ...missing } = order;
    expect(supportTradeOrderSchema.safeParse(missing).success).toBe(false);
  });
});

describe('support trade summary: binding to the request', () => {
  it('accepts the answer for the customer, case and agent that were asked about', () => {
    expect(supportTradeSummaryMatches({ userId: USER, caseId: CASE, agentId: AGENT }, summary())).toBe(true);
  });

  it('refuses an answer for another customer, case or agent', () => {
    const other = '99999999-9999-4999-8999-999999999999';
    const ask = { userId: USER, caseId: CASE, agentId: AGENT };
    expect(supportTradeSummaryMatches(ask, { ...summary(), userId: other })).toBe(false);
    expect(supportTradeSummaryMatches(ask, { ...summary(), caseId: other })).toBe(false);
    expect(supportTradeSummaryMatches(ask, { ...summary(), agentId: other })).toBe(false);
  });
});

describe('support trade summary: door and refusals', () => {
  it('is one query path, callable only by svc-support', () => {
    expect(SUPPORT_TRADE_SUMMARY_PROCEDURE).toBe('support.tradeSummary');
    expect(SUPPORT_TRADE_SUMMARY_CALLERS).toEqual(['svc-support']);
    for (const caller of SUPPORT_TRADE_SUMMARY_CALLERS) expect(SERVICE_NAMES).toContain(caller);
  });

  it('declares the typed refusals, with the existing scope.denied code for a missing case', () => {
    expect(SUPPORT_TRADE_SUMMARY_ERROR_CODES).toEqual([
      'scope.denied',
      'trade.support_summary_limit_unset',
      'trade.support_summary_unavailable',
      'trade.support_summary_audit_unavailable',
    ]);
    expect(supportTradeSummaryErrorCodeSchema.safeParse('scope.denied').success).toBe(true);
    expect(supportTradeSummaryErrorCodeSchema.safeParse('ok').success).toBe(false);
  });

  it('is exported from the package root', () => {
    expect(root.supportTradeSummarySchema).toBe(supportTradeSummarySchema);
    expect(root.SUPPORT_TRADE_SUMMARY_PROCEDURE).toBe(SUPPORT_TRADE_SUMMARY_PROCEDURE);
  });
});
