import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../shared/api';
import type { JournalPorts } from '../../shared/minimal-original-journal';
import { createMoreActionJournal, moreJournalPorts, morePendingKey } from './more-action-journal';
import { moreActionCopy } from './more-action-copy';

const key = morePendingKey('owner', 'market'),
  marker = { id: 'original-id', title: 'Original public title', reference: 'original-ref' };
const raw = JSON.stringify(marker),
  success: ApiResult<unknown> = { ok: true, data: { id: marker.reference, status: 'settled' } };
const uncertain: ApiResult<unknown> = { ok: false, reason: 'uncertain', message: 'Original opaque service message' };
function fixture(initial: string | null = null) {
  let value = initial,
    held = false,
    readFails = false,
    writeFails = false,
    removeFails = false,
    silent = false;
  const writes: Array<string | null> = [];
  const storage = {
    getItem: () => {
      if (readFails) throw new Error('read');
      return value;
    },
    setItem: (_key: string, next: string) => {
      if (writeFails) throw new Error('write');
      writes.push(next);
      if (!silent) value = next;
    },
    removeItem: () => {
      if (removeFails) throw new Error('remove');
      writes.push(null);
      if (!silent) value = null;
    },
  };
  const names: string[] = [];
  const locks = {
    request: vi.fn(async (name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
      names.push(name);
      if (held) return run(null);
      held = true;
      try {
        return await run({ name });
      } finally {
        held = false;
      }
    }),
  } as unknown as LockManager;
  const ports: JournalPorts = { durable: () => storage, locks: () => locks };
  const model = createMoreActionJournal(key, ports);
  return {
    model,
    ports,
    writes,
    names,
    storage,
    get: () => value,
    replace: (next: string | null) => {
      value = next;
    },
    faults: (change: { read?: boolean; write?: boolean; remove?: boolean; silent?: boolean }) => {
      readFails = change.read ?? readFails;
      writeFails = change.write ?? writeFails;
      removeFails = change.remove ?? removeFails;
      silent = change.silent ?? silent;
    },
  };
}
const live = () => true;
describe('More original admission and caller-owned proof', () => {
  it('preserves existing raw under getItem-only failure before any write/run', async () => {
    const f = fixture(raw);
    f.faults({ read: true });
    const run = vi.fn();
    expect(f.model.inspect(live).saved.status).toBe('unreadable');
    expect((await f.model.execute(marker, run, live, live)).ok).toBe(false);
    expect(f.get()).toBe(raw);
    expect(f.writes).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['', 'not-json', '{}', JSON.stringify({ ...marker, operation: 'different' }), JSON.stringify({ ...marker, reference: 7 })])(
    'refuses corrupt/unknown metadata without replacing bytes %s',
    async (saved) => {
      const f = fixture(saved),
        run = vi.fn();
      expect(f.model.inspect(live).saved.status).toBe('unreadable');
      await f.model.execute(marker, run, live, live);
      expect(f.get()).toBe(saved);
      expect(f.writes).toEqual([]);
      expect(run).not.toHaveBeenCalled();
    },
  );
  it.each(['write', 'silent'] as const)('verifies admission with %s failure', async (fault) => {
    const f = fixture();
    f.faults({ [fault]: true });
    const run = vi.fn();
    expect((await f.model.execute(marker, run, live, live)).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(f.get()).toBeNull();
  });
  it('writes only minimal public metadata and preserves uncertain original', async () => {
    const f = fixture();
    const result = await f.model.execute(
      marker,
      async (guard) => {
        expect(guard()).toBe(true);
        expect(f.get()).toBe(raw);
        return uncertain;
      },
      live,
      live,
    );
    expect(result).toBe(uncertain);
    expect(f.get()).toBe(raw);
    expect(f.model.inspect(live).known).toBeNull();
  });
  it('does not clean changed bytes with the same marker id/reference', async () => {
    const f = fixture(),
      changed = JSON.stringify({ ...marker, title: 'Later original' });
    const result = await f.model.execute(
      marker,
      async () => {
        f.replace(changed);
        return success;
      },
      live,
      live,
    );
    expect(result.ok).toBe(false);
    expect(f.get()).toBe(changed);
  });
  it('keeps legacy whitespace bytes through failed feature recovery', async () => {
    const legacy = ' { "title": "Public title", "reference": "original-ref", "id": "legacy" } ';
    const f = fixture(legacy),
      read = vi.fn(async () => uncertain);
    expect(await f.model.recover(legacy, read, live, live)).toBe(uncertain);
    expect(read).toHaveBeenCalledWith('original-ref');
    expect(f.get()).toBe(legacy);
    expect(f.writes).toEqual([]);
  });
  it('keeps unknown without inventing a recover capability', async () => {
    const f = fixture(JSON.stringify({ id: 'legacy', title: 'Earlier request' })),
      read = vi.fn();
    await f.model.recover(f.get()!, read, live, live);
    expect(read).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it('holds the same key lease through asynchronous recovery proof and exact cleanup', async () => {
    const f = fixture(raw),
      peer = createMoreActionJournal(key, f.ports);
    let release!: (result: ApiResult<unknown>) => void;
    const held = f.model.recover(
      raw,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      live,
      live,
    );
    const run = vi.fn();
    expect((await peer.execute(marker, run, live, live)).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(f.get()).toBe(raw);
    release(success);
    expect((await held).ok).toBe(true);
    expect(f.get()).toBeNull();
  });
  it('retired held review cannot publish success or clear its original', async () => {
    const f = fixture();
    let current = true,
      release!: (result: ApiResult<unknown>) => void;
    const held = f.model.execute(
      marker,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      () => current,
      live,
    );
    current = false;
    release(success);
    expect((await held).ok).toBe(false);
    expect(f.get()).toBe(raw);
  });
  it('retired original A cannot read or clear B', async () => {
    const f = fixture(raw),
      read = vi.fn();
    f.replace(JSON.stringify({ ...marker, id: 'later-id' }));
    expect((await f.model.recover(raw, read, live, live)).ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(f.get()).toContain('later-id');
  });
  it('keeps immutable known response when removal fails and retries locally only', async () => {
    const f = fixture();
    f.faults({ remove: true });
    const run = vi.fn(async () => success);
    expect((await f.model.execute(marker, run, live, live)).ok).toBe(true);
    const proof = f.model.inspect(live).known!;
    expect(proof).toBeTruthy();
    expect(Object.isFrozen(proof)).toBe(true);
    expect(proof.result.ok && Object.isFrozen(proof.result.data)).toBe(true);
    expect(f.get()).toBe(raw);
    expect(await f.model.cleanup(proof, live)).toBe(false);
    f.faults({ remove: false });
    expect(await f.model.cleanup(proof, live)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.get()).toBeNull();
    expect(f.model.inspect(live).known).toBeNull();
  });
  it('keeps a terminal refusal as refusal during cleanup failure', async () => {
    const f = fixture();
    f.faults({ remove: true });
    const refused = { ok: false as const, reason: 'forbidden' as const, message: 'Opaque refusal' };
    expect(await f.model.execute(marker, async () => refused, live, live)).toBe(refused);
    expect(f.model.inspect(live).known?.result.ok).toBe(false);
    expect(f.get()).toBe(raw);
  });
  it('cannot use old known cleanup against later bytes and cannot resurrect a forgotten proof', async () => {
    const f = fixture();
    f.faults({ remove: true });
    await f.model.execute(marker, async () => success, live, live);
    const proof = f.model.inspect(live).known!;
    f.replace(JSON.stringify({ ...marker, id: 'later' }));
    expect(f.model.inspect(live).known).toBeNull();
    f.replace(raw);
    f.faults({ remove: false });
    expect(await f.model.cleanup(proof, live)).toBe(false);
    expect(f.get()).toBe(raw);
  });
  it('fails closed with no native locks', async () => {
    const f = fixture(),
      run = vi.fn();
    const model = createMoreActionJournal(key, { durable: () => f.storage, locks: () => undefined });
    expect((await model.execute(marker, run, live, live)).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it('delegates actual coordination to the old more-action key', async () => {
    const request = vi.fn(async (_name: string, _options: LockOptions, callback: (lock: null) => unknown) => callback(null));
    vi.stubGlobal('navigator', { locks: { request } });
    try {
      await moreJournalPorts(key)
        .locks()!
        .request(`intafaced.original:${key}`, { ifAvailable: true }, () => null);
      expect(request).toHaveBeenCalledWith(`more-action:${key}`, { ifAvailable: true }, expect.any(Function));
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('has complete local recovery copy in EN ES FR', () => {
    for (const locale of ['en', 'es', 'fr'] as const)
      for (const name of ['storageTitle', 'cleanup', 'retryCleanup', 'storageBody'] as const) {
        expect(moreActionCopy.forLocale(locale).languageFor(name)).toBe(locale);
      }
  });
});
