import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  supportChartsLookupSchema,
  type SupportChartsAlertsRead,
  type SupportDeskLayoutsRead,
} from '@intafaced/contracts';
import { createIdentityLayoutsClient, createNotifyChartsClient, type ChartsAlertsSource, type DeskLayoutsSource } from './charts-lookup.js';
import { createSupportRouter } from './router.js';
import { MemorySupportStore, type AppendEventInput } from './store.js';
import { SupportError, type SupportService } from './support-service.js';
import { withTestCommentCap } from './comment-cap.fixture.js';

const SECRET = 'a-support-charts-lookup-test-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';
const ALERT = '44444444-4444-4444-8444-444444444444';
const AT = '2026-11-18T10:00:00.000Z';

const alertsRead: SupportChartsAlertsRead = {
  userId: USER,
  more: false,
  alerts: [
    {
      id: ALERT,
      marketId: 'BTC-USDT',
      kind: 'price',
      condition: 'greater_than',
      targetPrice: '50000',
      status: 'fired',
      name: 'TEST breakout',
      source: 'mark',
      frequency: 'once',
      fireCount: 0,
      createdAt: AT,
      firedAt: AT,
      lastFiredAt: null,
      expiresAt: null,
    },
  ],
  history: {
    status: 'read',
    retentionDays: 7,
    more: false,
    items: [
      { alertId: ALERT, seq: 1, marketId: 'BTC-USDT', condition: 'greater_than', targetPrice: '50000', markPrice: '50010', firedAt: AT },
    ],
  },
};
const layoutsRead: SupportDeskLayoutsRead = {
  userId: USER,
  active: 'scalp',
  layouts: [
    {
      id: 'scalp',
      name: 'TEST scalp',
      symbol: 'BTC/USDT',
      interval: '1m',
      desk: { v: 1, preset: 'classic', order: ['markets', 'chart', 'book', 'trades'], widths: {} },
      savedAt: AT,
    },
  ],
};

function sources(alerts: SupportChartsAlertsRead | null = alertsRead, layouts: SupportDeskLayoutsRead | null = layoutsRead) {
  const asked: string[] = [];
  const a: ChartsAlertsSource = {
    alertsOf: vi.fn(async (userId: string) => {
      asked.push(`alerts:${userId}`);
      return alerts ? { status: 'read' as const, data: alerts } : { status: 'unread' as const, reason: 'plane_dark' as const };
    }),
  };
  const l: DeskLayoutsSource = {
    layoutsOf: vi.fn(async (userId: string) => {
      asked.push(`layouts:${userId}`);
      return layouts ? { status: 'read' as const, data: layouts } : { status: 'unread' as const, reason: 'plane_dark' as const };
    }),
  };
  return { asked, alerts: a, layouts: l };
}

/** A store whose trail write for a read fails, as a database that refuses the insert does. */
class AuditFailsStore extends MemorySupportStore {
  override async appendEvent(_input: AppendEventInput): Promise<never> {
    throw new Error('insert refused');
  }
}

async function desk(store = new MemorySupportStore(), wired = sources()) {
  const support = withTestCommentCap(store);
  support.useChartsSources(wired);
  const ticket = await support.createTicket({ userId: USER, category: 'account', subject: 'Alerts', body: 'My alert fired' });
  return { support, ticket, wired };
}

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-support' });
function opCaller(support: SupportService) {
  const p = {
    sub: OP,
    userId: OP,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['support:read', 'support:write', 'support:ops'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return createSupportRouter(support).createCaller(
    edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-charts',
    }),
  );
}

