export type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type JournalLocks = Pick<LockManager, 'request'>;
export type JournalProblem =
  | 'storage-unavailable'
  | 'read'
  | 'parse'
  | 'conflict'
  | 'write'
  | 'readback'
  | 'remove'
  | 'mismatch'
  | 'inactive'
  | 'locks-unavailable'
  | 'busy';
type Original<T> = { raw: string; value: T; origin: 'durable' | 'legacy' | 'both' };
export type JournalRead<T> =
  { status: 'empty' } | ({ status: 'present' } & Original<T>) | { status: 'unreadable'; reason: JournalProblem; originals?: Original<T>[] };
export type JournalResult = { ok: true } | { ok: false; reason: JournalProblem };
export type JournalLease<T> = {
  read(): JournalRead<T>;
  migrateLegacy(): JournalResult;
  writeExact(expectedRaw: string | null, nextRaw: string): JournalResult;
  finishExact(originalRaw: string, nextRaw?: string | null): JournalResult;
};
export type JournalPorts = {
  durable(): JournalStorage | undefined;
  legacy?(): JournalStorage | undefined;
  locks(): JournalLocks | undefined;
};

/** Stores original operation metadata, with no knowledge of money or settlement.
 * The feature supplies its strict codec and the proof for any exact cleanup.
 * Native Web Locks serialize cooperating tabs; verified bytes remain the admission gate.
 */
export function createMinimalOriginalJournal<T>(key: string, decode: (raw: string) => T, ports: JournalPorts) {
  function storage() {
    try {
      const durable = ports.durable();
      const legacy = ports.legacy?.();
      return durable ? { durable, legacy } : null;
    } catch {
      return null;
    }
  }
  function read(): JournalRead<T> {
    const stores = storage();
    if (!stores) return { status: 'unreadable', reason: 'storage-unavailable' };
    let durable: string | null, legacy: string | null;
    try {
      durable = stores.durable.getItem(key);
      legacy = stores.legacy?.getItem(key) ?? null;
    } catch {
      return { status: 'unreadable', reason: 'read' };
    }
    try {
      if (durable === null && legacy === null) return { status: 'empty' };
      if (durable !== null && legacy !== null && durable !== legacy) {
        const originals: Original<T>[] = [];
        for (const [raw, origin] of [
          [durable, 'durable'],
          [legacy, 'legacy'],
        ] as const) {
          try {
            originals.push({ raw, value: decode(raw), origin });
          } catch {
            /* Keep bytes; expose only decoded references. */
          }
        }
        return { status: 'unreadable', reason: 'conflict', originals };
      }
      const raw = durable ?? legacy!;
      return { status: 'present', raw, value: decode(raw), origin: durable === null ? 'legacy' : legacy === null ? 'durable' : 'both' };
    } catch {
      return { status: 'unreadable', reason: 'parse' };
    }
  }
  async function coordinate<R>(
    work: (lease: JournalLease<T>) => Promise<R>,
  ): Promise<{ ok: true; value: R } | { ok: false; reason: JournalProblem }> {
    let locks: JournalLocks | undefined;
    try {
      locks = ports.locks();
    } catch {
      /* Unavailable coordination refuses admission. */
    }
    if (!locks) return { ok: false, reason: 'locks-unavailable' };
    try {
      return await locks.request(`intafaced.original:${key}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) return { ok: false as const, reason: 'busy' as const };
        let active = true;
        const unavailable = (): JournalResult | null => (!active ? { ok: false, reason: 'inactive' } : null);
        function migrateLegacy(): JournalResult {
          const stopped = unavailable();
          if (stopped) return stopped;
          const original = read();
          if (original.status === 'unreadable') return { ok: false, reason: original.reason };
          if (original.status === 'empty' || original.origin === 'durable') return { ok: true };
          const stores = storage();
          if (!stores?.legacy) return { ok: false, reason: 'storage-unavailable' };
          try {
            if (original.origin === 'legacy') stores.durable.setItem(key, original.raw);
          } catch {
            return { ok: false, reason: 'write' };
          }
          const saved = read();
          if (saved.status !== 'present' || saved.raw !== original.raw || saved.origin !== 'both')
            return { ok: false, reason: saved.status === 'unreadable' ? saved.reason : 'readback' };
          try {
            // Recheck both stores before deleting the surviving legacy original.
            if (stores.durable.getItem(key) !== original.raw || stores.legacy.getItem(key) !== original.raw)
              return { ok: false, reason: 'mismatch' };
            stores.legacy.removeItem(key);
            if (stores.legacy.getItem(key) !== null || stores.durable.getItem(key) !== original.raw)
              return { ok: false, reason: 'readback' };
          } catch {
            return { ok: false, reason: 'remove' };
          }
          return { ok: true };
        }
        function replace(expectedRaw: string | null, nextRaw: string | null): JournalResult {
          const stopped = unavailable();
          if (stopped) return stopped;
          if (nextRaw !== null) {
            try {
              decode(nextRaw);
            } catch {
              return { ok: false, reason: 'parse' };
            }
          }
          const migrated = migrateLegacy();
          if (!migrated.ok) return migrated;
          const original = read();
          if (original.status === 'unreadable') return { ok: false, reason: original.reason };
          if ((original.status === 'empty' ? null : original.raw) !== expectedRaw) return { ok: false, reason: 'mismatch' };
          const stores = storage();
          if (!stores) return { ok: false, reason: 'storage-unavailable' };
          try {
            if (nextRaw === null) stores.durable.removeItem(key);
            else stores.durable.setItem(key, nextRaw);
          } catch {
            return { ok: false, reason: nextRaw === null ? 'remove' : 'write' };
          }
          const saved = read();
          if (saved.status === 'unreadable') return { ok: false, reason: saved.reason };
          return (saved.status === 'empty' ? null : saved.raw) === nextRaw ? { ok: true } : { ok: false, reason: 'readback' };
        }
        const lease: JournalLease<T> = {
          read: () => (active ? read() : { status: 'unreadable', reason: 'inactive' }),
          migrateLegacy,
          writeExact: (expected, next) => replace(expected, next),
          finishExact: (original, next = null) => replace(original, next),
        };
        try {
          return { ok: true as const, value: await work(lease) };
        } finally {
          active = false;
        }
      });
    } catch {
      return { ok: false, reason: 'locks-unavailable' };
    }
  }
  return { read, coordinate };
}
