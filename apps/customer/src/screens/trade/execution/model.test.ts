import { describe, expect, it } from 'vitest';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import type { Order } from '../../../features/trade/trade-api';
import {
  MAX_SEED,
  parseSeed,
  triggerProblem,
  MAX_SLICES,
  algoClientId,
  bpsAsPercent,
  buildLadder,
  chaseDistanceBps,
  CREATE_BLOCKER_CODE,
  createBlocker,
  defaultIntervalMs,
  findGroup,
  matchesPrefix,
  newNonce,
  ownsNote,
  planSchedule,
  reviewIceberg,
  scaledGroupOf,
  scaledId,
  scaledPrefix,
  summarizeBatch,
  type LadderInput,
  type PlanDraft,
} from './model';
import { blotterCsv, buildBlotter, childParents, filterBlotter, inAlgoWindow } from './blotter';
import { TEST_BATCH, TEST_ORDERS, TEST_WINDOWS } from './fixtures';
import { roomWords } from '../rooms/refusals';
import { execCopy } from './copy';

const draft: PlanDraft = {
  kind: 'twap',
  total: '1',
  durationMs: 3_600_000,
  intervalMs: 300_000,
  lot: '0.0001',
  tick: '0.01',
  minAmount: '0.0001',
  limit: '',
  last: '60000',
  taker: '0.001',
  participationBps: null,
  startMs: 1_000,
};

describe('create blocker', () => {
  it('with the scheduler off the form refuses with its reason', () => {
    expect(createBlocker({ createEnabled: true, jobsEnabled: false }, true)).toBe('Scheduler off block');
    expect(execCopy.t('Scheduler off block')).toMatch(/slice scheduler is off/);
  });

  it('an unread policy or creating switched off blocks too; a closed market blocks only once the scheduler runs', () => {
    expect(createBlocker(null, true)).toBe('Scheduler unknown');
    // Each blocker names the service's own refusal code; an unread policy was answered nothing, so names none.
    expect(CREATE_BLOCKER_CODE['Scheduler off block']).toBe('trade.algo_jobs_disabled');
    expect(CREATE_BLOCKER_CODE['Create off block']).toBe('trade.algo_disabled');
    expect(CREATE_BLOCKER_CODE['Market closed block']).toBe('trade.market_closed');
    expect(CREATE_BLOCKER_CODE['Scheduler unknown']).toBeUndefined();
    expect(createBlocker({ createEnabled: false, jobsEnabled: true }, true)).toBe('Create off block');
    expect(createBlocker({ createEnabled: true, jobsEnabled: false }, false)).toBe('Scheduler off block');
    expect(createBlocker({ createEnabled: true, jobsEnabled: true }, false)).toBe('Market closed block');
    expect(createBlocker({ createEnabled: true, jobsEnabled: true }, true)).toBeNull();
  });
});

describe('schedule plan', () => {
  it('plans ceil(duration / interval) slices and puts the remainder on the last', () => {
    const { plan } = planSchedule({ ...draft, total: '1', intervalMs: 600_000, durationMs: 3_600_000 });
    expect(plan?.slices).toBe(6);
    expect(plan?.perSlice).toBe('0.1666');
    expect(plan?.lastSlice).toBe('0.167');
    expect(plan?.endsAt).toBe(3_601_000);
  });
  it('prices the estimate at the limit when given, else at last, exactly', () => {
    expect(planSchedule(draft).plan?.estNotional).toBe('60000');
    expect(planSchedule(draft).plan?.estFee).toBe('60');
    expect(planSchedule({ ...draft, limit: '59000.5' }).plan?.estNotional).toBe('59000.5');
  });
  it('refuses more slices than the cap, naming it', () => {
    const r = planSchedule({ ...draft, durationMs: 3_600_000, intervalMs: 3_600_000 / (MAX_SLICES + 1) });
    expect(r.plan).toBeNull();
    expect(r.problems).toEqual(['tooManySlices']);
  });
  it('refuses slices that round to nothing or fall under the minimum', () => {
    expect(planSchedule({ ...draft, total: '0.0003', lot: '0.0001' }).problems).toEqual(['sliceTooSmall']);
    expect(planSchedule({ ...draft, total: '0.0012', lot: '0.0001', minAmount: '0.0002' }).problems).toEqual(['sliceBelowMin']);
  });
  it('checks each field and never plans from bad input', () => {
    const r = planSchedule({ ...draft, total: '0', durationMs: 500, intervalMs: 0, limit: '0.005', kind: 'pov', participationBps: 20_000 });
    expect(r.plan).toBeNull();
    expect(r.problems).toEqual(['total', 'duration', 'interval', 'limit', 'participation']);
  });
  it('defaults to twelve slices on whole seconds', () => {
    expect(defaultIntervalMs(3_600_000)).toBe(300_000);
    expect(defaultIntervalMs(5_000)).toBe(1000);
    expect(defaultIntervalMs(1000)).toBe(1000);
  });
});

