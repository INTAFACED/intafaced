import { describe, expect, it } from 'vitest';
import {
  parseInsuranceHistory,
  parseLiquidationDesk,
  parsePosition,
  parsePositionsPage,
  parseRiskCurrent,
  parseRiskHistory,
} from './desk-parse';

const position = {
  id: 'p1',
  userId: 'u1',
  marketId: 'm1',
  side: 'long',
  status: 'open',
  size: '1.5',
  entryPrice: '100.25',
  openedAt: '2026-10-20T08:00:00.000Z',
};

describe('positions', () => {
  it('reads a row and a page, keeping decimals as strings', () => {
    expect(parsePosition(position)).toEqual(position);
    expect(parsePositionsPage({ rows: [position], nextCursor: null })).toEqual({ rows: [position], nextCursor: null });
  });
  it('refuses a number where a decimal string is needed, and an unknown side', () => {
    expect(parsePosition({ ...position, size: 1.5 })).toBeNull();
    expect(parsePosition({ ...position, side: 'flat' })).toBeNull();
    expect(parsePositionsPage({ rows: [position, { id: 'x' }], nextCursor: null })).toBeNull();
  });
});

describe('risk limits', () => {
  const none = {
    marketId: 'm1',
    version: '0',
    collar: null,
    fatFinger: null,
    slippageCap: null,
    throttle: null,
    circuitBreaker: null,
    oiLimit: null,
    oiShareBps: null,
  };
  it('reads the never-set state as all null', () => expect(parseRiskCurrent(none)).toEqual(none));
  it('reads the open-interest pair, and a row from before it existed as unset', () => {
    expect(parseRiskCurrent({ ...none, oiLimit: '1000', oiShareBps: '500' })).toMatchObject({ oiLimit: '1000', oiShareBps: '500' });
    const { oiLimit: _l, oiShareBps: _s, ...older } = none;
    expect(parseRiskCurrent(older)).toEqual(none);
    expect(parseRiskCurrent({ ...none, oiShareBps: '2.5' })).toBeNull();
    expect(parseRiskCurrent({ ...none, oiLimit: 1000 })).toBeNull();
  });
  it('refuses a number, a negative and a decimal where an integer is needed', () => {
    expect(parseRiskCurrent({ ...none, slippageCap: 100 })).toBeNull();
    expect(parseRiskCurrent({ ...none, throttle: '-1' })).toBeNull();
    expect(parseRiskCurrent({ ...none, circuitBreaker: '1.5' })).toBeNull();
    expect(parseRiskCurrent({ ...none, version: 'x' })).toBeNull();
  });
  it('reads history rows with who changed it and who approved', () => {
    const row = {
      ...none,
      version: '1',
      collar: '0.05',
      operatorId: 'a',
      approverId: 'b',
      reason: 'why',
      approvalId: 'ap',
      createdAt: '2026-10-20T08:00:00.000Z',
    };
    expect(parseRiskHistory([row])).toEqual([row]);
    expect(parseRiskHistory([{ ...row, approverId: undefined }])).toBeNull();
    expect(parseRiskHistory({})).toBeNull();
  });
});

describe('liquidation desk', () => {
  const desk = {
    rungs: [
      {
        rungId: 'r1',
        positionId: 'p1',
        liquidationId: 'l1',
        kind: 'partial',
        state: 'planned',
        fromSize: '1',
        fromMargin: '10',
        fromInsurance: null,
        createdAt: 'a',
        updatedAt: 'b',
      },
    ],
    parked: ['p9'],
    nearThreshold: [
      {
        positionId: 'p1',
        userId: 'u',
        marketId: 'm',
        side: 'long',
        size: '1',
        markPrice: null,
        liqPrice: '90',
        distanceBps: null,
        reason: 'mark_not_accepted',
      },
    ],
    adlPairs: [],
    owedPayouts: [{ assetId: 'USDT', owed: '12.5', count: 2 }],
  };
  it('keeps an unknown distance as null with its reason, never zero', () => {
    const parsed = parseLiquidationDesk(desk);
    expect(parsed?.nearThreshold[0]).toMatchObject({ distanceBps: null, reason: 'mark_not_accepted', markPrice: null });
    expect(parsed?.parked).toEqual(['p9']);
  });
  it('refuses a desk with one malformed part', () => {
    expect(parseLiquidationDesk({ ...desk, rungs: [{ rungId: 'r1' }] })).toBeNull();
    expect(parseLiquidationDesk({ ...desk, owedPayouts: [{ assetId: 'USDT', owed: 12.5, count: 2 }] })).toBeNull();
  });
});

describe('insurance history', () => {
  const history = {
    asset: 'USDT',
    balance: { value: null, reason: 'ledger_unavailable' },
    draws: [{ rungId: 'r1', positionId: 'p1', amount: '3', at: '2026-10-20T08:00:00.000Z' }],
    topUps: { value: null, reason: 'insurance_topups_not_booked_here' },
  };
  it('keeps an unreadable balance as null with the reason', () => {
    expect(parseInsuranceHistory(history)).toMatchObject({
      balance: { value: null, reason: 'ledger_unavailable' },
      topUps: { reason: 'insurance_topups_not_booked_here' },
    });
  });
  it('refuses a draw amount that is not a decimal string', () => {
    expect(parseInsuranceHistory({ ...history, draws: [{ ...history.draws[0], amount: 3 }] })).toBeNull();
  });
});
