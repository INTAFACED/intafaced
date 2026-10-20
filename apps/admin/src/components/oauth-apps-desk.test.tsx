import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppCard, OAuthAppsDeskView } from './oauth-apps-desk';
import type { OAuthQueueDeskView } from '@/lib/oauth-ops/browser';
import type { OAuthQueueApp } from '@/lib/oauth-ops/model';

const app = (over: Partial<OAuthQueueApp> = {}): OAuthQueueApp => ({
  id: '44444444-4444-4444-8444-444444444444',
  clientId: 'ifc_abc',
  name: 'Ledger sync',
  description: 'Reads balances for a spreadsheet.',
  logoUrl: 'https://cdn.example.test/logo.png',
  redirectUrls: ['https://app.example.test/callback', 'https://app.example.test/other'],
  scopes: ['identity:read', 'trade:read'],
  confidential: true,
  status: 'pending',
  createdAt: '2026-10-20T12:00:00.000Z',
  secretRolledAt: null,
  developerUserId: '55555555-5555-4555-8555-555555555555',
  ...over,
});
const view = (apps: OAuthQueueApp[], status: OAuthQueueDeskView['status'] = 'pending'): OAuthQueueDeskView => ({
  asOf: '2026-10-20T13:00:00.000Z',
  status,
  limit: 50,
  apps: { kind: 'ok', data: apps },
});
const render = (v: OAuthQueueDeskView | null, status: OAuthQueueDeskView['status'] = 'pending', notice: string | null = null) =>
  renderToStaticMarkup(
    <OAuthAppsDeskView
      view={v}
      status={status}
      loading={false}
      notice={notice}
      onRefresh={() => undefined}
      onChanged={() => undefined}
      onStatus={() => undefined}
    />,
  );

describe('oauth apps desk', () => {
  it('shows what an operator decides on: client, developer, scopes, every redirect address, and the read time', () => {
    const html = render(view([app()]));
    expect(html).toContain('Ledger sync');
    expect(html).toContain('Waiting for a decision');
    expect(html).toContain('ifc_abc');
    expect(html).toContain('55555555-5555-4555-8555-555555555555');
    expect(html).toContain('identity:read, trade:read');
    expect(html).toContain('https://app.example.test/callback');
    expect(html).toContain('https://app.example.test/other');
    expect(html).toContain('13:00:00 UTC');
  });

  it('prints the logo as an address and never loads it', () => {
    const html = render(view([app()]));
    expect(html).toContain('https://cdn.example.test/logo.png');
    expect(html).not.toContain('<img');
  });

  it('offers approve and suspend on a pending app, only suspend once approved, only approve once suspended', () => {
    const pending = renderToStaticMarkup(<AppCard app={app()} onChanged={() => undefined} />);
    expect(pending).toContain('Approve…');
    expect(pending).toContain('Suspend…');
    const approved = renderToStaticMarkup(<AppCard app={app({ status: 'approved' })} onChanged={() => undefined} />);
    expect(approved).not.toContain('Approve…');
    expect(approved).toContain('Suspend…');
    const suspended = renderToStaticMarkup(<AppCard app={app({ status: 'suspended' })} onChanged={() => undefined} />);
    expect(suspended).toContain('Approve…');
    expect(suspended).not.toContain('Suspend…');
  });

  it('names a public app as having no secret and a confidential one as holding it, and never prints a secret', () => {
    expect(render(view([app({ confidential: false })]))).toContain('Public: no client secret');
    const html = render(view([app()]));
    expect(html).toContain('Confidential: holds a client secret');
    expect(html).not.toMatch(/ifcs_/);
  });

  it('says plainly when nothing is waiting, per status', () => {
    expect(render(view([]))).toContain('No app is waiting for a decision.');
    expect(render(view([], 'suspended'), 'suspended')).toContain('No app is suspended.');
  });

  it('says when the page is full', () => {
    const many = Array.from({ length: 50 }, (_, i) => app({ id: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}` }));
    expect(render(view(many))).toContain('oauth-full-page');
  });

  it('a failed read says why and shows no list; no read at all shows nothing', () => {
    const failed = render({
      asOf: '2026-10-20T13:00:00.000Z',
      status: 'pending',
      limit: 50,
      apps: { kind: 'failed', message: 'svc-identity did not answer.', code: null, notBuilt: false, forbidden: false },
    });
    expect(failed).toContain('svc-identity did not answer.');
    expect(failed).not.toContain('data-testid="oauth-app"');
    expect(failed).not.toContain('oauth-empty');
    expect(render(null)).toContain('could not be read');
  });

  it('shows the service-confirmed notice after a decision', () => {
    expect(render(view([]), 'pending', 'svc-identity now shows Ledger sync as approved.')).toContain(
      'svc-identity now shows Ledger sync as approved.',
    );
  });
});