describe('chase', () => {
  it('reads the maximum distance as a percent with at most two decimals, in bps', () => {
    expect(chaseDistanceBps('2')).toBe(200);
    expect(chaseDistanceBps('2.5')).toBe(250);
    expect(chaseDistanceBps('0.01')).toBe(1);
    expect(chaseDistanceBps('100')).toBe(10_000);
    for (const bad of ['', ' ', '0', '0.00', '100.01', '101', '2.555', '-1', 'abc', '1e2']) expect(chaseDistanceBps(bad)).toBeNull();
    expect(bpsAsPercent(200)).toBe('2');
    expect(bpsAsPercent(250)).toBe('2.5');
    expect(bpsAsPercent(1)).toBe('0.01');
  });
  it('a blank distance refuses the plan, naming it', () => {
    const r = planSchedule({ ...draft, kind: 'chase', chaseDistance: '' });
    expect(r.plan).toBeNull();
    expect(r.problems).toEqual(['chaseDistance']);
  });
  it('plans one order with no slice interval, and refuses a limit price', () => {
    const r = planSchedule({ ...draft, kind: 'chase', chaseDistance: '2', intervalMs: null, total: '0.5' });
    expect(r.problems).toEqual([]);
    expect(r.plan?.slices).toBe(1);
    expect(r.plan?.perSlice).toBe('0.5');
    expect(planSchedule({ ...draft, kind: 'chase', chaseDistance: '2', limit: '59000' }).problems).toEqual(['limit']);
  });
});

describe('iceberg review', () => {
  it('splits visible and hidden, counts refills, holds limit x total', () => {
    const r = reviewIceberg({ total: '1', display: '0.3', price: '60000.01', lot: '0.0001', tick: '0.01' });
    expect(r).toMatchObject({ visible: '0.3', hidden: '0.7', refills: '4', hold: '60000.01', problems: [] });
    expect(r.referenceMin).toBe('0.0666');
  });
  it('refuses a display that is not smaller than the total', () => {
    expect(reviewIceberg({ total: '1', display: '1', price: '1', lot: null, tick: null }).problems).toEqual(['displayTooBig']);
    expect(reviewIceberg({ total: '1', display: '1', price: '1', lot: null, tick: null }).refills).toBeNull();
  });
});

const ladder: LadderInput = {
  side: 'buy',
  total: '0.01',
  count: 4,
  start: '59000',
  end: '60000',
  distribution: 'equal',
  ratio: null,
  tick: '0.01',
  lot: '0.0001',
  minAmount: '0.0001',
  minCost: '5',
  taker: '0.001',
  maker: '0.0005',
  freeQuote: '569.015372',
  freeBase: '0.0010999',
};

