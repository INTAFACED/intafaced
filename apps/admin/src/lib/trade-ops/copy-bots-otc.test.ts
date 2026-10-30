import { describe, expect, it } from 'vitest';
import { errorParts } from './edge';
import { metricText, parseCustomerLookup, parseFirstAccountId, parseOpsMetrics, parseQuoteDesk, windowText } from './copy-bots-otc';

const AT = '2026-10-29T10:00:00.000Z';
const metric = (value: number | null, unavailable: string | null = null) => ({ value, unavailable });
const metrics = {
  asOf: AT,
  window: { seconds: 86_400, from: '2026-10-28T10:00:00.000Z', to: AT },
  activeCopiers: metric(4),
  activeBots: metric(2),
  rfqsRequested: metric(null, 'trade.ops_metric_unavailable'),
  rfqsSettled: metric(0),
};
const quote = {
  quoteId: 'q1',
  userId: 'u1',
  lifecycle: 'bound',
  side: 'buy',
  pair: 'BTC/USDT',
  qty: '0.02',
  createdAt: AT,
  settledAt: null,
};

describe('copy, bots and OTC parsers', () => {
  it('reads the module metrics; a failed source stays null with its code and shows "Could not load", never 0', () => {
    const parsed = parseOpsMetrics(metrics);
    expect(parsed?.activeCopiers.value).toBe(4);
    expect(metricText(parsed!.activeCopiers)).toBe('4');
    expect(parsed?.rfqsRequested).toEqual({ value: null, unavailable: 'trade.ops_metric_unavailable' });
    expect(metricText(parsed!.rfqsRequested)).toBe('Could not load');
    expect(metricText(parsed!.rfqsSettled)).toBe('0');
  });

  it('refuses a metrics body that is not that shape', () => {
    expect(parseOpsMetrics({ ...metrics, activeCopiers: metric(null) })).toBeNull();
    expect(parseOpsMetrics({ ...metrics, activeBots: metric(-1) })).toBeNull();
    expect(parseOpsMetrics({ ...metrics, activeBots: { value: '2', unavailable: null } })).toBeNull();
    expect(parseOpsMetrics({ ...metrics, window: null })).toBeNull();
  });

  it('reads a lookup and refuses a row missing a field', () => {
    const body = {
      userId: 'u1',
      readAt: AT,
      follows: [{ followId: 'f1', leader: 'L', state: 'Active', startedAt: AT }],
      bots: [{ botId: 'b1', kind: 'twap', symbol: 'BTC/USDT', side: 'buy', status: 'active', createdAt: AT }],
      quotes: [quote],
    };
    expect(parseCustomerLookup(body)?.follows[0]?.state).toBe('Active');
    expect(parseCustomerLookup({ ...body, bots: [{ botId: 'b1' }] })).toBeNull();
  });

  it('reads the quote desk with its exceptions', () => {
    const exception = {
      quoteId: 'q1',
      userId: 'u1',
      sagaKey: 'otc.settle:q1',
      reason: 'not_settled_by_deadline',
      acceptedAt: AT,
      deadline: AT,
    };
    expect(parseQuoteDesk({ asOf: AT, quotes: [quote], exceptions: [exception] })?.exceptions[0]?.sagaKey).toBe('otc.settle:q1');
    expect(parseQuoteDesk({ asOf: AT, quotes: [{ ...quote, settledAt: 1 }], exceptions: [] })).toBeNull();
  });

  it('takes the first account of an email search, says when none matched, and refuses another shape', () => {
    expect(parseFirstAccountId({ rows: [{ id: 'a1' }, { id: 'a2' }] })).toEqual({ id: 'a1' });
    expect(parseFirstAccountId({ rows: [] })).toEqual({ id: null });
    expect(parseFirstAccountId({ rows: [{}] })).toBeNull();
    expect(parseFirstAccountId({})).toBeNull();
  });

  it('says a window in words', () => {
    expect(windowText(86_400)).toBe('1 day');
    expect(windowText(7_200)).toBe('2 hours');
    expect(windowText(90)).toBe('90 seconds');
  });

  it('carries the service code of a tRPC refusal, not only its class', () => {
    const body = { error: { json: { message: 'no', data: { code: 'FORBIDDEN', intafacedCode: 'scope.denied' } } } };
    expect(errorParts(body, 403).code).toBe('scope.denied');
    const cause = { error: { json: { message: 'no', data: { code: 'BAD_REQUEST', cause: { code: 'trade.otc_desk_law_unset' } } } } };
    expect(errorParts(cause, 400).code).toBe('trade.otc_desk_law_unset');
  });
});
