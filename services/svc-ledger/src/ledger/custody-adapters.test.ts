import { describe, expect, it, vi } from 'vitest';
import {
  ADAPTER_IS_NOT_BOOK,
  BREAK_AUTO_CLEAR_REFUSED,
  CUSTODY_AGE_MISSING,
  CUSTODY_AMOUNTS_MISSING,
  CUSTODY_BREAK_ID_MISSING,
  OFF_EXCHANGE_OWNER_UNSET,
  handleCustody,
} from './custody-adapters.js';

function atClock<T>(iso: string, run: () => T): T {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
  try {
    return run();
  } finally {
    vi.useRealTimers();
  }
}

describe('CARD G-custody adapters, aging breaks, off-exchange OWNER', () => {
  it('keeps a chain adapter as an adapter, never the book', () => {
    const out = handleCustody({
      kind: 'chain',
      treatAsBook: true,
      adapterAmount: '12.5',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(ADAPTER_IS_NOT_BOOK);
    expect(out.role).toBe('adapter');
    expect(out.kind).toBe('chain');
  });

  it('keeps a fiat adapter as an adapter when role is claimed as book', () => {
    const out = handleCustody({
      kind: 'fiat',
      role: 'book',
      adapterAmount: '80',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(ADAPTER_IS_NOT_BOOK);
    expect(out.role).toBe('adapter');
  });

  it('observes a chain adapter amount as a string and does not post', () => {
    const out = handleCustody({
      kind: 'chain',
      role: 'adapter',
      adapterAmount: '12.50',
    });
    expect(out).toEqual({
      ok: true,
      kind: 'chain',
      role: 'adapter',
      observed: '12.5',
    });
  });

  it('refuses a missing adapter observation rather than inventing 0', () => {
    const out = handleCustody({ kind: 'fiat', role: 'adapter' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(CUSTODY_AMOUNTS_MISSING);
    expect(JSON.stringify(out)).not.toMatch(/"observed":"0"/);
  });

  it('refuses off-exchange custody until OWNER authorizes the product', () => {
    const unset = handleCustody({ kind: 'off_exchange' });
    expect(unset.ok).toBe(false);
    if (unset.ok) return;
    expect(unset.reason).toBe(OFF_EXCHANGE_OWNER_UNSET);
    expect(JSON.stringify(unset)).not.toMatch(/"observed"/);
  });

  it('ages an open break from the clock and refuses auto-clear', () => {
    const aged = atClock('2026-09-02T00:00:00.000Z', () =>
      handleCustody({
        kind: 'break',
        breakId: 'brk-1',
        adapterAmount: '12',
        bookAmount: '10',
        firstSeenAt: '2026-09-01T00:00:00.000Z',
        now: '2026-10-01T00:00:00.000Z',
      }),
    );
    expect(aged.ok).toBe(true);
    if (!aged.ok || aged.kind !== 'break') return;
    expect(aged.status).toBe('open');
    expect(aged.ageMs).toBe(86_400_000);
    expect(aged.difference).toBe('2');

    const auto = atClock('2026-09-03T00:00:00.000Z', () =>
      handleCustody({
        kind: 'break',
        breakId: 'brk-1',
        adapterAmount: '10',
        bookAmount: '10',
        firstSeenAt: '2026-09-01T00:00:00.000Z',
        now: '2026-09-01T00:00:00.000Z',
        autoClear: true,
      }),
    );
    expect(auto.ok).toBe(false);
    if (auto.ok) return;
    expect(auto.reason).toBe(BREAK_AUTO_CLEAR_REFUSED);
    expect(auto.ageMs).toBe(172_800_000);
    expect(auto.breakId).toBe('brk-1');
  });

  it('refuses resolve=auto even when amounts later match', () => {
    const out = atClock('2026-09-01T00:00:00.000Z', () =>
      handleCustody({
        kind: 'break',
        breakId: 'brk-2',
        adapterAmount: '7',
        bookAmount: '7',
        firstSeenAt: '2026-08-01T00:00:00.000Z',
        now: '2026-08-01T00:00:00.000Z',
        resolve: 'auto',
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(BREAK_AUTO_CLEAR_REFUSED);
    expect(out.ageMs).toBeGreaterThan(0);
  });

  it('lets an operator resolve a break and still reports the difference as a string', () => {
    const out = atClock('2026-09-01T01:00:00.000Z', () =>
      handleCustody({
        kind: 'break',
        breakId: 'brk-3',
        adapterAmount: '5',
        bookAmount: '5',
        firstSeenAt: '2026-09-01T00:00:00.000Z',
        now: '2026-09-09T00:00:00.000Z',
        resolve: 'operator',
      }),
    );
    expect(out).toMatchObject({
      ok: true,
      kind: 'break',
      status: 'resolved',
      ageMs: 3_600_000,
      breakId: 'brk-3',
      difference: '0',
    });
    if (!out.ok || out.kind !== 'break') return;
    expect(typeof out.difference).toBe('string');
  });

  it('refuses a break with missing amounts rather than healing it to 0', () => {
    const out = atClock('2026-09-01T00:10:00.000Z', () =>
      handleCustody({
        kind: 'break',
        breakId: 'brk-4',
        firstSeenAt: '2026-09-01T00:00:00.000Z',
        now: '2026-09-02T00:00:00.000Z',
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(CUSTODY_AMOUNTS_MISSING);
    expect(out.ageMs).toBe(600_000);
    expect(JSON.stringify(out)).not.toMatch(/"difference":"0"/);
  });

  it('refuses a missing, unparseable, or future firstSeenAt instead of aging the break as new', () => {
    const missing = handleCustody({
      kind: 'break',
      breakId: 'brk-age',
      adapterAmount: '12',
      bookAmount: '10',
      now: '2026-09-02T00:00:00.000Z',
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe(CUSTODY_AGE_MISSING);
    expect(missing.kind).toBe('break');
    expect(missing.breakId).toBe('brk-age');
    expect(missing.ageMs).toBeUndefined();
    expect(JSON.stringify(missing)).not.toMatch(/"ageMs"/);
    expect(JSON.stringify(missing)).not.toMatch(/"status":"open"/);
    expect(JSON.stringify(missing)).not.toMatch(/"difference"/);

    const unparseable = handleCustody({
      kind: 'break',
      breakId: 'brk-age',
      adapterAmount: '12',
      bookAmount: '10',
      firstSeenAt: 'not-a-timestamp',
      now: '2026-09-02T00:00:00.000Z',
    });
    expect(unparseable.ok).toBe(false);
    if (unparseable.ok) return;
    expect(unparseable.reason).toBe(CUSTODY_AGE_MISSING);
    expect(unparseable.ageMs).toBeUndefined();
    expect(JSON.stringify(unparseable)).not.toMatch(/"status":"open"/);

    const future = atClock('2026-09-01T00:00:00.000Z', () =>
      handleCustody({
        kind: 'break',
        breakId: 'brk-age',
        adapterAmount: '12',
        bookAmount: '10',
        firstSeenAt: '2026-09-02T00:00:00.000Z',
        now: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(future.ok).toBe(false);
    if (future.ok) return;
    expect(future.reason).toBe(CUSTODY_AGE_MISSING);
    expect(future.ageMs).toBeUndefined();
    expect(JSON.stringify(future)).not.toMatch(/"ageMs":0/);
    expect(JSON.stringify(future)).not.toMatch(/"status":"open"/);
  });

  it('refuses a missing or blank breakId instead of sharing one unset id', () => {
    const seen = '2026-09-01T00:00:00.000Z';
    const clock = '2026-09-02T00:00:00.000Z';
    const unidentified = [undefined, '', '   ', '\n\t'] as const;

    const opened = unidentified.map((breakId) =>
      atClock(clock, () =>
        handleCustody({
          kind: 'break',
          ...(breakId !== undefined ? { breakId } : {}),
          adapterAmount: '12',
          bookAmount: '10',
          firstSeenAt: seen,
          now: '2026-10-01T00:00:00.000Z',
        }),
      ),
    );
    const resolved = unidentified.map((breakId) =>
      atClock(clock, () =>
        handleCustody({
          kind: 'break',
          ...(breakId !== undefined ? { breakId } : {}),
          adapterAmount: '5',
          bookAmount: '5',
          firstSeenAt: seen,
          now: '2026-09-09T00:00:00.000Z',
          resolve: 'operator',
        }),
      ),
    );

    for (const out of [...opened, ...resolved]) {
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe(CUSTODY_BREAK_ID_MISSING);
      expect(out.kind).toBe('break');
      expect(out.breakId).toBeUndefined();
      const body = JSON.stringify(out);
      expect(body).not.toMatch(/unset/);
      expect(body).not.toMatch(/"breakId"/);
      expect(body).not.toMatch(/"status":"open"/);
      expect(body).not.toMatch(/"status":"resolved"/);
      expect(body).not.toMatch(/"difference"/);
    }

    const ids = [...opened, ...resolved].map((out) => (out.ok ? undefined : out.breakId));
    expect(new Set(ids)).toEqual(new Set([undefined]));

    const agedBlank = handleCustody({
      kind: 'break',
      breakId: ' ',
      adapterAmount: '12',
      bookAmount: '10',
      now: '2026-09-02T00:00:00.000Z',
    });
    expect(agedBlank.ok).toBe(false);
    if (agedBlank.ok) return;
    expect(agedBlank.reason).toBe(CUSTODY_AGE_MISSING);
    expect(agedBlank.breakId).toBeUndefined();
    expect(JSON.stringify(agedBlank)).not.toMatch(/unset/);
    expect(JSON.stringify(agedBlank)).not.toMatch(/"status":"open"/);

    const amountsBlank = atClock(clock, () =>
      handleCustody({
        kind: 'break',
        breakId: '',
        firstSeenAt: seen,
        now: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(amountsBlank.ok).toBe(false);
    if (amountsBlank.ok) return;
    expect(amountsBlank.reason).toBe(CUSTODY_AMOUNTS_MISSING);
    expect(amountsBlank.breakId).toBeUndefined();
    expect(JSON.stringify(amountsBlank)).not.toMatch(/unset/);
    expect(JSON.stringify(amountsBlank)).not.toMatch(/"difference"/);
  });
});