describe('a support agent looks up a ticket owner’s alerts and layouts (J-charts-desk-19 #1)', () => {
  it('writes one charts_lookup row per lookup with the agent, the customer and the time, and returns it as the audit', async () => {
    const { support, ticket } = await desk();
    const first = await support.readChartsLookup({ operatorId: OP, ticketId: ticket.id });
    const second = await support.readChartsLookup({ operatorId: OP, ticketId: ticket.id });

    const rows = (await support.listTicketEvents({ userId: OP, ticketId: ticket.id, asOperator: true, limit: 100 })).filter(
      (e) => e.kind === 'charts_lookup',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actorId: OP, actorRole: 'operator', note: `customer:${USER}` });
    expect(first.audit).toEqual({ sequence: rows[0]!.sequence, agentId: OP, customerId: USER, at: rows[0]!.occurredAt });
    expect(second.audit.sequence).toBe(rows[1]!.sequence);
    expect(Number.isNaN(Date.parse(first.audit.at))).toBe(false);
    expect(supportChartsLookupSchema.parse(first)).toEqual(first);
  });

  it('reads the alerts with their history and the layouts of the ticket’s customer, never anyone else', async () => {
    const { support, ticket, wired } = await desk();
    const got = await support.readChartsLookup({ operatorId: OP, ticketId: ticket.id });
    expect(wired.asked.sort()).toEqual([`alerts:${USER}`, `layouts:${USER}`]);
    expect(got.alerts).toEqual({ status: 'read', items: alertsRead.alerts, more: false, history: alertsRead.history });
    expect(got.layouts).toEqual({ status: 'read', items: layoutsRead.layouts, active: 'scalp' });
  });

  it('refuses the lookup and reads nothing when its audit row does not land', async () => {
    const { support, ticket, wired } = await desk(new AuditFailsStore());
    await expect(support.readChartsLookup({ operatorId: OP, ticketId: ticket.id })).rejects.toMatchObject({
      code: 'support.charts_lookup_unaudited',
    });
    await expect(support.readChartsLookup({ operatorId: OP, ticketId: ticket.id })).rejects.toBeInstanceOf(SupportError);
    expect(wired.asked).toEqual([]);
    await expect(opCaller(support).ticketChartsLookup({ ticketId: ticket.id })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(wired.asked).toEqual([]);
  });

  it('a customer with no alerts and no saved layouts reads two empty lists, not an error', async () => {
    const { support, ticket } = await desk(
      undefined,
      sources(
        { userId: USER, more: false, alerts: [], history: { status: 'read', retentionDays: 7, more: false, items: [] } },
        { userId: USER, layouts: [], active: null },
      ),
    );
    const got = await support.readChartsLookup({ operatorId: OP, ticketId: ticket.id });
    expect(got.alerts).toEqual({
      status: 'read',
      items: [],
      more: false,
      history: { status: 'read', retentionDays: 7, more: false, items: [] },
    });
    expect(got.layouts).toEqual({ status: 'read', items: [], active: null });
  });

  it('a plane that did not answer reads unread with its reason, never an empty list', async () => {
    const { support, ticket } = await desk(undefined, sources(null, null));
    const got = await support.readChartsLookup({ operatorId: OP, ticketId: ticket.id });
    expect(got.alerts).toEqual({ status: 'unread', reason: 'plane_dark' });
    expect(got.layouts).toEqual({ status: 'unread', reason: 'plane_dark' });
  });

  it('with no sources wired both parts read unread: unwired, and the row is still written', async () => {
    const support = withTestCommentCap(new MemorySupportStore());
    const ticket = await support.createTicket({ userId: USER, category: 'account', subject: 'S', body: 'B' });
    const got = await support.readChartsLookup({ operatorId: OP, ticketId: ticket.id });
    expect(got.alerts).toEqual({ status: 'unread', reason: 'unwired' });
    expect(got.layouts).toEqual({ status: 'unread', reason: 'unwired' });
    expect(got.audit.customerId).toBe(USER);
  });

  it('the procedure takes a ticket id only: a userId is refused, not silently dropped, and nothing is read or written', async () => {
    const { support, ticket, wired } = await desk();
    const before = await support.listTicketEvents({ userId: OP, ticketId: ticket.id, asOperator: true, limit: 100 });
    await expect(opCaller(support).ticketChartsLookup({ ticketId: ticket.id, userId: OP } as { ticketId: string })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(wired.asked).toEqual([]);
    expect(await support.listTicketEvents({ userId: OP, ticketId: ticket.id, asOperator: true, limit: 100 })).toHaveLength(before.length);
    await expect(opCaller(support).ticketChartsLookup({ ticketId: ticket.id })).resolves.toMatchObject({
      audit: { agentId: OP, customerId: USER },
    });
  });

  it('a ticket that does not exist is not found and writes nothing', async () => {
    const { support } = await desk();
    await expect(support.readChartsLookup({ operatorId: OP, ticketId: '55555555-5555-4555-8555-555555555555' })).rejects.toMatchObject({
      code: 'support.not_found',
    });
  });
});

describe('the charts clients read only the account asked about', () => {
  const ok = (body: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
  const secret = 'x'.repeat(40);

  it('notify: no address or secret is unwired; an answer about another account or a non-200 is plane_dark', async () => {
    expect(await createNotifyChartsClient({}).alertsOf(USER)).toEqual({ status: 'unread', reason: 'unwired' });
    expect(await createNotifyChartsClient({ notifyUrl: 'http://notify.test', secret: 'short' }).alertsOf(USER)).toEqual({
      status: 'unread',
      reason: 'unwired',
    });
    const read = createNotifyChartsClient({ notifyUrl: 'http://notify.test', secret, fetcher: ok({ result: { data: alertsRead } }) });
    expect(await read.alertsOf(USER)).toEqual({ status: 'read', data: alertsRead });
    const other = createNotifyChartsClient({
      notifyUrl: 'http://notify.test',
      secret,
      fetcher: ok({ result: { data: { ...alertsRead, userId: OP } } }),
    });
    expect(await other.alertsOf(USER)).toEqual({ status: 'unread', reason: 'plane_dark' });
    const down = createNotifyChartsClient({
      notifyUrl: 'http://notify.test',
      secret,
      fetcher: vi.fn<typeof fetch>(async () => new Response('{}', { status: 503 })),
    });
    expect(await down.alertsOf(USER)).toEqual({ status: 'unread', reason: 'plane_dark' });
  });

  it('identity: the layouts of the account asked about; anything else is plane_dark', async () => {
    expect(await createIdentityLayoutsClient({ identityUrl: 'http://identity.test', secret: '' }).layoutsOf(USER)).toEqual({
      status: 'unread',
      reason: 'unwired',
    });
    const fetcher = ok(layoutsRead);
    const read = createIdentityLayoutsClient({ identityUrl: 'http://identity.test', secret, fetcher });
    expect(await read.layoutsOf(USER)).toEqual({ status: 'read', data: layoutsRead });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`http://identity.test/internal/desk-layouts/${USER}`);
    const bad = createIdentityLayoutsClient({
      identityUrl: 'http://identity.test',
      secret,
      fetcher: ok({ userId: USER, layouts: 'nope' }),
    });
    expect(await bad.layoutsOf(USER)).toEqual({ status: 'unread', reason: 'plane_dark' });
  });
});
