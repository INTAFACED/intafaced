import { describe, expect, it } from 'vitest';
import { AcademyError } from '../errors.js';
import {
  applyCourseStart,
  assertExtensionExtends,
  clearedOrWindow,
  decideRelease,
  findPrerequisiteCycle,
  normalizePrerequisites,
  refuseRelease,
  requireExtensionReason,
} from './access.js';

const from = new Date('2026-10-01T00:00:00.000Z');
const until = new Date('2026-10-20T00:00:00.000Z');
const due = new Date('2026-10-15T00:00:00.000Z');

describe('item release rules', () => {
  it('refuses a prerequisite cycle A to B to A', () => {
    const cycle = findPrerequisiteCycle([
      { itemSlug: 'foundations-order-types', prerequisiteSlug: 'foundations-risk-first' },
      { itemSlug: 'foundations-risk-first', prerequisiteSlug: 'foundations-order-types' },
    ]);
    expect(cycle).toEqual(['foundations-order-types', 'foundations-risk-first', 'foundations-order-types']);
  });

  it('accepts a one-way prerequisite', () => {
    expect(findPrerequisiteCycle([{ itemSlug: 'foundations-order-types', prerequisiteSlug: 'foundations-risk-first' }])).toBeNull();
  });

  it('refuses a self prerequisite before a write', () => {
    expect(() => normalizePrerequisites('foundations-risk-first', ['foundations-risk-first'])).toThrow(AcademyError);
    try {
      normalizePrerequisites('foundations-risk-first', ['foundations-risk-first']);
    } catch (err) {
      expect(err).toMatchObject({ code: 'academy.prerequisite_cycle' });
    }
  });

  it('refuses an availability end that is not after the start', () => {
    expect(() => clearedOrWindow({ availableFrom: until, availableUntil: from, dueAt: null })).toThrow(AcademyError);
    try {
      clearedOrWindow({ availableFrom: until, availableUntil: from, dueAt: null });
    } catch (err) {
      expect(err).toMatchObject({ code: 'academy.window_invalid' });
    }
  });

  it('refuses a window with only one end', () => {
    expect(() => clearedOrWindow({ availableFrom: from, availableUntil: null, dueAt: null })).toThrow(
      expect.objectContaining({ code: 'academy.window_invalid' }),
    );
  });

  it('clears a window only when start, end and due are all absent', () => {
    expect(clearedOrWindow({ availableFrom: null, availableUntil: null, dueAt: null })).toBeNull();
  });

  it('refuses an extension with no reason', () => {
    expect(() => requireExtensionReason('   ')).toThrow(expect.objectContaining({ code: 'academy.reason_required' }));
  });

  it('keeps a trimmed reason', () => {
    expect(requireExtensionReason('  late start  ')).toBe('late start');
  });

  it('locks on a missing prerequisite before a window', () => {
    const decision = decideRelease({
      completed: false,
      started: true,
      missing: ['foundations-risk-first'],
      window: { availableFrom: from, availableUntil: until, dueAt: due },
      extensionUntil: null,
      now: new Date('2026-10-10T00:00:00.000Z'),
    });
    expect(decision).toMatchObject({ state: 'locked', lock: 'prerequisite', missing: ['foundations-risk-first'] });
    expect(() => refuseRelease(decision)).toThrow(expect.objectContaining({ code: 'academy.prerequisite_unmet' }));
  });

  it('locks after the due and opens again only when the extension passes it', () => {
    const window = { availableFrom: from, availableUntil: until, dueAt: due };
    const now = new Date('2026-10-16T00:00:00.000Z');
    expect(decideRelease({ completed: false, started: false, missing: [], window, extensionUntil: null, now }).lock).toBe('window');
    const extended = new Date('2026-10-18T00:00:00.000Z');
    expect(decideRelease({ completed: false, started: false, missing: [], window, extensionUntil: extended, now }).state).toBe('unlocked');
    expect(() => assertExtensionExtends(window, new Date('2026-10-14T00:00:00.000Z'))).toThrow(
      expect.objectContaining({ code: 'academy.window_invalid' }),
    );
  });

  it('does not open an item before the availability start', () => {
    const decision = decideRelease({
      completed: false,
      started: false,
      missing: [],
      window: { availableFrom: from, availableUntil: until, dueAt: null },
      extensionUntil: new Date('2026-11-01T00:00:00.000Z'),
      now: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(decision).toMatchObject({ state: 'locked', lock: 'window' });
  });

  it('reports started only after the item is open, and completed wins', () => {
    const open = decideRelease({
      completed: false,
      started: true,
      missing: [],
      window: null,
      extensionUntil: null,
      now: from,
    });
    expect(open.state).toBe('started');
    const done = decideRelease({
      completed: true,
      started: true,
      missing: ['foundations-risk-first'],
      window: { availableFrom: until, availableUntil: from, dueAt: null },
      extensionUntil: null,
      now: from,
    });
    expect(done).toMatchObject({ state: 'completed', lock: null, missing: [] });
  });

  it('holds an item until its course starts, keeps a completed one, and changes nothing once it has started', () => {
    const start = new Date('2026-10-30T09:00:00.000Z');
    const before = new Date('2026-10-29T09:00:00.000Z');
    const open = { state: 'unlocked', missing: [], lock: null } as const;
    expect(applyCourseStart(open, start, before)).toEqual({ state: 'locked', missing: [], lock: 'window' });
    expect(applyCourseStart({ state: 'locked', missing: ['a'], lock: 'prerequisite' }, start, before)).toMatchObject({ lock: 'window' });
    expect(applyCourseStart({ state: 'completed', missing: [], lock: null }, start, before).state).toBe('completed');
    expect(applyCourseStart(open, start, start)).toBe(open);
    expect(applyCourseStart(open, null, before)).toBe(open);
  });
});
