import { afterEach, describe, expect, it, vi } from 'vitest';
import { freezeEventKey, MemoryPostingFreeze, type FreezeState } from './freeze.js';

/**
 * A THAW MUST NOT BE MISTAKEN FOR THE FREEZE THAT PRECEDED IT.
 *
 * STOP §4.2b #7. `posting_freeze.changed_at` is a `timestamptz` — microseconds.
 * The freeze event's idempotency key was built from `changedAt.toISOString()`,
 * and a JavaScript `Date` holds MILLISECONDS. Two state changes inside one
 * millisecond therefore produced the same `msgID`, and a JetStream stream with
 * duplicate-detection on drops the second one.
 *
 * The second one is the THAW. Every consumer of `ledgerFreezeUpdated` — every
 * dashboard, every alarm, every module deciding whether the book is open — then
 * holds "the platform is frozen" while the database says it is open, and nothing
 * anywhere reports an error, because from the bus's point of view the publish
 * succeeded and the duplicate was correctly suppressed.
 *
 * These run without Postgres on purpose. The defect is in the CHOICE OF INPUT,
 * not in the database, so the test that proves it should not be skippable on a
 * machine with no container runtime — which is where it was written.
 */
describe('the freeze event identity (STOP §4.2b #7)', () => {
  /** The two halves of one same-millisecond freeze→thaw pair, as Postgres renders them. */
  const FROZEN_AT = '2026-08-08 01:23:45.123456+00';
  const THAWED_AT = '2026-08-08 01:23:45.123999+00';

  function state(precise: string, frozen: boolean): FreezeState {
    return {
      frozen,
      reason: frozen ? 'reconciliation mismatch' : null,
      actor: 'reconciliation',
      // Deliberately the SAME millisecond for both — this is the collision.
      changedAt: new Date('2026-08-08T01:23:45.123Z'),
      changedAtPrecise: precise,
    };
  }

  it('THE DEFECT: a freeze and a thaw 543µs apart get different keys', () => {
    const freeze = freezeEventKey(state(FROZEN_AT, true));
    const thaw = freezeEventKey(state(THAWED_AT, false));

    expect(freeze).not.toBe(thaw);

    // And the reason the old key could not tell them apart: both round to the
    // same millisecond, so both produced this exact string.
    const oldKey = (s: FreezeState) => `ledger.freeze:${s.changedAt.toISOString()}`;
    expect(oldKey(state(FROZEN_AT, true))).toBe(oldKey(state(THAWED_AT, false)));
  });

  it('carries the database text verbatim — no reformatting to re-lose the precision', () => {
    // If anyone "tidies" this into a Date and back, the assertion above starts
    // passing for the wrong reason. Pin the actual bytes.
    expect(freezeEventKey(state(FROZEN_AT, true))).toBe(`ledger.freeze:${FROZEN_AT}`);
  });

  it('is stable for the same state change — it is still an idempotency key', () => {
    expect(freezeEventKey(state(FROZEN_AT, true))).toBe(freezeEventKey(state(FROZEN_AT, true)));
  });
});

describe('MemoryPostingFreeze inside one millisecond', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives a freeze and the thaw after it different keys, and a same-actor re-freeze keeps its key', () => {
    vi.useFakeTimers({ now: new Date('2026-08-08T01:23:45.123Z') });
    const book = new MemoryPostingFreeze();
    const frozen = book.freeze('reconciliation mismatch', 'reconciliation');
    const again = book.freeze('reconciliation mismatch', 'reconciliation');
    const thawed = book.unfreeze('ops-clear', 'ops-confirm');

    expect(frozen.changedAt.getTime()).toBe(thawed.changedAt.getTime());
    expect(freezeEventKey(frozen)).toBe(`ledger.freeze:${frozen.changedAtPrecise}`);
    expect(freezeEventKey(thawed)).toBe(`ledger.freeze:${thawed.changedAtPrecise}`);
    // A Date round-trip is only milliseconds, so it must not be how this text is rebuilt.
    expect(frozen.changedAtPrecise).not.toBe(new Date(frozen.changedAtPrecise).toISOString());
    expect(thawed.changedAtPrecise).not.toBe(new Date(thawed.changedAtPrecise).toISOString());
    expect(freezeEventKey(frozen)).not.toBe(freezeEventKey(thawed));
    expect(freezeEventKey(again)).toBe(freezeEventKey(frozen));
    expect(again.changedAtPrecise).toBe(frozen.changedAtPrecise);
  });
});
