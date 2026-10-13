import { describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';
import type { ApiClient } from '../shared/api';
import { createActivityFeed, type ActivityFeed } from './activity';
import type { Loadable } from './types';

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'deposit',
  direction: 'in',
  asset: 'USDT',
  amount: '10',
  postedAt: '2026-10-13T10:00:00.000Z',
  txId: `tx-${id}`,
  counterparty: null,
  spaceName: null,
  ...over,
});

type Answer = { ok: true; data: unknown } | { ok: false; reason: string; message: string; status?: number; code?: string };

function fakeApi(answers: Answer[]) {
  const calls: Array<{ module: string; procedure: string; input: unknown }> = [];
  const query = vi.fn(async (module: string, procedure: string, input: unknown, schema: ZodType) => {
    calls.push({ module, procedure, input });
    const answer = answers.shift() ?? { ok: false, reason: 'unreachable', message: 'no answer left' };
    if (!answer.ok) return answer;
    const parsed = schema.safeParse(answer.data);
    if (!parsed.success) return { ok: false, reason: 'invalid_response', message: parsed.error.message };
    return { ok: true, data: parsed.data };
  });
  return { api: { query } as unknown as ApiClient, calls };
}

/** Read a source until it leaves `loading`. */
async function settled(feed: ReturnType<typeof createActivityFeed>, unsubscribes: Array<() => void>) {
  unsubscribes.push(feed.subscribe(() => undefined));
  await vi.waitFor(() => expect(feed.getSnapshot().status).not.toBe('loading'));
  return feed.getSnapshot();
}
const ready = (snap: Loadable<ActivityFeed>) => {
  if (snap.status !== 'ready') throw new Error(`expected ready, got ${snap.status}`);
  return snap.data;
};

describe('createActivityFeed', () => {
  it('asks for the first page with the limit and no cursor, and reads the rows', async () => {
    const { api, calls } = fakeApi([
      { ok: true, data: { items: [item('a'), item('b', { kind: 'transfer_in', counterparty: { handle: 'maya' } })], nextCursor: null } },
    ]);
    const stops: Array<() => void> = [];
    const data = ready(await settled(createActivityFeed(api, { pageSize: 25 }), stops));
    expect(calls).toEqual([{ module: 'bank', procedure: 'activity.list', input: { limit: 25 } }]);
    expect(data.items.map((row) => row.id)).toEqual(['a', 'b']);
    expect(data.items[1]!.counterparty).toEqual({ handle: 'maya' });
    expect(data.hasMore).toBe(false);
    stops.forEach((stop) => stop());
  });

  it('pages by cursor, appends, and skips a row it already has', async () => {
    const { api, calls } = fakeApi([
      { ok: true, data: { items: [item('a'), item('b')], nextCursor: 'c1' } },
      { ok: true, data: { items: [item('b'), item('c')], nextCursor: null } },
    ]);
    const stops: Array<() => void> = [];
    const feed = createActivityFeed(api, { assetId: 'BTC' });
    const first = ready(await settled(feed, stops));
    expect(first.hasMore).toBe(true);
    first.loadMore();
    expect(ready(feed.getSnapshot()).loadingMore).toBe(true);
    await vi.waitFor(() => expect(ready(feed.getSnapshot()).items.length).toBe(3));
    const second = ready(feed.getSnapshot());
    expect(second.items.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(second.hasMore).toBe(false);
    expect(second.loadingMore).toBe(false);
    expect(calls.map((call) => call.input)).toEqual([
      { limit: 50, assetId: 'BTC' },
      { limit: 50, cursor: 'c1', assetId: 'BTC' },
    ]);
    stops.forEach((stop) => stop());
  });

  it('keeps the rows when "load more" fails, and can try again', async () => {
    const { api } = fakeApi([
      { ok: true, data: { items: [item('a')], nextCursor: 'c1' } },
      { ok: false, reason: 'unreachable', message: 'down' },
      { ok: true, data: { items: [item('b')], nextCursor: null } },
    ]);
    const stops: Array<() => void> = [];
    const feed = createActivityFeed(api);
    ready(await settled(feed, stops)).loadMore();
    await vi.waitFor(() => expect(ready(feed.getSnapshot()).moreFailed).toBe(true));
    expect(ready(feed.getSnapshot()).items.map((row) => row.id)).toEqual(['a']);
    ready(feed.getSnapshot()).loadMore();
    await vi.waitFor(() => expect(ready(feed.getSnapshot()).items.length).toBe(2));
    expect(ready(feed.getSnapshot()).moreFailed).toBe(false);
    stops.forEach((stop) => stop());
  });

  it('is empty when the first page has no rows and no next page', async () => {
    const { api } = fakeApi([{ ok: true, data: { items: [], nextCursor: null } }]);
    const stops: Array<() => void> = [];
    expect((await settled(createActivityFeed(api), stops)).status).toBe('empty');
    stops.forEach((stop) => stop());
  });

  it('reads a typed refusal as refused and a dropped connection as an error that can retry', async () => {
    const refusedApi = fakeApi([{ ok: false, reason: 'forbidden', message: 'no', status: 403, code: 'denied.screening_fixture' }]);
    const stops: Array<() => void> = [];
    expect(await settled(createActivityFeed(refusedApi.api), stops)).toMatchObject({ status: 'refused', code: 'denied.screening_fixture' });

    const { api } = fakeApi([
      { ok: false, reason: 'unreachable', message: 'down', status: 502 },
      { ok: true, data: { items: [item('a')], nextCursor: null } },
    ]);
    const feed = createActivityFeed(api);
    const failed = await settled(feed, stops);
    expect(failed.status).toBe('error');
    if (failed.status === 'error') failed.retry();
    await vi.waitFor(() => expect(feed.getSnapshot().status).toBe('ready'));
    stops.forEach((stop) => stop());
  });

  it('reads a kind it does not know as "other" instead of failing the page', async () => {
    const { api } = fakeApi([{ ok: true, data: { items: [item('a', { kind: 'cashback_v2' })], nextCursor: null } }]);
    const stops: Array<() => void> = [];
    expect(ready(await settled(createActivityFeed(api), stops)).items[0]!.kind).toBe('other');
    stops.forEach((stop) => stop());
  });

  it('keeps one snapshot object until something changes', async () => {
    const { api } = fakeApi([{ ok: true, data: { items: [item('a')], nextCursor: null } }]);
    const stops: Array<() => void> = [];
    const feed = createActivityFeed(api);
    const snap = await settled(feed, stops);
    expect(feed.getSnapshot()).toBe(snap);
    stops.forEach((stop) => stop());
  });
});
