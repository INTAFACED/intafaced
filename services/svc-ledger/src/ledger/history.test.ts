import { describe, expect, it } from 'vitest';
import { LedgerError, userAvailable } from '@intafaced/ledger-client';
import {
  HISTORY_MAX_ENTRIES,
  HISTORY_PAGE_MAX_LIMIT,
  HistoryCursorInvalidError,
  HistoryPageSocketError,
  HistoryRangeInvalidError,
  HistoryTooLargeError,
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyInputSchema,
  historyPageInputSchema,
  parseHistoryDoorInput,
  parseHistoryRange,
  refuseHistoryCursor,
} from './history.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/**
 * The window rules, and the two refusals, without a database.
 *
 * These are the parts of the history read that decide what an answer MEANS —
 * whether a boundary movement is in or out, and whether "no rows" is a fact or a
 * question that could not be answered. They are pure, so they are tested pure;
 * `history-postgres.test.ts` proves the SQL agrees with them against real rows.
 */
describe('history window', () => {
  it('accepts the ISO timestamps svc-bank actually sends (`Date.toISOString()`)', () => {
    const parsed = historyInputSchema.parse({
      account: userAvailable(USER, 'USDT'),
      from: new Date('2026-07-09T00:00:00.000Z').toISOString(),
      to: new Date('2026-08-08T00:00:00.000Z').toISOString(),
    });

    expect(parsed.from).toBe('2026-07-09T00:00:00.000Z');
    expect(parsed.to).toBe('2026-08-08T00:00:00.000Z');
  });

  it('refuses a timestamp that is not a timestamp, rather than coercing it to Invalid Date', () => {
    // `new Date('last tuesday')` is `Invalid Date`, and every comparison against
    // it is false — so an unvalidated window would match nothing and return an
    // empty history that looks exactly like a quiet month.
    expect(() =>
      historyInputSchema.parse({ account: userAvailable(USER, 'USDT'), from: 'last tuesday', to: '2026-08-08T00:00:00.000Z' }),
    ).toThrow();
  });

  it('treats a zero-width window as legal and empty, not as an error', () => {
    const at = '2026-08-08T00:00:00.000Z';
    const range = parseHistoryRange(at, at);

    // Half-open [t, t) genuinely contains nothing. A caller stepping day by day
    // across a boundary produces one, and refusing it would break the honest case.
    expect(range.from.getTime()).toBe(range.to.getTime());
  });

  it('REFUSES an inverted window instead of answering it with an empty array', () => {
    // The failure this prevents: arguments the wrong way round match no row, so
    // `[]` would be returned and summed and shown to a user as "you spent
    // nothing" — the caller's bug, recorded as a fact about their money.
    expect(() => parseHistoryRange('2026-08-08T00:00:00.000Z', '2026-07-09T00:00:00.000Z')).toThrow(HistoryRangeInvalidError);

    try {
      parseHistoryRange('2026-08-08T00:00:00.000Z', '2026-07-09T00:00:00.000Z');
      expect.unreachable('an inverted window must refuse');
    } catch (err) {
      // It must arrive at svc-bank as a TYPED ledger error carrying a code —
      // `rehydrateLedgerHttpError` only rebuilds a `LedgerError` when the body
      // names one, and a bare Error there is what turns a diagnosable refusal
      // into "bank.post_failed".
      expect(err).toBeInstanceOf(LedgerError);
      expect((err as LedgerError).code).toBe('ledger.history_range_invalid');
    }
  });
});

describe('paged history stays a socket — this door does not invent `after`', () => {
  const window = {
    account: userAvailable(USER, 'USDT'),
    from: '2026-07-09T00:00:00.000Z',
    to: '2026-08-08T00:00:00.000Z',
  };

  it('accepts the window svc-bank actually sends, with no cursor field on the schema', () => {
    const parsed = parseHistoryDoorInput(window);
    expect(parsed).toEqual(window);
    expect(Object.keys(historyInputSchema.shape).sort()).toEqual(['account', 'from', 'to']);
  });

  it('REFUSES `after` rather than stripping it and answering the first window as complete', () => {
    expect(() => parseHistoryDoorInput({ ...window, after: 'entry-1' })).toThrow(HistoryPageSocketError);
    try {
      refuseHistoryCursor({ ...window, after: 'entry-1' });
      expect.unreachable('after must refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerError);
      expect((err as LedgerError).code).toBe('ledger.history_page_socket');
    }
  });

  it('REFUSES `cursor` the same way — another name for the same unserved page', () => {
    expect(() => parseHistoryDoorInput({ ...window, cursor: 'entry-1' })).toThrow(HistoryPageSocketError);
  });
});

describe('the cap is visible, because it refuses', () => {
  it('carries the limit, the account and the window in the refusal a caller reads', () => {
    const range = { from: new Date('2026-07-09T00:00:00.000Z'), to: new Date('2026-08-08T00:00:00.000Z') };
    const err = new HistoryTooLargeError('acct-1', range, HISTORY_MAX_ENTRIES);

    expect(err).toBeInstanceOf(LedgerError);
    expect(err.code).toBe('ledger.history_range_too_large');
    // Actionable, not merely refused: the message says what to do about it.
    expect(err.message).toContain(String(HISTORY_MAX_ENTRIES));
    expect(err.message).toContain('2026-07-09T00:00:00.000Z');
    expect(err.message).toContain('narrower');
  });

  it('states a bound at all — an unbounded read of the money service is the failure mode', () => {
    expect(Number.isInteger(HISTORY_MAX_ENTRIES)).toBe(true);
    expect(HISTORY_MAX_ENTRIES).toBeGreaterThan(0);
  });
});

describe('history page cursor and input (pure)', () => {
  const base = { ownerType: 'user', ownerId: USER, kind: 'available' };

  it('round-trips a position and is opaque base64url', () => {
    const cursor = encodeHistoryCursor({ entryId: '42' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeHistoryCursor(cursor)).toEqual({ entryId: '42' });
  });

  it('refuses anything this door did not issue', () => {
    for (const bad of [
      '',
      '!!',
      'AAAA',
      Buffer.from('v2.0').toString('base64url'),
      Buffer.from('v2.9223372036854775808').toString('base64url'),
      Buffer.from('v1.1.5').toString('base64url'),
    ]) {
      expect(() => decodeHistoryCursor(bad)).toThrow(HistoryCursorInvalidError);
    }
  });

  it('defaults limit to 50 and bounds it 1..200', () => {
    expect(historyPageInputSchema.parse(base).limit).toBe(50);
    expect(historyPageInputSchema.parse({ ...base, limit: HISTORY_PAGE_MAX_LIMIT }).limit).toBe(200);
    for (const limit of [0, 201, -5, 2.5, '10']) expect(() => historyPageInputSchema.parse({ ...base, limit })).toThrow();
  });

  it('holds the owner identifier space like AccountRef does', () => {
    expect(() => historyPageInputSchema.parse({ ...base, ownerId: 'not-a-uuid' })).toThrow();
  });
});
