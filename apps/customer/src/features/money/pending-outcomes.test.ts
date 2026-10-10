import { describe, expect, it } from 'vitest';
import { createBankOriginalRecovery, originalRecordRefs, pendingKey } from './pending-outcomes';
import type { JournalLocks, JournalStorage } from '../../shared/minimal-original-journal';

const owner = '10000000-0000-4000-8000-000000000001';
const first = {
  reference: '20000000-0000-4000-8000-000000000001',
  title: 'Transfer',
  procedure: 'transfer.create',
  recordRefs: { transferId: '30000000-0000-4000-8000-000000000001' },
};
const second = { ...first, reference: '20000000-0000-4000-8000-000000000002' };
function fixture() {
  const durable = new Map<string, string>(),
    legacy = new Map<string, string>(),
    held = new Set<string>();
  const fault = { get: false, set: false, silent: false, legacyRemove: false, locks: false };
  const port = (map: Map<string, string>, old = false): JournalStorage => ({
    getItem: (key) => {
      if (fault.get && !old) throw new Error('Read denied');
      return map.get(key) ?? null;
    },
    setItem: (key, raw) => {
      if (fault.set && !old) throw new Error('Quota');
      if (!fault.silent || old) map.set(key, raw);
    },
    removeItem: (key) => {
      if (fault.legacyRemove && old) throw new Error('Removal denied');
      map.delete(key);
    },
  });
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
  const ports = { durable: () => port(durable), legacy: () => port(legacy, true), locks: () => (fault.locks ? undefined : locks) };
  return { durable, legacy, held, fault, recovery: (id = owner) => createBankOriginalRecovery(id, ports) };
}

describe('Bank original recovery through the shared journal', () => {
  it('admits a known current original, survives a new adapter and only clears its exact reservation', async () => {
    const f = fixture(),
      a = f.recovery();
    const saved = await a.reserve(first, () => true);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(f.recovery().read()).toEqual([first]);
    await expect(f.recovery().reserve(second, () => true)).rejects.toMatchObject({ reason: 'unresolved' });
    await a.finish(saved, () => true);
    expect(f.durable.get(pendingKey(owner))).toBe('[]');
    const replacement = await a.reserve(second, () => true);
    await expect(a.finish(saved, () => true)).rejects.toMatchObject({ reason: 'mismatch' });
    expect(a.read()).toEqual([second]);
    await a.finish(replacement, () => true);
    expect(a.read()).toEqual([]);
  });
  for (const raw of ['[]', ' [ ] '])
    it('handles the existing empty-array schema without assuming absent bytes: ' + raw, async () => {
      const f = fixture();
      f.durable.set(pendingKey(owner), raw);
      expect(f.recovery().read()).toEqual([]);
      const saved = await f.recovery().reserve(first, () => true);
      expect(saved.raw).toBe(JSON.stringify([first]));
      expect(f.recovery().read()).toEqual([first]);
    });
  for (const failure of ['get', 'set', 'silent'] as const)
    it('refuses unreadable, quota or unretained storage: ' + failure, async () => {
      const f = fixture();
      f.fault[failure] = true;
      await expect(f.recovery().reserve(first, () => true)).rejects.toHaveProperty('reason');
      expect(f.durable.has(pendingKey(owner))).toBe(false);
      if (failure === 'get') expect(f.recovery().read()[0]?.reference).toBe('unreadable');
    });
  it('does not overwrite corrupt or private/unrecognized metadata', async () => {
    const f = fixture();
    for (const raw of [
      '{',
      JSON.stringify([{ ...first, amount: '1' }]),
      JSON.stringify([{ ...first, recordRefs: { recipient: 'private' } }]),
    ]) {
      f.durable.set(pendingKey(owner), raw);
      expect(f.recovery().read()[0]?.reference).toBe('unreadable');
      await expect(f.recovery().reserve(second, () => true)).rejects.toMatchObject({ reason: 'parse' });
      expect(f.durable.get(pendingKey(owner))).toBe(raw);
    }
  });
  it('migrates exact surviving legacy bytes only after verified durable readback', async () => {
    const f = fixture(),
      key = pendingKey(owner),
      raw = ' ' + JSON.stringify([first]) + ' ';
    f.legacy.set(key, raw);
    f.fault.silent = true;
    await expect(f.recovery().restore()).rejects.toHaveProperty('reason');
    expect(f.legacy.get(key)).toBe(raw);
    f.fault.silent = false;
    f.fault.legacyRemove = true;
    await expect(f.recovery().restore()).rejects.toMatchObject({ reason: 'remove' });
    expect([f.durable.get(key), f.legacy.get(key)]).toEqual([raw, raw]);
    f.fault.legacyRemove = false;
    await f.recovery().restore();
    expect([f.durable.get(key), f.legacy.has(key)]).toEqual([raw, false]);
    expect(f.recovery().read()).toEqual([first]);
  });
  it('preserves conflicting safe references, including different records with the same reference', async () => {
    const f = fixture(),
      key = pendingKey(owner),
      other = { ...first, recordRefs: { loanId: 'original-loan' } };
    const durable = JSON.stringify([first]),
      legacy = JSON.stringify([other]);
    f.durable.set(key, durable);
    f.legacy.set(key, legacy);
    expect(f.recovery().read().slice(1)).toEqual([first, other]);
    await expect(f.recovery().restore()).rejects.toMatchObject({ reason: 'conflict' });
    await expect(f.recovery().reserve(second, () => true)).rejects.toMatchObject({ reason: 'conflict' });
    expect([f.durable.get(key), f.legacy.get(key)]).toEqual([durable, legacy]);
  });
  it('keeps an original when known cleanup fails or loses its original context', async () => {
    const f = fixture(),
      recovery = f.recovery(),
      saved = await recovery.reserve(first, () => true);
    f.fault.set = true;
    await expect(recovery.finish(saved, () => true)).rejects.toMatchObject({ reason: 'write' });
    f.fault.set = false;
    await expect(recovery.finish(saved, () => false)).rejects.toMatchObject({ reason: 'stale' });
    expect(recovery.read()).toEqual([first]);
    await expect(f.recovery('different-owner').finish(saved, () => true)).rejects.toMatchObject({ reason: 'owner' });
    expect(recovery.read()).toEqual([first]);
    await recovery.finish(saved, () => true);
    expect(recovery.read()).toEqual([]);
  });
  it('refuses same-owner busy/missing coordination while an independent owner remains usable', async () => {
    const f = fixture();
    f.held.add('intafaced.original:' + pendingKey(owner));
    await expect(f.recovery().reserve(first, () => true)).rejects.toMatchObject({ reason: 'busy' });
    await f.recovery('different-owner').reserve(second, () => true);
    expect(f.recovery('different-owner').read()).toEqual([second]);
    f.held.clear();
    f.fault.locks = true;
    await expect(f.recovery().reserve(first, () => true)).rejects.toMatchObject({ reason: 'locks-unavailable' });
    expect(f.recovery().read()).toEqual([]);
  });
  it('excludes reviewed amounts, recipient text and other private terms from original references', () => {
    expect(
      originalRecordRefs({
        transferId: first.recordRefs.transferId,
        amount: '0.000000000000000001',
        recipient: 'private',
        token: 'private',
      }),
    ).toEqual(first.recordRefs);
  });
});
