import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHandoff, ApprovePanel } from './approve-panel';
import { BarChart } from './bar-chart';
import { MERCHANT_SECTIONS } from './merchants-subnav';
import { RegistryForm } from './registry-form';
import { FailureState, Skeleton, StateBlock } from './ui';
import { postRegistry } from '@/lib/merchants/registry-client';
import { formFromView, type VenueView } from '@/lib/merchants/registry-model';
import { MODULE_ROUTES } from '@/lib/modules';

const html = (el: unknown) => renderToStaticMarkup(el as never);

describe('bar chart', () => {
  it('a day that could not be read is a gap, never a zero bar, and the table says so', () => {
    const out = html(
      <BarChart
        title="Volume"
        assetCode="USDT"
        tone="volume"
        points={[
          { day: '2026-10-13', value: '100' },
          { day: '2026-10-14', value: null },
          { day: '2026-10-15', value: '50' },
        ]}
      />,
    );
    expect(out).toContain('mp-chart__gap');
    expect(out).toContain('2026-10-14: could not be read');
    expect(out).toContain('1 day could not be read');
    expect(out).toContain('total <span class="mp-num">150.00</span>');
    expect(out).toContain('<caption');
    expect(out).toContain('role="img"');
  });

  it('draws bars in exact proportion using decimal strings beyond float precision', () => {
    const out = html(
      <BarChart
        title="Volume"
        assetCode="USDT"
        tone="volume"
        points={[
          { day: '2026-10-14', value: '9007199254740993' },
          { day: '2026-10-15', value: '4503599627370496.5' },
        ]}
      />,
    );
    const heights = [...out.matchAll(/class="mp-chart__bar"[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(heights).toHaveLength(2);
    expect(heights[0]).toBeGreaterThan(heights[1]!);
    expect(heights[1]! / heights[0]!).toBeCloseTo(0.5, 2);
  });

  it('says so when every day is zero', () => {
    expect(html(<BarChart title="Revenue" assetCode="USD" tone="revenue" points={[{ day: '2026-10-15', value: '0' }]} />)).toContain(
      'Every day in this range is zero',
    );
  });
});

describe('states', () => {
  it('an error is announced as an alert; empty and not-built are polite status', () => {
    expect(
      html(
        <StateBlock kind="error" title="x">
          y
        </StateBlock>,
      ),
    ).toContain('role="alert"');
    expect(
      html(
        <StateBlock kind="empty" title="x">
          y
        </StateBlock>,
      ),
    ).toContain('role="status"');
    expect(
      html(
        <StateBlock kind="not_built" title="x" requestId="r-1">
          y
        </StateBlock>,
      ),
    ).toContain('Request reference: r-1');
  });

  it('every failure kind has plain words and, where it helps, a retry', () => {
    const kinds = [
      { kind: 'not_built', procedure: 'p.q', requestId: null },
      { kind: 'forbidden', requestId: null },
      { kind: 'not_found', requestId: null },
      { kind: 'refused', refusal: { code: 'registries.version_conflict', message: '', status: 409 }, requestId: 'r' },
      { kind: 'unavailable', requestId: null },
      { kind: 'invalid', requestId: null },
    ] as const;
    for (const failure of kinds) {
      const out = html(<FailureState failure={failure} what="Thing" retryHref="/x" />);
      expect(out).toMatch(/role="(alert|status)"/);
      expect(out).not.toMatch(/registries\.version_conflict|undefined/);
    }
    expect(html(<FailureState failure={{ kind: 'unavailable', requestId: null }} what="Thing" retryHref="/x" />)).toContain('href="/x"');
  });

  it('a skeleton is one polite announcement, marked busy', () => {
    const out = html(<Skeleton rows={3} label="Loading table" />);
    expect(out).toContain('aria-busy="true"');
    expect(out.match(/Loading table/g)).toHaveLength(1);
  });
});

describe('module navigation', () => {
  it('the console nav has one Merchants entry pointing at the dashboard', () => {
    expect(MODULE_ROUTES.filter((r) => r.id === 'merchants')).toEqual([{ id: 'merchants', href: '/merchants', label: 'Merchants' }]);
  });

  it('section tabs know which page is current, and a merchant id counts as "All merchants"', () => {
    const current = (path: string) => MERCHANT_SECTIONS.filter((s) => s.match(path)).map((s) => s.label);
    expect(current('/merchants')).toEqual(['Dashboard']);
    expect(current('/merchants/all')).toEqual(['All merchants']);
    expect(current('/merchants/22222222-2222-4222-8222-222222222222')).toEqual(['All merchants']);
    expect(current('/merchants/registries/wallet-routes/new')).toEqual(['Wallet routes']);
    expect(current('/merchants/treasury')).toEqual(['Treasury and halts']);
  });
});

describe('registry form', () => {
  const venue: VenueView = {
    venueId: 'binance-testnet',
    displayName: 'Binance (testnet)',
    mode: 'testnet',
    priority: 10,
    enabled: true,
    minOrder: '10',
    maxOrder: '5000',
    supportedPairs: ['USDT/USD'],
    health: null,
    version: 4,
    updatedAt: '2026-10-14T10:00:00.000Z',
    updatedBy: 'u',
    routable: true,
    missing: [],
  };

  it('create starts switched off and cannot be switched on in the same change', () => {
    const out = html(<RegistryForm kind="venue" mode="create" expectedVersion={null} listHref="/merchants/registries/venues" />);
    expect(out).toMatch(/<input id="rf-enabled" type="checkbox" disabled=""/);
    expect(out).toContain('New entries start switched off');
  });

  it('edit locks the identifying field and fills the rest from the loaded entry', () => {
    const out = html(
      <RegistryForm
        kind="venue"
        mode="edit"
        initial={formFromView('venue', venue)}
        expectedVersion={4}
        lockedKeys={['venueId']}
        listHref="/merchants/registries/venues"
      />,
    );
    expect(out).toMatch(/id="rf-venueId"[^>]*disabled=""[^>]*value="binance-testnet"/);
    expect(out).toContain('value="5000"');
    expect(out).toContain('USDT/USD');
    expect(out).toContain('Switching a venue on needs a second founder');
  });

  it('every kind renders a required reason and the review button, and a cancel link', () => {
    for (const kind of ['venue', 'network', 'wallet_route'] as const) {
      const out = html(<RegistryForm kind={kind} mode="create" expectedVersion={null} listHref="/x" />);
      expect(out).toContain('for="rf-reason"');
      expect(out).toContain('Review change');
      expect(out).toContain('href="/x"');
    }
  });
});

describe('second founder panel', () => {
  const change = {
    venueId: 'v',
    displayName: 'V',
    mode: 'testnet',
    priority: 1,
    enabled: true,
    minOrder: '1',
    maxOrder: '2',
    supportedPairs: ['A/B'],
    expectedVersion: 1,
    reason: 'Because',
  };

  it('reads only the exact request shape the first founder copies', () => {
    expect(parseHandoff(JSON.stringify({ registry: 'venue', approvalId: 'ap-1', change }))).toMatchObject({
      registry: 'venue',
      approvalId: 'ap-1',
    });
    expect(parseHandoff('not json')).toBeNull();
    expect(parseHandoff(JSON.stringify({ registry: 'venue', approvalId: '', change }))).toBeNull();
    expect(parseHandoff(JSON.stringify({ registry: 'venue', approvalId: 'ap-1', change: { ...change, apiKey: 'x' } }))).toBeNull();
    expect(parseHandoff(JSON.stringify({ registry: 'nope', approvalId: 'ap-1', change }))).toBeNull();
  });

  it('is labelled and says you cannot approve your own change', () => {
    const out = html(<ApprovePanel />);
    expect(out).toContain('for="handoff"');
    expect(out).toContain('You cannot approve a change you requested yourself');
  });
});

describe('browser client', () => {
  afterEach(() => vi.unstubAllGlobals());
  const csrf = 'A'.repeat(43);

  it('fetches the session nonce first and sends it with the request, never a token', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return url === '/api/session'
          ? Response.json({ csrf })
          : Response.json({ ok: true, preview: { needsDualControl: false, reasons: [], actionType: 'a', payloadHash: 'h' } });
      }),
    );
    const reply = await postRegistry({ action: 'preview', registry: 'venue', change: { a: 1 } });
    expect(reply.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['/api/session', '/api/merchants/registries']);
    const headers = calls[1]!.init!.headers as Record<string, string>;
    expect(headers['x-intafaced-csrf']).toBe(csrf);
    expect(JSON.stringify(headers)).not.toMatch(/authorization|bearer/i);
    expect(calls[1]!.init!.cache).toBe('no-store');
  });

  it('signed-out, gate refusals and network failures all become plain refusals with nothing sent on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );
    const signedOut = await postRegistry({ action: 'reject', approvalId: 'x' });
    expect(signedOut.ok === false && signedOut.refusal.title).toBe('You are signed out');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/session' ? Response.json({ csrf }) : Response.json({ code: 'admin.founder_required' }, { status: 403 }),
      ),
    );
    const gate = await postRegistry({ action: 'reject', approvalId: 'x' });
    expect(gate.ok === false && gate.refusal.title).toBe('Not allowed');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/session') return Response.json({ csrf });
        throw new TypeError('network');
      }),
    );
    const down = await postRegistry({ action: 'reject', approvalId: 'x' });
    expect(down.ok === false && down.refusal.title).toBe('Could not reach the console');
    expect(down.ok === false && down.refusal.body).toContain('nothing was changed');
  });
});