describe('scaled ladder', () => {
  it('builds exact rows with cumulative size and hold, average and fees', () => {
    const { ladder: l } = buildLadder(ladder);
    expect(l?.rows.map((r) => r.price)).toEqual(['59000', '59333.33', '59666.67', '60000']);
    expect(l?.rows.map((r) => r.size)).toEqual(['0.0025', '0.0025', '0.0025', '0.0025']);
    expect(l?.rows[3]).toMatchObject({ cumSize: '0.01', cumHold: '595', notional: '150' });
    expect(l?.totalSize).toBe('0.01');
    expect(l?.totalNotional).toBe('595');
    expect(l?.avgPrice).toBe('59500');
    expect(l?.holdAsset).toBe('quote');
  });
  it('puts the lot remainder on the last order and says so', () => {
    const { ladder: l } = buildLadder({ ...ladder, total: '0.0103', count: 3 });
    expect(l?.rows.map((r) => r.size)).toEqual(['0.0034', '0.0034', '0.0035']);
    expect(l?.residual).toBe('0.0001');
    expect(l?.totalSize).toBe('0.0103');
  });
  it('weights ascending, descending and ratio sizes and still adds up', () => {
    const asc = buildLadder({ ...ladder, distribution: 'ascending', total: '0.01', count: 4 }).ladder!;
    expect(asc.rows.map((r) => r.size)).toEqual(['0.001', '0.002', '0.003', '0.004']);
    const desc = buildLadder({ ...ladder, distribution: 'descending', total: '0.01', count: 4 }).ladder!;
    expect(desc.rows.map((r) => r.size)).toEqual(['0.004', '0.003', '0.002', '0.001']);
    const ratio = buildLadder({ ...ladder, distribution: 'ratio', ratio: 3, total: '0.012', count: 3 }).ladder!;
    expect(ratio.rows.map((r) => r.size)).toEqual(['0.002', '0.004', '0.006']);
    expect(ratio.totalSize).toBe('0.012');
  });
  it('flags rows below the minimum amount or order value', () => {
    const l = buildLadder({ ...ladder, minAmount: '0.003' }).ladder!;
    expect(l.rows.every((r) => r.belowMin)).toBe(true);
    const cost = buildLadder({ ...ladder, total: '0.0004', count: 2, minAmount: '0.0001', minCost: '20' }).ladder!;
    expect(cost.rows.map((r) => r.belowMin)).toEqual([true, true]);
  });
  it('holds base for a sell and reports a short balance', () => {
    const l = buildLadder({ ...ladder, side: 'sell', total: '0.002', count: 2 }).ladder!;
    expect(l.holdAsset).toBe('base');
    expect(l.hold).toBe('0.002');
    expect(l.freeAfter).toBe('-0.0009001');
    expect(l.short).toBe(true);
  });
  it('estimates fees from the listing rates', () => {
    const l = buildLadder(ladder).ladder!;
    expect(l.feeTaker).toBe('0.595');
    expect(l.feeMaker).toBe('0.2975');
  });
  it('refuses bad numbers and prices that collapse onto one tick', () => {
    expect(buildLadder({ ...ladder, count: 1 }).problems).toEqual(['count']);
    expect(buildLadder({ ...ladder, total: '0.00005' }).problems).toEqual(['lot']);
    expect(buildLadder({ ...ladder, start: '60000', end: '60000.004' }).problems).toEqual(['samePrices']);
    expect(buildLadder({ ...ladder, distribution: 'ratio', ratio: 0 }).problems).toEqual(['ratio']);
    expect(buildLadder({ ...ladder, total: '0.0001', count: 3 }).problems).toEqual(['tooSmall']);
  });
});

