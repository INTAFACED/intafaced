import { describe, expect, it } from 'vitest';
import { CONFLICT, rebaseAndWrite, type RecordIo, type WriteReply } from './rebase';

/** A fake account record: `head` is what the account holds; each write is recorded with the version it was sent against. */
function account(initial: { version: number; value: number[] }) {
  let head = { ...initial };
  const writes: Array<{ next: number[]; ifVersion: number }> = [];
  const script: Array<() => WriteReply<number[]>> = [];
  const io: RecordIo<number[]> = {
    read: async () => ({ ...head }),
    write: async (next, ifVersion) => {
      writes.push({ next, ifVersion });
      const scripted = script.shift();
      if (scripted) return scripted();
      if (ifVersion !== head.version) return { ok: false, code: CONFLICT };
      head = { version: head.version + 1, value: next };
      return { ok: true, version: head.version, value: next };
    },
  };
  return {
    io,
    writes,
    script,
    set: (next: { version: number; value: number[] }) => {
      head = { ...next };
    },
  };
}

describe('rebaseAndWrite', () => {
  it('computes the change on the record it is sent against', async () => {
    const acct = account({ version: 3, value: [1, 2] });
    const result = await rebaseAndWrite({ version: 3, value: [1, 2] }, acct.io, (latest) => [...latest, 3], []);
    expect(result.outcome).toEqual({ ok: true });
    expect(acct.writes).toEqual([{ next: [1, 2, 3], ifVersion: 3 }]);
    expect(result.record).toEqual({ version: 4, value: [1, 2, 3] });
  });

  it('a conflict rebases onto the newer record, so a stale write does not undo the other device’s change', async () => {
    const acct = account({ version: 1, value: [1] });
    // Another device stored 9 at version 2 after this device read version 1.
    acct.set({ version: 2, value: [1, 9] });
    const result = await rebaseAndWrite({ version: 1, value: [1] }, acct.io, (latest) => [...latest, 2], []);
    expect(result.outcome).toEqual({ ok: true });
    expect(acct.writes).toEqual([
      { next: [1, 2], ifVersion: 1 },
      { next: [1, 9, 2], ifVersion: 2 },
    ]);
    expect(result.record).toEqual({ version: 3, value: [1, 9, 2] });
  });

  it('a delete queued behind a stale autosave is applied to the latest record, not restored from the stale copy', async () => {
    const acct = account({ version: 5, value: [1, 2, 3] });
    // The delete was computed from a copy at version 5; an autosave stored version 6 first.
    acct.set({ version: 6, value: [1, 2, 3, 4] });
    const del = (latest: number[]) => latest.filter((item) => item !== 2);
    const result = await rebaseAndWrite({ version: 5, value: [1, 2, 3] }, acct.io, del, []);
    expect(result.outcome).toEqual({ ok: true });
    expect(result.record?.value).toEqual([1, 3, 4]);
  });

  it('reports a second conflict in a row instead of looping', async () => {
    const acct = account({ version: 1, value: [] });
    acct.script.push(
      () => ({ ok: false, code: CONFLICT }),
      () => ({ ok: false, code: CONFLICT }),
    );
    acct.set({ version: 2, value: [7] });
    const result = await rebaseAndWrite({ version: 1, value: [] }, acct.io, (latest) => [...latest, 1], []);
    expect(result.outcome).toEqual({ ok: false, code: CONFLICT });
    expect(acct.writes).toHaveLength(2);
    expect(result.record).toEqual({ version: 2, value: [7] });
  });

  it('a failed read after a conflict stops the write and says so', async () => {
    const writes: number[][] = [];
    const io: RecordIo<number[]> = {
      read: async () => null,
      write: async (next) => {
        writes.push(next);
        return { ok: false, code: CONFLICT };
      },
    };
    const result = await rebaseAndWrite({ version: 1, value: [] }, io, (latest) => [...latest, 1], []);
    expect(result).toEqual({ outcome: { ok: false, code: CONFLICT }, readFailed: true });
    expect(writes).toHaveLength(1);
  });

  it('a refusal that is not a conflict is returned as is, with no record', async () => {
    const io: RecordIo<number[]> = {
      read: async () => ({ version: 1, value: [] }),
      write: async () => ({ ok: false, code: 'identity.watchlist_cap_exceeded' }),
    };
    const result = await rebaseAndWrite({ version: 1, value: [] }, io, (latest) => latest, []);
    expect(result).toEqual({ outcome: { ok: false, code: 'identity.watchlist_cap_exceeded' } });
  });
});
