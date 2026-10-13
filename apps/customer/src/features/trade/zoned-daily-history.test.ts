import { describe, expect, it, vi } from 'vitest';
import type { OHLCV } from '@intafaced/exchange-contract/schemas';
import { canonicalDailyZone, deriveZonedDaily, planZonedDaily } from './zoned-daily-history';
import { createTradeApi } from './trade-api';
import { createApiClient } from '../../shared/api';

const stamp = (value: string) => Date.parse(value);
const now = stamp('2026-10-10T12:00:00Z');
const candle = (time: number, values = ['100', '102', '99', '101', '0.000000000000000001']): OHLCV => [time, ...values] as OHLCV;
describe('captured chosen-zone daily boundaries', () => {
  it.each(['EST5EDT', 'CST6CDT', 'MST7MDT', 'PST8PDT'])('canonicalizes the named alias %s using this runtime', (alias) => {
    const canonical = new Intl.DateTimeFormat('en', { timeZone: alias }).resolvedOptions().timeZone;
    expect(canonicalDailyZone(alias)).toBe(canonical);
    expect(planZonedDaily(alias, now)).toEqual(planZonedDaily(canonical, now));
  });
  it.each(['1', '123', '+01', '-0100', '+01:00', '1EST5EDT', 'Unknown/Unpublished_Zone'])(
    'refuses numeric or unpublished input %s',
    (input) => {
      expect(() => canonicalDailyZone(input)).toThrow('invalid_zone');
    },
  );
  it.each(['UTC', 'Etc/GMT+8', 'US/Eastern'])('retains recognized named input %s', (input) => {
    expect(canonicalDailyZone(input)).toBe(new Intl.DateTimeFormat('en', { timeZone: input }).resolvedOptions().timeZone);
  });
  it.each([
    ['America/New_York', '2026-03-08T12:00:00Z', '2026-03-08', '2026-03-08T05:00:00Z', 23, '1h', 19],
    ['America/New_York', '2026-11-01T12:00:00Z', '2026-11-01', '2026-11-01T04:00:00Z', 25, '1h', 19],
    ['Australia/Lord_Howe', '2026-10-04T03:00:00Z', '2026-10-04', '2026-10-03T13:30:00Z', 23.5, '15m', 3],
    ['Australia/Lord_Howe', '2026-04-05T03:00:00Z', '2026-04-05', '2026-04-04T13:00:00Z', 24.5, '15m', 3],
    ['Asia/Kathmandu', '2026-10-10T12:00:00Z', '2026-10-10', '2026-10-09T18:15:00Z', 24, '15m', 3],
    ['America/Santiago', '2026-09-06T12:00:00Z', '2026-09-06', '2026-09-06T04:00:00Z', 23, '1h', 19],
    ['America/Havana', '2026-11-01T12:00:00Z', '2026-11-01', '2026-11-01T04:00:00Z', 25, '1h', 19],
  ])('%s %s chooses the earliest valid date boundary and a representable source', (zone, clock, date, start, hours, interval, prior) => {
    const plan = planZonedDaily(String(zone), stamp(String(clock)));
    const day = plan.dateIntervals.find((entry) => entry.calendarDate === date)!;
    expect(day.startMs).toBe(stamp(String(start)));
    expect(day.endMs - day.startMs).toBe(Number(hours) * 3_600_000);
    expect(plan.sourceInterval).toBe(interval);
    expect(plan.priorDates).toBe(prior);
    expect(plan.dateIntervals.every((entry) => entry.startMs % plan.sourceSpanMs === 0 && entry.endMs % plan.sourceSpanMs === 0)).toBe(
      true,
    );
    expect(Math.floor((plan.requestedAtMs + 15_000 - plan.sinceMs) / plan.sourceSpanMs) + 1).toBeLessThan(500);
  });
  it('omits the absent Apia date without a fabricated 24-hour interval', () => {
    const plan = planZonedDaily('Pacific/Apia', stamp('2011-12-30T12:00:00Z'));
    expect(plan.dateIntervals.some((entry) => entry.calendarDate === '2011-12-30')).toBe(false);
    const before = plan.dateIntervals.find((entry) => entry.calendarDate === '2011-12-29')!;
    const after = plan.dateIntervals.find((entry) => entry.calendarDate === '2011-12-31')!;
    expect(before.endMs).toBe(after.startMs);
    expect(before.endMs - before.startMs).toBe(86_400_000);
  });
  it('checks all retained dates rather than choosing hourly from only today', () => {
    const plan = planZonedDaily('Australia/Lord_Howe', stamp('2026-04-20T12:00:00Z'));
    expect(plan.sourceInterval).toBe('15m');
    expect(plan.priorDates).toBe(3);
  });
  it('refuses historical seconds and unknown identifiers without substituting UTC', () => {
    expect(() => planZonedDaily('Africa/Monrovia', stamp('1971-10-10T12:00:00Z'))).toThrow('unrepresentable_boundary');
    expect(() => canonicalDailyZone('Not/A_Zone')).toThrow('invalid_zone');
    expect(canonicalDailyZone('US/Eastern')).toBe(canonicalDailyZone('America/New_York'));
  });
  it('bounds Intl work and retains immutable captured boundaries', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      const plan = planZonedDaily('America/New_York', now);
      expect(spy.mock.calls.length).toBeLessThan(10_000);
      expect(Object.isFrozen(plan) && Object.isFrozen(plan.dateIntervals) && Object.isFrozen(plan.dateIntervals[0])).toBe(true);
      expect(() => deriveZonedDaily([], { ...plan, sinceMs: plan.sinceMs + 1 }, now)).toThrow('invalid_clock_window');
    } finally {
      spy.mockRestore();
    }
  });
});
describe('whole snapshot admission and exact aggregation', () => {
  const plan = planZonedDaily('Asia/Kathmandu', now);
  const start = plan.dateIntervals.find((entry) => entry.startMs <= now && now < entry.endMs)!.startMs;
  it('preserves chronological exact open/close, high/low and scaled volume without filling gaps', () => {
    const source = [
      candle(start, ['100.000000000000000001', '102.000000000000000001', '99.000000000000000002', '101', '0.000000000000000001']),
      candle(start + 900_000 * 2, [
        '100',
        '102.000000000000000002',
        '99.000000000000000001',
        '100.000000000000000009',
        '0.000000000000000002',
      ]),
    ];
    const original = structuredClone(source);
    const snapshot = deriveZonedDaily(source, plan, now);
    expect(snapshot.rows).toEqual([[start, source[0]![1], source[1]![2], source[1]![3], source[1]![4], '0.000000000000000003']]);
    expect(source).toEqual(original);
    expect(snapshot.metadata).toMatchObject({
      zone: plan.zone,
      sourceInterval: '15m',
      priorDates: 3,
      readAtMs: now,
      nextBoundaryMs: plan.nextBoundaryMs,
      partialCurrent: true,
      manualRefresh: true,
    });
    expect(snapshot.plan).toBe(plan);
    expect(deriveZonedDaily([], plan, now).rows).toEqual([]);
    expect(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.rows) && Object.isFrozen(snapshot.rows[0])).toBe(true);
  });
  it.each([
    'duplicate',
    'descending',
    'unaligned',
    'before since',
    'future',
    'cap',
    'extra field',
    'numeric money',
    'bad high',
    'zero price',
    'negative volume',
    'over precision',
    'whitespace',
    'exponent',
  ] as const)('refuses every row for %s with no accepted prefix', (kind) => {
    let source = [candle(start), candle(start + 900_000)];
    if (kind === 'duplicate') source[1]![0] = start;
    if (kind === 'descending') source.reverse();
    if (kind === 'unaligned') source[1]![0]++;
    if (kind === 'before since') source[0]![0] = plan.sinceMs - 900_000;
    if (kind === 'future') source[1]![0] = Math.floor(now / 900_000) * 900_000 + 900_000;
    if (kind === 'cap') source = Array.from({ length: 500 }, (_, index) => candle(plan.sinceMs + index * 900_000));
    if (kind === 'extra field') (source[1] as unknown[]).push('extra');
    if (kind === 'numeric money') (source[1] as unknown[])[1] = 100;
    if (kind === 'bad high') source[1]![2] = '98';
    if (kind === 'zero price') source[1]![3] = '0';
    if (kind === 'negative volume') source[1]![5] = '-1';
    if (kind === 'over precision') source[1]![5] = '0.0000000000000000001';
    if (kind === 'whitespace') source[1]![1] = ' 100';
    if (kind === 'exponent') source[1]![1] = '1e2';
    expect(() => deriveZonedDaily(source, plan, now)).toThrow('invalid_source_history');
  });
  it.each([now - 1, now + 15_001, NaN, Infinity])('refuses clock %s', (clock) => {
    expect(() => deriveZonedDaily([], plan, clock)).toThrow('invalid_clock_window');
  });
  it('crosses local midnight using the captured next interval and trims the oldest date', () => {
    const clock = stamp('2026-03-09T03:59:59.999Z'),
      captured = planZonedDaily('America/New_York', clock);
    const source = [candle(captured.sinceMs), candle(stamp('2026-03-08T05:00:00Z')), candle(clock + 1)];
    const snapshot = deriveZonedDaily(source, captured, clock + 1);
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.metadata.currentCalendarDate).toBe('2026-03-09');
    expect(snapshot.metadata.nextBoundaryMs).toBe(stamp('2026-03-10T04:00:00Z'));
    expect(snapshot.plan).toBe(captured);
  });
});
describe('actual public reader seam', () => {
  it.each(['2026-10-10T12:00:00Z', '2026-03-08T12:00:00Z', '2026-11-01T12:00:00Z'])(
    'alias and geographic target capture identical boundaries and bounded source GETs at %s',
    async (clock) => {
      const capturedAt = stamp(clock),
        reads: string[] = [];
      const api = createTradeApi(
        createApiClient({
          fetch: async (input) => {
            const url = new URL(String(input), 'http://test.invalid');
            reads.push(url.href);
            return new Response(JSON.stringify([candle(Number(url.searchParams.get('since')))]));
          },
        }),
        () => capturedAt,
      );
      const alias = await api.zonedDailyHistory('BTC/USDT', 'EST5EDT');
      const target = await api.zonedDailyHistory('BTC/USDT', 'America/New_York');
      expect(alias.ok && target.ok).toBe(true);
      if (!alias.ok || !target.ok) return;
      expect(reads).toHaveLength(2);
      expect(reads[0]).toBe(reads[1]);
      expect(alias.data.plan.zone).toBe(new Intl.DateTimeFormat('en', { timeZone: 'EST5EDT' }).resolvedOptions().timeZone);
      const { zone: aliasZone, ...aliasPlan } = alias.data.plan;
      const { zone: targetZone, ...targetPlan } = target.data.plan;
      expect(aliasPlan).toEqual(targetPlan);
      expect(alias.data.rows).toEqual(target.data.rows);
      expect(aliasZone && targetZone).toBeTruthy();
    },
  );
  it.each(['America/New_York', 'Asia/Kathmandu'])('sends one bounded GET for %s and keeps the plan with the rows', async (zone) => {
    const reads: { method?: string; url: URL }[] = [];
    const api = createTradeApi(
      createApiClient({
        fetch: async (input, options) => {
          const url = new URL(String(input), 'http://test.invalid');
          reads.push({ method: options?.method, url });
          return new Response(JSON.stringify([candle(Number(url.searchParams.get('since')))]));
        },
      }),
      () => now,
    );
    const result = await api.zonedDailyHistory('BTC/USDT', zone);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(reads).toHaveLength(1);
    expect(reads[0]!.method).toBe('GET');
    expect(reads[0]!.url.pathname).toBe('/api/v1/ohlcv/BTC%2FUSDT');
    expect(Object.fromEntries(reads[0]!.url.searchParams)).toEqual({
      timeframe: result.data.plan.sourceInterval,
      limit: '500',
      since: String(result.data.plan.sinceMs),
    });
    expect(result.data.metadata.zone).toBe(new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone);
  });
  it('preserves an opaque refusal and rejects a read clock changed after dispatch', async () => {
    const refusal = createTradeApi(
      createApiClient({
        fetch: async () => new Response(JSON.stringify({ message: 'Original read unavailable.', code: 'trade.original' }), { status: 503 }),
      }),
      () => now,
    );
    expect(await refusal.zonedDailyHistory('BTC/USDT', 'Asia/Kathmandu')).toMatchObject({
      ok: false,
      reason: 'unreachable',
      code: 'trade.original',
      message: 'Original read unavailable.',
    });
    let clock = now;
    const delayed = createTradeApi(
      createApiClient({
        fetch: async () => {
          clock += 15_001;
          return new Response('[]');
        },
      }),
      () => clock,
    );
    expect(await delayed.zonedDailyHistory('BTC/USDT', 'Asia/Kathmandu')).toMatchObject({
      ok: false,
      reason: 'invalid_response',
      message: expect.stringContaining('local clock'),
    });
  });
});
describe('observed cross-tab daily identity departures', () => {
  it.each([
    ['oldValue-only departure', 'departure', 'same', 'same', true],
    ['unchanged A to A', 'same', 'same', 'same', false],
    ['malformed JSON description', 'malformed-json', 'same', 'same', false],
    ['malformed zone description', 'malformed-zone', 'same', 'same', false],
    ['other storage key', 'departure', 'same', 'other-key', false],
    ['other storage area', 'departure', 'same', 'other-area', false],
    ['malformed oldValue cannot hide valid newValue departure', 'malformed-json', 'departure', 'same', true],
  ] as const)('%s', async (_name, oldKind, newKind, eventKind, retires) => {
    const storageKey = 'intafaced.customer.view.v1';
    const a = JSON.stringify({ dailyStart: 'zoned', dailyZone: 'America/New_York', language: 'en' });
    const b = JSON.stringify({ dailyStart: 'zoned', dailyZone: 'Asia/Kathmandu', language: 'fr' });
    const descriptions = {
      same: a,
      departure: b,
      'malformed-json': '{',
      'malformed-zone': JSON.stringify({ dailyStart: 'zoned', dailyZone: 'Invalid/Choice' }),
    };
    type EventDescription = Pick<StorageEvent, 'key' | 'oldValue' | 'newValue' | 'storageArea'>;
    let listener: ((event: EventDescription) => void) | undefined;
    const storage = { getItem: () => a };
    vi.resetModules();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', {
      addEventListener: (type: string, registered: (event: EventDescription) => void) => {
        if (type === 'storage') listener = registered;
      },
    });
    try {
      const preferences = await import('../../shared/preferences');
      const snapshot = preferences.currentPreferences();
      const capturedEpoch = preferences.currentDailyPreferenceEpoch();
      const dispatch = listener;
      if (!dispatch) throw new Error('Actual preference module did not subscribe to storage');
      dispatch({
        key: eventKind === 'other-key' ? 'unrelated.preference' : storageKey,
        oldValue: descriptions[oldKind],
        newValue: descriptions[newKind],
        storageArea: (eventKind === 'other-area' ? {} : storage) as Storage,
      });
      if (retires) expect(preferences.currentDailyPreferenceEpoch()).toBeGreaterThan(capturedEpoch);
      else expect(preferences.currentDailyPreferenceEpoch()).toBe(capturedEpoch);
      expect(preferences.currentPreferences()).toEqual(snapshot);
      expect(preferences.currentPreferences()).toMatchObject({ dailyStart: 'zoned', dailyZone: 'America/New_York', language: 'en' });
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
