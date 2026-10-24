import { mulBps, parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import {
  FeeScheduleError,
  fundedMakerRebateBps,
  makerRebateBpsFor,
  parseFeeScheduleJson,
  previewFeeBps,
  publicFeeSchedule,
  publishedProductBps,
  resolveFeeRow,
} from './fee-schedule.js';
import { ratesForFill } from './fees.js';

const row = (over: Record<string, unknown> = {}) => ({
  pairGroup: 'group-1',
  tierId: 'regular',
  zeroFee: false,
  makerBps: '10',
  takerBps: '20',
  minFee: null,
  ...over,
});

const schedule = (rows: unknown[], extra: Record<string, unknown> = {}) =>
  parseFeeScheduleJson(
    JSON.stringify({
      published: true,
      version: 'rows-test',
      defaultPairGroup: 'group-1',
      pairGroups: { 'ZERO/USDT': 'zero' },
      rows,
      ...extra,
    }),
  );

function published(raw: ReturnType<typeof schedule>) {
  if (raw.published !== true) throw new Error('expected published');
  return raw;
}

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof FeeScheduleError) return err.code;
    throw err;
  }
  return 'no refusal';
};

describe('fee schedule rows', () => {
  it('charges group 1 maker 0.10% and taker 0.20%: a maker fill of 1000 USDT costs 1 USDT', () => {
    const s = published(schedule([row()]));
    const rates = ratesForFill(s, 0, 0, 'spot', { symbol: 'BTC/USDT' });
    expect(rates).toEqual({ makerFeeBps: 10, takerFeeBps: 20 });
    expect(mulBps(parseAmount('1000'), rates.makerFeeBps)).toBe(parseAmount('1'));
    expect(s.makerBps).toBe(10);
  });

  it('picks the row by pair group and by tier', () => {
    const s = published(
      schedule([
        row(),
        row({ zeroFee: true, pairGroup: 'zero', makerBps: undefined, takerBps: undefined }),
        row({ tierId: 'vip1', makerBps: '8', takerBps: '16' }),
      ]),
    );
    expect(publishedProductBps(s, 'spot', { symbol: 'BTC/USDT' })).toEqual({ makerBps: 10, takerBps: 20 });
    expect(publishedProductBps(s, 'spot', { symbol: 'BTC/USDT', tierId: 'vip1' })).toEqual({ makerBps: 8, takerBps: 16 });
    expect(publishedProductBps(s, 'spot', { symbol: 'ZERO/USDT' })).toEqual({ makerBps: 0, takerBps: 0 });
    expect(previewFeeBps(s, 'taker', 0, { symbol: 'BTC/USDT' })).toBe(20);
  });

  it('a tier with no row refuses and does not fall back to another tier', () => {
    const s = published(schedule([row()]));
    expect(refusal(() => resolveFeeRow(s, { symbol: 'BTC/USDT', tierId: 'vip2' }))).toBe('trade.fee_schedule_blank');
  });

  it('a pair group with no row refuses', () => {
    const s = published(schedule([row()], { pairGroups: { 'ODD/USDT': 'special' } }));
    expect(refusal(() => resolveFeeRow(s, { symbol: 'ODD/USDT' }))).toBe('trade.fee_schedule_blank');
  });

  it('zeroFee must be explicit, and a zero-fee row carries no rates', () => {
    expect(refusal(() => schedule([row({ zeroFee: undefined })]))).toBe('trade.fee_schedule_blank');
    expect(refusal(() => schedule([row({ zeroFee: true })]))).toBe('trade.fee_schedule_blank');
  });

  it('minFee must be present: null is "no minimum by owner decision", absent refuses', () => {
    expect(published(schedule([row({ minFee: null })])).rows?.[0]?.minFee).toBeNull();
    const absent = row();
    delete (absent as Record<string, unknown>).minFee;
    expect(refusal(() => schedule([absent]))).toBe('trade.fee_schedule_blank');
    expect(refusal(() => schedule([row({ minFee: 0.5 })]))).toBe('trade.fee_schedule_blank');
  });

  it('a decimal minimum fee refuses at use: no recipe takes a fee amount', () => {
    const s = published(schedule([row({ minFee: '0.5' })]));
    expect(refusal(() => ratesForFill(s, 0, 0, 'spot', { symbol: 'BTC/USDT' }))).toBe('trade.min_fee_recipe_unavailable');
  });

  it('a maker rebate row needs maker fee 0 and a rebate below every taker rate in its group, or the schedule refuses', () => {
    const rebate = { makerBps: '0', makerRebateBps: '2' };
    expect(refusal(() => schedule([row({ makerRebateBps: '2' })]))).toBe('trade.fee_schedule_blank');
    expect(refusal(() => schedule([row({ ...rebate, takerBps: '2' })]))).toBe('trade.fee_schedule_blank');
    // A VIP taker at 2 bps in the same group could not fund a 2 bps rebate.
    expect(refusal(() => schedule([row(rebate), row({ tierId: 'vip-1', makerBps: '0', takerBps: '2' })]))).toBe('trade.fee_schedule_blank');
    expect(
      refusal(() =>
        schedule([row(), row({ pairGroup: 'zero', zeroFee: true, makerBps: undefined, takerBps: undefined, makerRebateBps: '1' })]),
      ),
    ).toBe('trade.fee_schedule_blank');
  });

  it('a published rebate is charged, not refused: the maker pays 0 and earns the rebate, held below this fill taker rate', () => {
    const s = published(schedule([row({ makerBps: '0', makerRebateBps: '5' })]));
    expect(ratesForFill(s, 0, 0, 'spot', { symbol: 'BTC/USDT' })).toEqual({ makerFeeBps: 0, takerFeeBps: 20 });
    expect(makerRebateBpsFor(s, { symbol: 'BTC/USDT' })).toBe(5);
    expect(fundedMakerRebateBps(5, 0, 20)).toBe(5);
    // A rank discount took the taker to 4 bps: the rebate is held at 3, what that taker fee can pay.
    expect(fundedMakerRebateBps(5, 0, 4)).toBe(3);
    expect(fundedMakerRebateBps(5, 0, 1)).toBe(0);
    expect(fundedMakerRebateBps(5, 2, 20)).toBe(0);
    expect(fundedMakerRebateBps(0, 0, 20)).toBe(0);
    const none = published(schedule([row({ makerRebateBps: '0' })]));
    expect(makerRebateBpsFor(none, { symbol: 'BTC/USDT' })).toBe(0);
    expect(publicFeeSchedule(s, ['BTC/USDT']).groups[0]!.rows[0]).not.toHaveProperty('refusal');
  });

  it('the flat schedule pays no rebate and marks the one it publishes', () => {
    const flat = published(
      parseFeeScheduleJson(JSON.stringify({ published: true, version: 'f', makerBps: '10', takerBps: '20', makerRebateBps: '2' })),
    );
    expect(makerRebateBpsFor(flat, { symbol: 'BTC/USDT' })).toBe(0);
    expect(publicFeeSchedule(flat, ['BTC/USDT']).groups[0]!.rows[0]).toMatchObject({ refusal: 'trade.rebate_recipe_unavailable' });
  });

  it('rows replace the flat rates, need the default group regular row, and reject duplicates', () => {
    expect(refusal(() => schedule([row()], { makerBps: '10', takerBps: '20' }))).toBe('trade.fee_schedule_blank');
    expect(refusal(() => schedule([row({ tierId: 'vip1' })]))).toBe('trade.fee_schedule_blank');
    expect(refusal(() => schedule([row(), row()]))).toBe('trade.fee_schedule_blank');
    expect(refusal(() => schedule([]))).toBe('trade.fee_schedule_blank');
  });

  it('a flat schedule without rows resolves unchanged', () => {
    const flat = published(parseFeeScheduleJson(JSON.stringify({ published: true, version: 'f', makerBps: '10', takerBps: '20' })));
    expect(ratesForFill(flat, 0, 0, 'spot', { symbol: 'BTC/USDT' })).toEqual({ makerFeeBps: 10, takerFeeBps: 20 });
  });
});
