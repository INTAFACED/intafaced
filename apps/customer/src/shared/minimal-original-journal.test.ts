import { describe, expect, it } from 'vitest';
import { createMinimalOriginalJournal, type JournalLease, type JournalLocks, type JournalStorage } from './minimal-original-journal';

function fixture() {
  const durable = new Map<string, string>(),
    legacy = new Map<string, string>(),
    held = new Set<string>();
  const faults = { get: false, set: false, remove: false, silentSet: false, silentRemove: false, locks: false };
  const durablePort: JournalStorage = {
    getItem: (key) => {
      if (faults.get) throw new Error('Read denied');
      return durable.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (faults.set) throw new Error('Quota');
      if (!faults.silentSet) durable.set(key, value);
    },
    removeItem: (key) => {
      if (faults.remove) throw new Error('Remove denied');
      if (!faults.silentRemove) durable.delete(key);
    },
  };
  const legacyPort: JournalStorage = {
    getItem: (key) => legacy.get(key) ?? null,
    setItem: (key, value) => {
      legacy.set(key, value);
    },
    removeItem: (key) => {
      legacy.delete(key);
    },
  };
  const locks = {
    request: async (name: string, _options: unknown, work: (lock: unknown) => unknown) => {
      if (held.has(name)) return work(null);
      held.add(name);
      try {
        return await work({ name });
      } finally {
        held.delete(name);
      }
    },
  } as JournalLocks;
  const ports = { durable: () => durablePort, legacy: () => legacyPort, locks: () => (faults.locks ? undefined : locks) };
  const journal = (key = 'original') =>
    createMinimalOriginalJournal(
      key,
      (raw) => {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('Invalid feature metadata');
        return value as string[];
      },
      ports,
    );
  return { durable, legacy, faults, journal };
}

describe('Verified minimal original journal', () => {
  it('preserves present raw bytes even when the feature codec returns an empty array', async () => {
    const f = fixture(),
      journal = f.journal();
    expect(journal.read()).toEqual({ status: 'empty' });
    f.durable.set('original', ' [ ] ');
    expect(journal.read()).toEqual({ status: 'present', raw: ' [ ] ', value: [], origin: 'durable' });
    expect(await journal.coordinate(async (lease) => lease.writeExact(null, '["new"]'))).toEqual({
      ok: true,
      value: { ok: false, reason: 'mismatch' },
    });
    expect(f.durable.get('original')).toBe(' [ ] ');
  });
  it('treats read failure and corrupt bytes as unreadable, never empty or overwrite permission', async () => {
    const f = fixture(),
      journal = f.journal();
    f.durable.set('original', '["original"]');
    f.faults.get = true;
    expect(journal.read()).toEqual({ status: 'unreadable', reason: 'read' });
    expect(await journal.coordinate(async (lease) => lease.writeExact(null, '["new"]'))).toEqual({
      ok: true,
      value: { ok: false, reason: 'read' },
    });
    expect(f.durable.get('original')).toBe('["original"]');
    f.faults.get = false;
    f.durable.set('original', '{');
    expect(journal.read()).toEqual({ status: 'unreadable', reason: 'parse' });
    expect(await journal.coordinate(async (lease) => lease.finishExact('{'))).toEqual({ ok: true, value: { ok: false, reason: 'parse' } });
    expect(f.durable.get('original')).toBe('{');
  });
  for (const fault of ['set', 'silentSet'] as const)
    it('retains the surviving legacy original after ' + fault + ' during migration', async () => {
      const f = fixture(),
        journal = f.journal();
      f.legacy.set('original', ' ["legacy"] ');
      f.faults[fault] = true;
      expect(await journal.coordinate(async (lease) => lease.migrateLegacy())).toMatchObject({ ok: true, value: { ok: false } });
      expect(f.legacy.get('original')).toBe(' ["legacy"] ');
      f.faults[fault] = false;
      expect(await journal.coordinate(async (lease) => lease.migrateLegacy())).toEqual({ ok: true, value: { ok: true } });
      expect([f.durable.get('original'), f.legacy.has('original')]).toEqual([' ["legacy"] ', false]);
    });
  it('retains both conflicting stores and exposes only safely decoded originals', async () => {
    const f = fixture(),
      journal = f.journal();
    f.durable.set('original', '["durable"]');
    f.legacy.set('original', '["legacy"]');
    expect(journal.read()).toMatchObject({
      status: 'unreadable',
      reason: 'conflict',
      originals: [{ value: ['durable'] }, { value: ['legacy'] }],
    });
    expect(await journal.coordinate(async (lease) => lease.migrateLegacy())).toEqual({
      ok: true,
      value: { ok: false, reason: 'conflict' },
    });
    expect([f.durable.get('original'), f.legacy.get('original')]).toEqual(['["durable"]', '["legacy"]']);
    f.legacy.set('original', '{');
    expect(journal.read()).toMatchObject({ status: 'unreadable', reason: 'conflict', originals: [{ value: ['durable'] }] });
  });
  for (const fault of ['remove', 'silentRemove'] as const)
    it('does not report exact cleanup complete after ' + fault, async () => {
      const f = fixture(),
        journal = f.journal();
      f.durable.set('original', '["original"]');
      f.faults[fault] = true;
      expect(await journal.coordinate(async (lease) => lease.finishExact('["original"]'))).toMatchObject({
        ok: true,
        value: { ok: false },
      });
      expect(f.durable.get('original')).toBe('["original"]');
      f.faults[fault] = false;
      expect(await journal.coordinate(async (lease) => lease.finishExact('["different"]'))).toEqual({
        ok: true,
        value: { ok: false, reason: 'mismatch' },
      });
      expect(await journal.coordinate(async (lease) => lease.finishExact('["original"]', '[]'))).toEqual({ ok: true, value: { ok: true } });
      expect(journal.read()).toMatchObject({ status: 'present', raw: '[]', value: [] });
    });
  it('rejects leaked leases and refuses missing or busy coordination rather than using a fallback', async () => {
    const f = fixture(),
      journal = f.journal();
    let leaked!: JournalLease<string[]>;
    await journal.coordinate(async (lease) => {
      leaked = lease;
    });
    expect(leaked.writeExact(null, '["stale"]')).toEqual({ ok: false, reason: 'inactive' });
    expect(leaked.read()).toEqual({ status: 'unreadable', reason: 'inactive' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = journal.coordinate(async (lease) => {
      const result = lease.writeExact(null, '["first"]');
      await held;
      return result;
    });
    expect(await f.journal().coordinate(async (lease) => lease.writeExact(null, '["second"]'))).toEqual({ ok: false, reason: 'busy' });
    expect(await f.journal('other-owner').coordinate(async (lease) => lease.writeExact(null, '["valid"]'))).toEqual({
      ok: true,
      value: { ok: true },
    });
    release();
    expect(await first).toEqual({ ok: true, value: { ok: true } });
    f.faults.locks = true;
    expect(await journal.coordinate(async (lease) => lease.finishExact('["first"]'))).toEqual({ ok: false, reason: 'locks-unavailable' });
    expect(journal.read()).toMatchObject({ status: 'present', value: ['first'] });
  });
});
