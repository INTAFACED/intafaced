import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServicePage } from '@/components/service-page';
import { loadServicePage, saveServiceRecord } from './server';
import { readModuleAlerts } from './model';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const ctx = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const ok = (data: unknown) => Response.json({ result: { data } });
const refused = (code: string, status = 412) =>
  Response.json(
    { error: { message: `${code} — refused`, code: -32603, data: { code: 'PRECONDITION_FAILED', httpStatus: status, cause: { code } } } },
    { status },
  );

const NOW = new Date('2026-10-24T10:00:00.000Z');
const record = (over: Record<string, unknown> = {}) => ({
  module: 'ledger',
  ownerTeam: 'Core platform',
  dependencies: ['identity', 'edge'],
  runbook: 'docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md',
  revision: 3,
  updatedBy: ctx.session.userId,
  updatedAt: '2026-10-24T09:00:00.000Z',
  ...over,
});

function route(answers: Record<string, () => Response | Promise<Response>>) {
  const fn = vi.fn(async (url: string) => {
    const procedure = new URL(url).pathname.split('/trpc/')[1] ?? '';
    const answer = answers[procedure];
    if (!answer) throw new Error(`unexpected call ${procedure}`);
    return answer();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('service page', () => {
  it('shows the owner, dependencies, runbook and alerts; panels with no source name their blocker', async () => {
    const fn = route({
      'services.get': () => ok({ record: record(), asOf: NOW.toISOString() }),
      'alertRules.states': () =>
        ok({
          items: [
            { rule: { id: 'r1', name: 'Ledger posting lag', folder: 'core', group: 'ledger' }, status: { state: 'firing', health: 'ok' } },
            { rule: { id: 'r2', name: 'Ledger reconcile', folder: 'core', group: 'ledger' }, status: null },
          ],
          nextCursor: null,
        }),
    });
    const view = await loadServicePage(ctx, 'ledger', NOW);
    // The alerts are those labelled with this module, a bounded page.
    const alertsUrl = new URL(fn.mock.calls.find(([u]) => u.includes('alertRules.states'))![0]);
    expect(JSON.parse(alertsUrl.searchParams.get('input')!)).toEqual({ label: { key: 'module', value: 'ledger' }, limit: 50 });
    const html = renderToStaticMarkup(<ServicePage view={view} />);
    expect(html).toContain('data-testid="service-owner-team">Core platform<');
    expect(html).toContain('href="/health/identity"');
    expect(html).toContain('docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md');
    expect(html).toContain('Ledger posting lag');
    expect(html).toContain('not evaluated yet');
    for (const id of ['on-call', 'incidents', 'objectives', 'dashboards'])
      expect(html).toMatch(new RegExp(`data-testid="service-${id}" data-state="unwired"`));
    expect(html).toContain('ops.health_source_unwired');
    // Escalate and declare show, disabled, with the reason.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Escalate<\/button>/);
    expect(html).toContain('Needs the incident desk');
  });

  it('a module nobody has set reads "owner not set", and no owner is guessed', async () => {
    route({
      'services.get': () =>
        ok({
          record: record({ ownerTeam: null, dependencies: [], runbook: null, revision: 0, updatedBy: null, updatedAt: null }),
          asOf: NOW.toISOString(),
        }),
      'alertRules.states': () => ok({ items: [], nextCursor: null }),
    });
    const html = renderToStaticMarkup(<ServicePage view={await loadServicePage(ctx, 'ledger', NOW)} />);
    expect(html).toContain('Owner not set.');
    expect(html).toContain('ops.service_owner_unset');
    expect(html).toContain('No alert rule is labelled module=ledger');
    expect(html).toContain('Nobody has set this record yet.');
  });

  it('one source failing refuses only its own panel', async () => {
    route({
      'services.get': () => ok({ record: record(), asOf: NOW.toISOString() }),
      'alertRules.states': () => Promise.reject(new Error('down')),
    });
    const view = await loadServicePage(ctx, 'ledger', NOW);
    expect(view.alerts).toMatchObject({ kind: 'unavailable', service: 'svc-ops', code: 'ops.service_source_unavailable' });
    expect(view.record.kind).toBe('read');

    route({
      'services.get': () => refused('ops.service_storage_unconfigured'),
      'alertRules.states': () => ok({ items: [], nextCursor: null }),
    });
    const second = await loadServicePage(ctx, 'ledger', NOW);
    expect(second.record).toMatchObject({ kind: 'unavailable', code: 'ops.service_source_unavailable' });
    expect(second.alerts.kind).toBe('read');
    const html = renderToStaticMarkup(<ServicePage view={second} />);
    expect(html).toMatch(/data-testid="service-owner" data-state="unavailable"/);
    // The form still shows, disabled with why.
    expect(html).toContain('The record could not be read, so it cannot be changed from here.');
  });

  it('an alert answer in another shape is not shown as an empty list', () => {
    expect(readModuleAlerts({ items: [{ rule: { id: 'r1' } }], nextCursor: null })).toBeNull();
    expect(readModuleAlerts({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
  });
});

describe('service record writes', () => {
  it('a refused value names the field it refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: 'ops.service_record_invalid — not a value the service record takes: ownerTeam, runbook',
              code: -32600,
              data: { code: 'BAD_REQUEST', httpStatus: 400, cause: { code: 'ops.service_record_invalid' } },
            },
          },
          { status: 400 },
        ),
      ),
    );
    const out = await saveServiceRecord(ctx, { module: 'ledger', expectedRevision: 0, ownerTeam: 'x', dependencies: [], runbook: 'y' });
    expect(out).toMatchObject({ status: 400, reply: { ok: false, code: 'ops.service_record_invalid' } });
    expect(out.reply.ok === false && out.reply.body).toMatch(/^Refused: owner team, runbook\. /);
  });

  it('a refused save carries the refusal map’s words and code', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => refused('ops.service_record_stale', 409));
    vi.stubGlobal('fetch', fn);
    const input = { module: 'ledger', expectedRevision: 2, ownerTeam: 'Core', dependencies: [], runbook: null };
    const out = await saveServiceRecord(ctx, input);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/ops/trpc/services.set');
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual(input);
    expect(out).toMatchObject({
      status: 409,
      reply: { ok: false, code: 'ops.service_record_stale', title: 'Someone saved this service record first' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ record: record({ revision: 3 }), asOf: NOW.toISOString() })),
    );
    expect(await saveServiceRecord(ctx, input)).toMatchObject({ status: 200, reply: { ok: true, record: { revision: 3 } } });
  });
});