describe('client ids', () => {
  it('builds algo and scaled ids from one nonce and matches by prefix', () => {
    expect(algoClientId('abc')).toBe('algo-abc');
    expect(scaledId('abc', 3)).toBe('scl-abc-3');
    expect(matchesPrefix('scl-abc-3', scaledPrefix('abc'))).toBe(true);
    expect(matchesPrefix('scl-abd-3', scaledPrefix('abc'))).toBe(false);
    expect(matchesPrefix(null, scaledPrefix('abc'))).toBe(false);
    expect(scaledGroupOf('scl-abc-12')).toBe('scl-abc-');
    expect(scaledGroupOf('manual-1')).toBeNull();
    expect(newNonce()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('batch results and recovery', () => {
  it('counts placed, refused and unknown', () => {
    expect(summarizeBatch(TEST_BATCH)).toEqual({ placed: 2, refused: 1, unknown: 1 });
  });
  it('finds which orders of a ladder exist, from both lists', () => {
    const rows = findGroup('tst1', 4, [[TEST_ORDERS.scaledOpen], [TEST_ORDERS.scaledClosed]]);
    expect(rows.map((r) => r.order?.id ?? null)).toEqual(['o-1', 'o-2', null, null]);
  });
});

describe('blotter', () => {
  const rows = buildBlotter(
    [TEST_ORDERS.scaledOpen, TEST_ORDERS.algoChild],
    [TEST_ORDERS.scaledClosed, TEST_ORDERS.scaledOpen, TEST_ORDERS.manual],
    [],
    TEST_WINDOWS,
  );
  it('drops duplicates and sources each order', () => {
    expect(rows).toHaveLength(4);
    const by = Object.fromEntries(rows.map((r) => [r.id, r.source]));
    expect(by['order:o-1']).toBe('scaled');
    expect(by['order:o-9']).toBe('algo');
    expect(by['order:o-8']).toBe('manual');
  });
  it('matches algo only on market, side and time', () => {
    const w = TEST_WINDOWS;
    expect(inAlgoWindow({ symbol: 'BTC/USDT', side: 'buy', time: w[0]!.fromMs + 1 }, w)).toBe(true);
    expect(inAlgoWindow({ symbol: 'BTC/USDT', side: 'sell', time: w[0]!.fromMs + 1 }, w)).toBe(false);
    expect(inAlgoWindow({ symbol: 'ETH/USDT', side: 'buy', time: w[0]!.fromMs + 1 }, w)).toBe(false);
    expect(inAlgoWindow({ symbol: 'BTC/USDT', side: 'buy', time: w[0]!.toMs + 1 }, w)).toBe(false);
  });
  it('filters by source, side and market', () => {
    expect(filterBlotter(rows, { market: 'all', side: 'all', source: 'scaled', parent: 'all' })).toHaveLength(2);
    expect(filterBlotter(rows, { market: 'all', side: 'sell', source: 'all', parent: 'all' }).every((r) => r.side === 'sell')).toBe(true);
    expect(filterBlotter(rows, { market: 'ETH/USDT', side: 'all', source: 'all', parent: 'all' })).toHaveLength(0);
  });
  it("links an algo child and its fills to their schedule by the schedule's own list of children, outside any time window", () => {
    const child = { ...TEST_ORDERS.manual, id: 'o-20', symbol: 'ETH/USDT', clientOrderId: 'algo:algo-u1-p1:3' } as Order;
    const other = { ...TEST_ORDERS.manual, id: 'o-21', symbol: 'ETH/USDT', clientOrderId: 'algo:algo-u1-p2:0' } as Order;
    const fillOf = (id: string, order: string) =>
      ({ id, order, timestamp: child.timestamp, symbol: 'ETH/USDT', side: child.side, price: '1', amount: '1' }) as Trade;
    const childOf = childParents([
      { id: 'algo-u1-p1', children: [{ orderId: 'o-20' }, { orderId: 'o-22' }] },
      { id: 'algo-u1-p2', children: [{ orderId: 'o-21' }] },
    ]);
    // o-22's order is no longer listed, but its schedule names it: its fill is still linked.
    const linked = buildBlotter([child, other], [], [fillOf('f-1', 'o-20'), fillOf('f-2', 'o-22')], [], childOf);
    expect(linked.map((r) => [r.id, r.source, r.parentId, r.byTime])).toEqual(
      expect.arrayContaining([
        ['order:o-20', 'algo', 'algo-u1-p1', false],
        ['order:o-21', 'algo', 'algo-u1-p2', false],
        ['fill:f-1', 'algo', 'algo-u1-p1', false],
        ['fill:f-2', 'algo', 'algo-u1-p1', false],
      ]),
    );
    const one = filterBlotter(linked, { market: 'all', side: 'all', source: 'all', parent: 'algo-u1-p1' });
    expect(one.map((r) => r.id).sort()).toEqual(['fill:f-1', 'fill:f-2', 'order:o-20']);
  });
  it('never links by a client id anyone can type, and marks a time-only match as such', () => {
    // An API order carrying a real schedule's id shape, that the schedule does not list.
    const typed = { ...TEST_ORDERS.manual, id: 'o-30', symbol: 'ETH/USDT', clientOrderId: 'algo:algo-u1-p1:7' } as Order;
    const inWindow = { ...TEST_ORDERS.manual, id: 'o-31', side: 'buy', timestamp: TEST_WINDOWS[0]!.fromMs + 1 } as Order;
    const rows = buildBlotter([typed, inWindow], [], [], TEST_WINDOWS, childParents([{ id: 'algo-u1-p1', children: [] }]));
    const by = Object.fromEntries(rows.map((r) => [r.id, [r.source, r.parentId, r.byTime]]));
    expect(by['order:o-30']).toEqual(['manual', null, false]);
    expect(by['order:o-31']).toEqual(['algo', null, true]);
    expect(filterBlotter(rows, { market: 'all', side: 'all', source: 'all', parent: 'algo-u1-p1' })).toHaveLength(0);
    // The export says which algo rows are only a guess.
    expect(blotterCsv(rows.filter((r) => r.id === 'order:o-31')).split('\n')[1]).toContain(',algo_by_time,');
  });
  it('writes a CSV of exactly what is shown, with exact strings and safe text cells', () => {
    const csv = blotterCsv([{ ...rows[0]!, clientOrderId: '=cmd,"x"' }]);
    const [head, line] = csv.split('\n');
    expect(head).toBe('time_utc,kind,market,side,type,price,size,filled,avg,state,source,client_order_id');
    expect(line).toContain('"\'=cmd,""x"""');
    expect(blotterCsv([]).split('\n')).toHaveLength(1);
  });
  it('marks a recovering order and keeps it cancellable-by-check only as live', () => {
    const r = buildBlotter([{ ...TEST_ORDERS.manual, recoveryRequired: true } as Order], [], [], []);
    expect(r[0]!.state).toBe('recovery');
    expect(r[0]!.order).not.toBeNull();
  });
});

describe('roomWords', () => {
  it('keeps the service sentence for a code it has no words for, and the code as small text', () => {
    const w = roomWords({ code: 'trade.something_new', message: 'The venue paused this market.' });
    expect(w.body).toBe('The venue paused this market.');
    expect(w.code).toBe('trade.something_new');
  });
  it('keeps shared words, not the service sentence, for a code outside the trade family', () => {
    expect(roomWords({ code: 'ledger.something_new', message: 'svc-ledger posting 42 failed' }).body).not.toContain('svc-ledger');
  });
  it('knows the price band code', () => {
    expect(roomWords({ code: 'trade.price_band', message: 'ignored' }).title).toBe('Price is too far from the market');
  });
  it('does not use the service sentence for a code it already explains', () => {
    expect(roomWords({ code: 'scope.denied', message: 'raw words' }).body).not.toBe('raw words');
  });
});

describe('device note ownership', () => {
  const desk = { kind: 'place', id: 'desk:9', symbol: 'BTC/USDT' } as const;
  it('never lets a room release a spot desk note', () => {
    expect(ownsNote('scaled', desk)).toBe(false);
    expect(ownsNote('algo', desk)).toBe(false);
    expect(ownsNote('execCancel', desk)).toBe(false);
    expect(ownsNote('iceberg', desk)).toBe(false);
  });
  it('gives an ice- place note to iceberg only', () => {
    const note = { kind: 'place', id: 'ice-abc' } as const;
    expect(ownsNote('iceberg', note)).toBe(true);
    expect(ownsNote('scaled', note)).toBe(false);
    expect(ownsNote('algo', note)).toBe(false);
    expect(ownsNote('execCancel', note)).toBe(false);
    expect(ownsNote('iceberg', { kind: 'place', id: 'scl-abc' })).toBe(false);
  });
  it('gives a scl- place note to scaled only', () => {
    const note = { kind: 'place', id: 'scl-abc' } as const;
    expect(ownsNote('scaled', note)).toBe(true);
    expect(ownsNote('algo', note)).toBe(false);
    expect(ownsNote('execCancel', note)).toBe(false);
  });
  it('gives algo notes, including pause/resume/cancel ones, to algo only', () => {
    for (const note of [
      { kind: 'algo', id: 'algo-x' },
      { kind: 'algo', id: 'cancel:p1' },
    ] as const) {
      expect(ownsNote('algo', note)).toBe(true);
      expect(ownsNote('scaled', note)).toBe(false);
      expect(ownsNote('execCancel', note)).toBe(false);
    }
  });
  it('gives a cancel note to the single-order cancel flow only', () => {
    const note = { kind: 'cancel', id: 'o1' } as const;
    expect(ownsNote('execCancel', note)).toBe(true);
    expect(ownsNote('scaled', note)).toBe(false);
    expect(ownsNote('algo', note)).toBe(false);
  });
});

describe('random sizes and trigger price', () => {
  it('a seed is a whole number from 0 to the service limit', () => {
    expect(parseSeed('2310')).toBe(2310);
    expect(parseSeed(' 0 ')).toBe(0);
    expect(parseSeed(String(MAX_SEED))).toBe(MAX_SEED);
    expect(parseSeed(String(MAX_SEED + 1))).toBeNull();
    expect(parseSeed('')).toBeNull();
    expect(parseSeed('1.5')).toBeNull();
    expect(parseSeed('-1')).toBeNull();
  });

  it('a blank trigger is no trigger; a typed one must be above zero', () => {
    expect(triggerProblem('')).toBe(false);
    expect(triggerProblem('  ')).toBe(false);
    expect(triggerProblem('140000')).toBe(false);
    expect(triggerProblem('0.5')).toBe(false);
    expect(triggerProblem('0')).toBe(true);
    expect(triggerProblem('abc')).toBe(true);
  });
});
