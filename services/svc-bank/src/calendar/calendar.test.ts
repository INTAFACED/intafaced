/**
 * BK-acct-10 (J-bank-06 #5): the money calendar's merge, with each source faked. The Postgres case is
 * `calendar.db.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { personalPayError } from '../personal-pay/errors.js';
import { CALENDAR_SOURCE_UNAVAILABLE, CalendarService, LOAN_SCHEDULE_UNSET, occurrencesIn, type CalendarDeps } from './calendar.js';

const DAY = 86_400_000;
const FROM = new Date('2026-11-01T00:00:00.000Z');
const NOW = new Date('2026-11-10T09:00:00.000Z');
const USER = '51111111-1111-4111-8111-111111111111';

function deps(over: Partial<CalendarDeps> = {}): CalendarDeps {
  return {
    sql: (async () => []) as unknown as CalendarDeps['sql'],
    transfers: { listSchedules: async () => [] },
    bills: { listRecurring: async () => [], railStatus: () => 'live' },
    directDebits: { dated: async () => [] },
    earn: { positionsOf: async () => [] },
    loans: { loansOf: async () => [] },
    ...over,
  };
}

const window = (d: CalendarDeps, days = 30) => new CalendarService(d).window({ userId: USER, from: FROM, days, limit: 50, now: NOW });

describe('occurrences in a window', () => {
  it('keeps a monthly order on the 31st through short months, and stops at the end date', () => {
    const startsAt = new Date('2026-01-31T08:00:00.000Z');
    const got = occurrencesIn(
      { startsAt, cadence: 'monthly', endsAt: null },
      new Date('2026-02-01T00:00:00.000Z'),
      new Date('2026-04-01T00:00:00.000Z'),
    );
    expect(got.map((o) => o.at.toISOString())).toEqual(['2026-02-28T08:00:00.000Z', '2026-03-31T08:00:00.000Z']);
    expect(got.map((o) => o.n)).toEqual([1, 2]);
    const ended = occurrencesIn(
      { startsAt, cadence: 'monthly', endsAt: new Date('2026-03-01T00:00:00.000Z') },
      new Date('2026-02-01T00:00:00.000Z'),
      new Date('2026-04-01T00:00:00.000Z'),
    );
    expect(ended.map((o) => o.n)).toEqual([1]);
  });

  it('gives every day of a daily order once, a one-off only on its date, and nothing before the start', () => {
    const daily = occurrencesIn(
      { startsAt: new Date('2025-01-01T06:00:00.000Z'), cadence: 'daily', endsAt: null },
      FROM,
      new Date(FROM.getTime() + 3 * DAY),
    );
    expect(daily.map((o) => o.at.toISOString())).toEqual([
      '2026-11-01T06:00:00.000Z',
      '2026-11-02T06:00:00.000Z',
      '2026-11-03T06:00:00.000Z',
    ]);
    const once = { startsAt: new Date('2026-11-05T09:00:00.000Z'), cadence: 'once' as const, endsAt: null };
    expect(occurrencesIn(once, FROM, new Date(FROM.getTime() + 30 * DAY)).map((o) => o.n)).toEqual([0]);
    expect(occurrencesIn(once, new Date('2026-11-06T00:00:00.000Z'), new Date('2026-12-06T00:00:00.000Z'))).toEqual([]);
    const later = { startsAt: new Date('2027-01-01T00:00:00.000Z'), cadence: 'weekly' as const, endsAt: null };
    expect(occurrencesIn(later, FROM, new Date(FROM.getTime() + 30 * DAY))).toEqual([]);
  });
});

describe('occurrences at the edges', () => {
  it('leaves out a date that falls exactly on the end, as the runner does', () => {
    const got = occurrencesIn(
      { startsAt: new Date('2026-11-01T08:00:00.000Z'), cadence: 'monthly', endsAt: new Date('2027-01-01T08:00:00.000Z') },
      new Date('2026-11-01T00:00:00.000Z'),
      new Date('2027-01-31T00:00:00.000Z'),
    );
    expect(got.map((o) => o.at.toISOString().slice(0, 10))).toEqual(['2026-11-01', '2026-12-01']);
  });
});

describe('the merged window', () => {
  it('puts each kind on its date, soonest first, and loans say their dates are not published', async () => {
    const view = await window(
      deps({
        transfers: {
          listSchedules: async () => [
            {
              id: 'S-1',
              userId: USER,
              assetId: 'USDT',
              fromSpaceId: 'a',
              toSpaceId: 'b',
              ownToSpaceId: 'b',
              amount: parseAmount('25'),
              cadence: 'once',
              startsAt: new Date('2026-11-20T09:00:00.000Z'),
              endsAt: null,
              nextRunAt: new Date('2026-11-20T09:00:00.000Z'),
              status: 'active',
              revision: 1,
            },
          ],
        },
        bills: {
          railStatus: () => 'live',
          listRecurring: async () => [
            {
              id: 'B-1',
              billerId: 'TEST-POWER',
              reference: 'TEST meter 7',
              amount: '40',
              assetId: 'USDT',
              fromSpaceId: 'a',
              cadence: 'monthly',
              status: 'active',
              startsAt: '2026-10-15T00:00:00.000Z',
              endsAt: null,
              nextRunAt: '2026-11-15T00:00:00.000Z',
            },
          ],
        },
        directDebits: {
          dated: async () => [
            {
              id: 'C-row',
              mandateId: 'MD-1',
              collectionId: 'C-1',
              creditorName: 'TEST Gym',
              assetId: 'USDT',
              amount: '5',
              dueAt: '2026-11-03T00:00:00.000Z',
              status: 'failed',
              failureCode: 'bank.insufficient_funds',
              ledgerTxId: null,
              presentedAt: '2026-11-01T00:00:00.000Z',
              settledAt: null,
              failureFee: null,
              failureFeeBlocker: 'bank.dd_failure_fee_unset',
              refund: { state: 'none', endsAt: null, requestedAt: null },
            },
          ],
        },
        earn: {
          positionsOf: async () => [
            {
              id: 'P-1',
              poolId: 'pool',
              userId: USER,
              assetId: 'USDT',
              principal: parseAmount('100'),
              openedAt: new Date('2026-10-01T00:00:00.000Z'),
              maturesAt: new Date('2026-11-25T00:00:00.000Z'),
              status: 'active',
              autoRenew: false,
              unbondingStartedAt: null,
              unbondsAt: null,
            },
            {
              id: 'P-flexible',
              poolId: 'pool',
              userId: USER,
              assetId: 'USDT',
              principal: parseAmount('1'),
              openedAt: new Date('2026-10-01T00:00:00.000Z'),
              maturesAt: null,
              status: 'active',
              autoRenew: false,
              unbondingStartedAt: null,
              unbondsAt: null,
            },
          ],
        },
        loans: {
          loansOf: async () =>
            [{ status: 'active' }, { status: 'repaid' }] as unknown as Awaited<ReturnType<CalendarDeps['loans']['loansOf']>>,
        },
      }),
    );
    expect(view.items.map((i) => [i.source, i.date.slice(0, 10), i.status, i.reasonCode])).toEqual([
      ['direct_debits', '2026-11-03', 'failed', 'bank.insufficient_funds'],
      ['bills', '2026-11-15', 'upcoming', null],
      ['standing_orders', '2026-11-20', 'upcoming', null],
      ['earn', '2026-11-25', 'upcoming', null],
    ]);
    expect(view.items.find((i) => i.source === 'direct_debits')).toMatchObject({ refId: 'MD-1', label: 'TEST Gym', amount: '5' });
    expect(view.sources).toEqual([
      { source: 'standing_orders', state: 'ok', count: 1, code: null, complete: true },
      { source: 'bills', state: 'ok', count: 1, code: null, complete: true },
      { source: 'direct_debits', state: 'ok', count: 1, code: null, complete: true },
      { source: 'loans', state: 'not_set', count: 1, code: LOAN_SCHEDULE_UNSET, complete: true },
      { source: 'earn', state: 'ok', count: 1, code: null, complete: true },
    ]);
    expect(view).toMatchObject({ from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' });
  });

  it('a source that breaks names itself and is logged; a source that refuses shows its code; the others still show', async () => {
    const log = vi.fn();
    const view = await window(
      deps({
        log,
        earn: {
          positionsOf: async () => {
            throw new Error('connection reset');
          },
        },
        loans: {
          loansOf: async () => {
            throw new BankError('limit unset', 'bank.loans_list_limit_unset' as never);
          },
        },
        bills: {
          railStatus: () => 'unset',
          listRecurring: async () => {
            throw personalPayError('bank.bills_list_limit_unset');
          },
        },
        directDebits: {
          dated: async () => [
            {
              id: 'C-row',
              mandateId: 'MD-1',
              collectionId: 'C-1',
              creditorName: 'TEST Gym',
              assetId: 'USDT',
              amount: '5',
              dueAt: '2026-11-12T00:00:00.000Z',
              status: 'upcoming',
              failureCode: null,
              ledgerTxId: null,
              presentedAt: '2026-11-01T00:00:00.000Z',
              settledAt: null,
              failureFee: null,
              failureFeeBlocker: null,
              refund: { state: 'none', endsAt: null, requestedAt: null },
            },
          ],
        },
      }),
    );
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ source: 'direct_debits', status: 'upcoming' });
    expect(view.sources).toEqual([
      { source: 'standing_orders', state: 'ok', count: 0, code: null, complete: true },
      { source: 'bills', state: 'refused', count: 0, code: 'bank.bills_list_limit_unset', complete: false },
      { source: 'direct_debits', state: 'ok', count: 1, code: null, complete: true },
      { source: 'loans', state: 'refused', count: 0, code: 'bank.loans_list_limit_unset', complete: false },
      { source: 'earn', state: 'unavailable', count: 0, code: CALENDAR_SOURCE_UNAVAILABLE, complete: false },
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('earn', expect.any(Error));
  });

  it('with no bill partner an empty bills source says why', async () => {
    const view = await window(deps({ bills: { listRecurring: async () => [], railStatus: () => 'unset' } }));
    expect(view.sources.find((s) => s.source === 'bills')).toEqual({
      source: 'bills',
      state: 'ok',
      count: 0,
      code: 'bank.bills_psp_unset',
      complete: true,
    });
  });

  it('refuses a window of no days, more than two months, or no date', async () => {
    const calendar = new CalendarService(deps());
    for (const input of [
      { from: FROM, days: 0 },
      { from: FROM, days: 63 },
      { from: FROM, days: 1.5 },
      { from: new Date('nope'), days: 30 },
    ]) {
      await expect(calendar.window({ userId: USER, limit: 50, ...input })).rejects.toMatchObject({ code: 'bank.calendar_window_invalid' });
    }
  });

  it('leaves out a past date an order never ran, keeps an overdue one due, and a matured unpaid position is due', async () => {
    const schedule = {
      id: 'S-2',
      userId: USER,
      assetId: 'USDT',
      fromSpaceId: 'a',
      toSpaceId: 'b',
      ownToSpaceId: 'b',
      amount: parseAmount('1'),
      cadence: 'daily' as const,
      startsAt: new Date('2026-11-05T09:00:00.000Z'),
      endsAt: null,
      // Behind: 8 and 9 Nov are due but not run; 5 to 7 Nov were passed over with no run of their own.
      nextRunAt: new Date('2026-11-08T09:00:00.000Z'),
      status: 'active' as const,
      revision: 1,
    };
    const view = await window(
      deps({
        transfers: { listSchedules: async () => [schedule] },
        earn: {
          positionsOf: async () => [
            {
              id: 'P-old',
              poolId: 'pool',
              userId: USER,
              assetId: 'USDT',
              principal: parseAmount('10'),
              openedAt: new Date('2026-10-01T00:00:00.000Z'),
              maturesAt: new Date('2026-11-04T00:00:00.000Z'),
              status: 'active',
              autoRenew: false,
              unbondingStartedAt: null,
              unbondsAt: null,
            },
          ],
        },
      }),
      12,
    );
    expect(view.items.map((i) => [i.source, i.date.slice(0, 10), i.status])).toEqual([
      ['earn', '2026-11-04', 'upcoming'],
      ['standing_orders', '2026-11-08', 'upcoming'],
      ['standing_orders', '2026-11-09', 'upcoming'],
      ['standing_orders', '2026-11-10', 'upcoming'],
      ['standing_orders', '2026-11-11', 'upcoming'],
      ['standing_orders', '2026-11-12', 'upcoming'],
    ]);
  });

  it("hides a paused bill's past dates, and says when a source filled its whole page", async () => {
    const bill = {
      id: 'B-p',
      billerId: 'TEST-POWER',
      reference: 'TEST meter 9',
      amount: '40',
      assetId: 'USDT',
      fromSpaceId: 'a',
      cadence: 'weekly' as const,
      status: 'paused' as const,
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: null,
      nextRunAt: '2026-10-08T00:00:00.000Z',
    };
    const calendar = new CalendarService(deps({ bills: { listRecurring: async () => [bill], railStatus: () => 'live' } }));
    const view = await calendar.window({ userId: USER, from: FROM, days: 30, limit: 1, now: NOW });
    expect(view.items.map((i) => [i.date.slice(0, 10), i.status])).toEqual([
      ['2026-11-12', 'paused'],
      ['2026-11-19', 'paused'],
      ['2026-11-26', 'paused'],
    ]);
    expect(view.sources.find((s) => s.source === 'bills')).toMatchObject({ complete: false });
    expect(view.sources.find((s) => s.source === 'standing_orders')).toMatchObject({ complete: true });
  });
});
