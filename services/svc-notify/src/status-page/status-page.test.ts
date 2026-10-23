import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  statusPageConfigureInputSchema,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, type NoticeApprovalConsumer } from '../notices/board.js';
import { MemoryStatusPageBook, type StatusPageBook } from './book.js';
import { statusPageRouter } from './router.js';

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-23T12:00:00.000Z');

class Approvals implements NoticeApprovalConsumer {
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    return {
      approvalId: input.approvalId,
      actionType: 'notify.notice.publish',
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: FOUNDER,
      approverId: '22222222-2222-4222-8222-222222222222',
      policyVersion: 'v1',
      createdAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-10-23T23:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

const configure = (book: StatusPageBook, fields: Record<string, unknown>, expectedRevision: number) =>
  book.configure({
    input: statusPageConfigureInputSchema.parse({ reason: 'TEST', expectedRevision, ...fields }),
    by: FOUNDER,
    at: NOW.toISOString(),
  });

const two = [
  { id: 'trading', name: 'Trading', group: 'Exchange', source: null },
  { id: 'card-network', name: 'Card network', group: null, source: 'Card scheme status page' },
];

function harness() {
  let now = NOW;
  const book = new MemoryStatusPageBook();
  const notices = new NoticeBoard(
    new MemoryNoticeStore(),
    new Approvals(),
    new MemoryCommandLog(),
    () => now,
    async () => (await book.definition()).components.map((c) => c.id),
  );
  const ctx = createEdgeContext({ secret: 'status-page-edge-secret-value-0123456789', serviceName: 'svc-notify' })({
    headers: {},
    id: 'req-anon-status-page',
  });
  const read = () =>
    statusPageRouter({ book, notices, now: () => now })
      .createCaller(ctx)
      .read();
  let n = 0;
  const publish = async (input: Parameters<NoticeBoard['draft']>[1]) => {
    n += 1;
    const draft = await notices.draft(FOUNDER, input);
    return notices.publish(FOUNDER, { id: draft.id, clientRequestId: `pub-${n}`, approvalId: `appr-${n}`, operationId: `op-${n}` });
  };
  return { book, notices, read, publish, at: (iso: string) => (now = new Date(iso)) };
}

describe('status page definition', () => {
  it('starts with nothing defined, and the page says so with no top-level state', async () => {
    const h = harness();
    const page = await h.read();
    expect(page).toMatchObject({ overall: 'none_defined', components: [], revision: 0 });
    expect(page.settings).toEqual({ componentCap: null, stalenessSeconds: null, uptimeDays: null });
  });

  it('refuses components while the cap is blank, and above the cap', async () => {
    const h = harness();
    await expect(configure(h.book, { components: two }, 0)).rejects.toMatchObject({ code: 'status.component_cap_unset' });
    await expect(configure(h.book, { components: two, componentCap: 1 }, 0)).rejects.toMatchObject({
      code: 'status.component_cap_reached',
    });
    const set = await configure(h.book, { components: two, componentCap: 2 }, 0);
    expect(set.revision).toBe(1);
    // Clearing the list is allowed with any cap.
    expect((await configure(h.book, { components: [], componentCap: null }, 1)).components).toEqual([]);
  });

  it('replays the same change under the revision it read, and refuses a different one', async () => {
    const h = harness();
    await configure(h.book, { components: two, componentCap: 5 }, 0);
    expect((await configure(h.book, { components: two, componentCap: 5 }, 0)).revision).toBe(1);
    await expect(configure(h.book, { componentCap: 4 }, 0)).rejects.toMatchObject({ code: 'status.page_revision_stale' });
    expect(h.book.log).toHaveLength(1);
  });

  it('refuses two components with one id', () => {
    const parsed = statusPageConfigureInputSchema.safeParse({ reason: 'x', expectedRevision: 0, components: [two[0], two[0]] });
    expect(parsed.success).toBe(false);
  });
});

describe('component state', () => {
  it('shows no data for a component with no reading, and the top level is then not operational', async () => {
    const h = harness();
    await configure(h.book, { components: two, componentCap: 5, stalenessSeconds: 600 }, 0);
    await h.book.record(
      { componentId: 'trading', state: 'operational', observedAt: new Date(NOW.getTime() - 60_000), source: 'TEST' },
      FOUNDER,
      NOW,
    );
    const page = await h.read();
    expect(page.components.map((c) => [c.id, c.state, c.basis])).toEqual([
      ['trading', 'operational', 'reading'],
      ['card-network', 'no_data', 'no_reading'],
    ]);
    expect(page.overall).toBe('no_data');
  });

  it('turns a reading older than the staleness window, or any reading with the window blank, into no data', async () => {
    const h = harness();
    await configure(h.book, { components: [two[0]], componentCap: 5 }, 0);
    await h.book.record(
      { componentId: 'trading', state: 'operational', observedAt: new Date(NOW.getTime() - 60_000), source: 'TEST' },
      FOUNDER,
      NOW,
    );
    expect((await h.read()).components[0]).toMatchObject({ state: 'no_data', basis: 'staleness_unset' });
    await configure(h.book, { stalenessSeconds: 30 }, 1);
    expect((await h.read()).components[0]).toMatchObject({ state: 'no_data', basis: 'stale', reading: { state: 'operational' } });
    await configure(h.book, { stalenessSeconds: 120 }, 2);
    expect((await h.read()).overall).toBe('operational');
  });

  it('takes the worst component for the top level', async () => {
    const h = harness();
    await configure(h.book, { components: two, componentCap: 5, stalenessSeconds: 600 }, 0);
    await h.book.record({ componentId: 'trading', state: 'operational', observedAt: NOW, source: 'TEST' }, FOUNDER, NOW);
    await h.book.record({ componentId: 'card-network', state: 'degraded', observedAt: NOW, source: 'TEST' }, FOUNDER, NOW);
    expect((await h.read()).overall).toBe('degraded');
  });

  it('refuses a reading for an unknown component, from the future, or conflicting with a stored one', async () => {
    const h = harness();
    await configure(h.book, { components: two, componentCap: 5 }, 0);
    const base = { componentId: 'trading', state: 'operational' as const, observedAt: NOW, source: 'TEST' };
    await expect(h.book.record({ ...base, componentId: 'nope' }, FOUNDER, NOW)).rejects.toMatchObject({ code: 'status.component_unknown' });
    await expect(h.book.record({ ...base, observedAt: new Date(NOW.getTime() + 120_000) }, FOUNDER, NOW)).rejects.toMatchObject({
      code: 'status.reading_in_future',
    });
    await h.book.record(base, FOUNDER, NOW);
    await h.book.record(base, FOUNDER, NOW);
    expect(await h.book.since(new Date(0))).toHaveLength(1);
    await expect(h.book.record({ ...base, state: 'degraded' }, FOUNDER, NOW)).rejects.toMatchObject({ code: 'status.reading_conflict' });
  });
});

describe('uptime strip', () => {
  it('has no strip while the window is blank, and an empty day for a day with no reading; no percentage anywhere', async () => {
    const h = harness();
    await configure(h.book, { components: two, componentCap: 5, stalenessSeconds: 600 }, 0);
    expect((await h.read()).components[0]!.uptime).toEqual([]);
    await configure(h.book, { uptimeDays: 3 }, 1);
    await h.book.record(
      { componentId: 'trading', state: 'degraded', observedAt: new Date('2026-10-22T08:00:00Z'), source: 'TEST' },
      FOUNDER,
      NOW,
    );
    await h.book.record(
      { componentId: 'trading', state: 'operational', observedAt: new Date('2026-10-22T09:00:00Z'), source: 'TEST' },
      FOUNDER,
      NOW,
    );
    const page = await h.read();
    expect(page.components[0]!.uptime).toEqual([
      { date: '2026-10-21', state: null },
      { date: '2026-10-22', state: 'degraded' },
      { date: '2026-10-23', state: null },
    ]);
    expect(page.components[1]!.uptime.every((day) => day.state === null)).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/percent|uptime%/i);
  });
});

describe('incidents', () => {
  it('lets a notice name a page component, shows its impact on that component until it is resolved, and refuses an unknown one', async () => {
    const h = harness();
    await configure(h.book, { components: two, componentCap: 5, stalenessSeconds: 600 }, 0);
    await h.book.record({ componentId: 'trading', state: 'operational', observedAt: NOW, source: 'TEST' }, FOUNDER, NOW);
    await expect(
      h.notices.draft(FOUNDER, {
        kind: 'incident',
        title: 'x',
        body: 'y',
        impact: 'minor',
        components: ['ghost'],
        clientRequestId: 'ghost',
      }),
    ).rejects.toMatchObject({ code: 'notify.notice_component_unknown' });
    const root = await h.publish({
      kind: 'incident',
      title: 'Slow fills',
      body: 'Investigating',
      impact: 'major',
      components: ['trading'],
      clientRequestId: 'r',
    });
    let page = await h.read();
    expect(page.components[0]).toMatchObject({ state: 'partial_outage', basis: 'incident', incidentId: root.id });
    expect(page.incidents[0]).toMatchObject({ id: root.id, components: ['trading'], resolvedAt: null });
    h.at('2026-10-23T12:10:00.000Z');
    await h.publish({ kind: 'incident', title: 'Slow fills', body: 'Fixed', parentId: root.id, resolves: true, clientRequestId: 'c' });
    page = await h.read();
    expect(page.components[0]).toMatchObject({ state: 'operational', basis: 'reading', incidentId: null });
    expect(page.incidents[0]!.updates.map((u) => u.body)).toEqual(['Investigating', 'Fixed']);
    expect(page.incidents[0]!.resolvedAt).not.toBeNull();
    // The developer feed still lists only its three built-in components.
    expect((await h.notices.statusFeed({ days: 1 })).incidents[0]!.components).toEqual([]);
  });

  it('says the page is unavailable when it is not wired', async () => {
    const ctx = createEdgeContext({ secret: 'status-page-edge-secret-value-0123456789', serviceName: 'svc-notify' })({
      headers: {},
      id: 'r',
    });
    await expect(statusPageRouter().createCaller(ctx).read()).rejects.toMatchObject({ message: 'notify.status_page_unavailable' });
  });
});
