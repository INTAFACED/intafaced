import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../shared/api';
import { academyJournalPorts, academyPendingKey, createAcademyGrantApi, recordsFor } from './academy-grant-api';
import type { JournalPorts } from '../../shared/minimal-original-journal';
import { academyGrantCopy } from './academy-grant-copy';

const owner = '11111111-1111-4111-8111-111111111111';
const certId = 'foundations-v1',
  reference = `cert:${owner}:${certId}`,
  key = academyPendingKey(owner);
const marker = { id: 'original-a', title: 'Review certification grant', reference, kind: 'grant' };
const record = { userId: owner, certId, grantedAt: '2026-10-10T08:00:00.000Z', idempotencyKey: reference };
const active = () => true;
function fixture() {
  const bytes = new Map<string, string>();
  const state = {
    fault: '',
    leased: false,
    identity: true,
    history: [record] as unknown[],
    reads: 0,
    posts: 0,
    hold: null as (() => Promise<void>) | null,
    locks: [] as string[],
  };
  const storage = {
    getItem(name: string) {
      if (state.fault === 'getItem') throw Error('read refused');
      return bytes.get(name) ?? null;
    },
    setItem(name: string, value: string) {
      if (state.fault === 'setItem') throw Error('quota');
      if (state.fault !== 'silent-setItem') bytes.set(name, value);
    },
    removeItem(name: string) {
      if (state.fault === 'removeItem') throw Error('remove refused');
      if (state.fault !== 'silent-removeItem') bytes.delete(name);
    },
  };
  const ports: JournalPorts = {
    durable: () => storage,
    locks: () => ({
      request: (async (name: string, _options: unknown, work: (lock: unknown) => Promise<unknown>) => {
        state.locks.push(name);
        if (state.leased) return work(null);
        state.leased = true;
        try {
          return await work({ name });
        } finally {
          state.leased = false;
        }
      }) as LockManager['request'],
    }),
  };
  const api = createApiClient({
    canWrite: () => state.identity,
    fetch: (async () => {
      state.reads++;
      if (state.hold) await state.hold();
      return new Response(JSON.stringify({ result: { data: state.history } }), { status: 200 });
    }) as typeof fetch,
  });
  const create = () => createAcademyGrantApi(api, owner, ports);
  return { bytes, state, ports, api, create, grant: create() };
}
describe('Academy original grant business-fact recovery', () => {
  it('delegates the journal port to the same real-lock name as old Academy actions', async () => {
    const called: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, _options: unknown, work: (lock: unknown) => unknown) => {
          called.push(name);
          return work({ name });
        },
      },
    });
    try {
      await academyJournalPorts(owner)
        .locks()!
        .request(`intafaced.original:${key}`, { ifAvailable: true }, () => {});
    } finally {
      vi.unstubAllGlobals();
    }
    expect(called).toEqual([`more-action:${key}`]);
  });
  it('persists only exact public original metadata before one dispatch and survives independent callers', async () => {
    const f = fixture();
    const result = await f.grant.execute(
      marker,
      async (guard) => {
        expect(guard()).toBe(true);
        expect(JSON.parse(f.bytes.get(key)!)).toEqual(marker);
        f.state.posts++;
        return { ok: false, reason: 'uncertain', message: 'lost reply' };
      },
      active,
      active,
      { certId, dispatched: active },
    );
    expect(result.ok).toBe(false);
    expect(f.state.posts).toBe(1);
    expect(f.create().inspect(active)).toMatchObject({ status: 'grant', raw: JSON.stringify(marker) });
    expect(
      await f.create().execute(
        { ...marker, id: 'replacement' },
        async () => {
          f.state.posts++;
          return { ok: true, data: null };
        },
        active,
        active,
      ),
    ).toMatchObject({ ok: false });
    expect(f.state.posts).toBe(1);
  });
  for (const fault of ['getItem', 'setItem', 'silent-setItem'])
    it(`storage ${fault} refuses dispatch`, async () => {
      const f = fixture();
      f.state.fault = fault;
      expect(
        await f.grant.execute(
          marker,
          async () => {
            f.state.posts++;
            return { ok: true, data: null };
          },
          active,
          active,
        ),
      ).toMatchObject({ ok: false });
      expect(f.state.posts).toBe(0);
    });
  for (const raw of [
    'broken',
    JSON.stringify({ id: 'ambiguous', title: 'Room request', reference, operation: 'room' }),
    JSON.stringify({ id: 'old', title: 'Room request' }),
    JSON.stringify({ id: 'old', title: 'Lesson', reference: 'curriculum:foundations-position-sizing' }),
    JSON.stringify({ id: 'old', title: 'Grant', reference: `cert:22222222-2222-4222-8222-222222222222:${certId}` }),
  ])
    it(`preserves non-grant/unreadable original ${raw}`, async () => {
      const f = fixture();
      f.bytes.set(key, raw);
      expect(await f.grant.checkOriginal(raw, active, active)).toMatchObject({ ok: false });
      expect(f.bytes.get(key)).toBe(raw);
      expect(f.state.reads).toBe(0);
    });
  it('strict same-owner cert legacy reference recovers without changing legacy bytes first', async () => {
    const f = fixture(),
      raw = JSON.stringify({ id: 'legacy', title: 'Earlier public title', reference });
    f.bytes.set(key, raw);
    const result = await f.grant.checkOriginal(raw, active, active);
    expect(result).toMatchObject({ ok: true, data: record });
    expect(f.bytes.has(key)).toBe(false);
    expect(f.state.posts).toBe(0);
  });
  for (const history of [
    [],
    [{ ...record, userId: '22222222-2222-4222-8222-222222222222' }],
    [{ ...record, certId: 'other', idempotencyKey: `cert:${owner}:other` }],
    [{ ...record, idempotencyKey: 'wrong' }],
    [record, record],
    [{ ...record, grantedAt: '2026-10-10T08:00:00+24:00' }],
  ])
    it(`retains original when records cannot prove it ${JSON.stringify(history).slice(0, 65)}`, async () => {
      const f = fixture(),
        raw = JSON.stringify(marker);
      f.bytes.set(key, raw);
      f.state.history = history;
      await f.grant.checkOriginal(raw, active, active);
      expect(f.bytes.get(key)).toBe(raw);
      expect(f.grant.inspect(active).known).toBe(null);
    });
  it('a valid capped window with no original remains unresolved', async () => {
    const f = fixture(),
      raw = JSON.stringify(marker);
    f.bytes.set(key, raw);
    f.state.history = Array.from({ length: 200 }, (_, i) => ({
      ...record,
      certId: `other-${i}`,
      idempotencyKey: `cert:${owner}:other-${i}`,
    }));
    expect(await f.grant.checkOriginal(raw, active, active)).toEqual({ ok: true, data: null });
    expect(f.bytes.get(key)).toBe(raw);
  });
  for (const fault of ['removeItem', 'silent-removeItem'])
    it(`immutable canonical proof survives failed ${fault}; retry is local only`, async () => {
      const f = fixture(),
        raw = JSON.stringify(marker);
      f.bytes.set(key, raw);
      f.state.fault = fault;
      expect(await f.grant.checkOriginal(raw, active, active)).toMatchObject({ ok: true, data: record });
      const proof = f.grant.inspect(active).known!;
      expect(Object.isFrozen(proof)).toBe(true);
      expect(Object.isFrozen(proof.grant)).toBe(true);
      const reads = f.state.reads;
      f.state.fault = '';
      expect(await f.grant.cleanupKnown(proof, active)).toBe(true);
      expect(f.state.reads).toBe(reads);
      expect(f.state.posts).toBe(0);
      expect(f.bytes.has(key)).toBe(false);
    });
  it('held history owns admission through exact cleanup and blocks an independent writer', async () => {
    const f = fixture(),
      raw = JSON.stringify(marker);
    f.bytes.set(key, raw);
    let release!: () => void;
    f.state.hold = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const pending = f.grant.checkOriginal(raw, active, active);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(
      await f.create().execute(
        marker,
        async () => {
          f.state.posts++;
          return { ok: true, data: null };
        },
        active,
        active,
      ),
    ).toMatchObject({ ok: false });
    release();
    expect(await pending).toMatchObject({ ok: true, data: record });
    expect(f.state.posts).toBe(0);
  });
  it('late history never publishes or clears replacement raw B', async () => {
    const f = fixture(),
      raw = JSON.stringify(marker),
      replacement = JSON.stringify({ ...marker, id: 'replacement' });
    f.bytes.set(key, raw);
    let release!: () => void;
    f.state.hold = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const pending = f.grant.checkOriginal(raw, active, active);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.bytes.set(key, replacement);
    release();
    expect(await pending).toMatchObject({ ok: false });
    expect(f.bytes.get(key)).toBe(replacement);
    expect(f.grant.inspect(active).known).toBe(null);
  });
  it('immediate API identity replacement stops retained reads before dispatch', async () => {
    const f = fixture(),
      raw = JSON.stringify(marker);
    f.bytes.set(key, raw);
    f.state.identity = false;
    expect(await f.grant.checkOriginal(raw, active, active)).toMatchObject({ ok: false });
    expect(f.state.reads).toBe(0);
    expect(f.bytes.get(key)).toBe(raw);
  });
  it('known cleanup outlives its read attempt but cannot clear B', async () => {
    const f = fixture(),
      raw = JSON.stringify(marker);
    f.bytes.set(key, raw);
    f.state.fault = 'removeItem';
    let currentRead = true;
    await f.grant.checkOriginal(raw, () => currentRead, active);
    const proof = f.grant.inspect(active).known!;
    currentRead = false;
    f.state.fault = '';
    f.bytes.set(key, JSON.stringify({ ...marker, id: 'B' }));
    expect(await f.grant.cleanupKnown(proof, active)).toBe(false);
    f.bytes.set(key, raw);
    expect(await f.grant.cleanupKnown(proof, active)).toBe(true);
  });
  it('typed grant errors after dispatch never release the original', async () => {
    const f = fixture();
    await f.grant.execute(marker, async () => ({ ok: false, reason: 'error', message: 'post-persistence failure' }), active, active, {
      certId,
      dispatched: active,
    });
    expect(f.bytes.get(key)).toBe(JSON.stringify(marker));
  });
  it('valid typed grant reply clears only its original and preserves reported XP as RAM result', async () => {
    const f = fixture(),
      data = { grant: record, xp: { emitted: false, reason: 'publisher_unavailable' } };
    expect(await f.grant.execute(marker, async () => ({ ok: true, data }), active, active, { certId, dispatched: active })).toEqual({
      ok: true,
      data,
    });
    expect(f.bytes.has(key)).toBe(false);
  });
  it('grant records validate entire response and complete authored EN/ES/FR copy', () => {
    expect(recordsFor(owner, 50).safeParse([record]).success).toBe(true);
    for (const locale of ['en', 'es', 'fr'] as const) expect(academyGrantCopy.coverage(locale).missing).toEqual([]);
  });
});
