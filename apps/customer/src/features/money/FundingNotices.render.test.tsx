// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = vi.hoisted(() => ({ language: 'en' }));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => ({ ...real.currentPreferences(), language: preferences.language }) };
});
import { FundingNoticesView } from './FundingNotices';
import type { FundingNotice, FundingNotices } from './funding-notices-reads';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  preferences.language = 'en';
  act(() => root?.unmount());
  root = null;
  host.remove();
});

async function mount(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
}

// TEST notices, not published ones.
const notice = (over: Partial<FundingNotice>): FundingNotice => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'incident',
  title: 'TEST delayed deposits',
  body: 'TEST we are looking into it',
  status: 'published',
  version: 1,
  changelog: null,
  publishedAt: '2026-10-24T10:00:00.000Z',
  startsAt: '2026-10-24T09:59:00.000Z',
  endsAt: '2026-10-24T12:00:00.000Z',
  asset: 'USDT',
  network: 'ethereum',
  phase: 'investigating',
  ...over,
});
const ready = (data: Partial<FundingNotices>) => ({
  status: 'ready' as const,
  data: { asset: 'USDT', network: 'ethereum', incidents: [], maintenance: [], ...data },
});

describe('FundingNoticesView', () => {
  it('shows an open incident with its newest stage, when it started and when it was last updated', async () => {
    const root = notice({});
    const latest = notice({
      id: '00000000-0000-4000-8000-000000000002',
      body: 'TEST cause found, a fix is going out',
      publishedAt: '2026-10-24T11:00:00.000Z',
      phase: 'identified',
    });
    await mount(<FundingNoticesView asset="USDT" networkLabel="TEST Ethereum" notices={ready({ incidents: [{ root, latest }] })} />);
    const card = host.querySelector(`[data-testid="funding-incident-${root.id}"]`)!;
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.textContent).toContain('Incident on USDT on TEST Ethereum');
    expect(card.querySelector('h4')!.textContent).toBe('TEST delayed deposits');
    expect(card.querySelector('[data-testid="funding-incident-stage"]')!.textContent).toBe('Stage: Cause identified');
    const dates = card.querySelector('[data-testid="funding-incident-dates"]')!.textContent!;
    expect(dates).toMatch(/^Started .+ · Last update .+$/);
    expect(card.textContent).toContain('TEST cause found, a fix is going out');
    expect(card.textContent).not.toContain('TEST we are looking into it');
  });

  it('an incident with no update yet shows only when it started', async () => {
    const root = notice({});
    await mount(<FundingNoticesView asset="USDT" networkLabel="TEST Ethereum" notices={ready({ incidents: [{ root, latest: root }] })} />);
    expect(host.querySelector('[data-testid="funding-incident-stage"]')!.textContent).toBe('Stage: Investigating');
    expect(host.querySelector('[data-testid="funding-incident-dates"]')!.textContent).not.toContain('Last update');
  });

  it('shows a maintenance window with its start and end, or says the end is not given', async () => {
    const closed = notice({ id: '00000000-0000-4000-8000-000000000003', kind: 'maintenance', phase: null, title: 'TEST node upgrade' });
    const open = notice({ id: '00000000-0000-4000-8000-000000000004', kind: 'maintenance', phase: null, endsAt: null });
    await mount(<FundingNoticesView asset="USDT" networkLabel="TEST Ethereum" notices={ready({ maintenance: [closed, open] })} />);
    const windowOf = (id: string) =>
      host.querySelector(`[data-testid="funding-maintenance-${id}"] [data-testid="funding-maintenance-window"]`)!.textContent!;
    expect(host.textContent).toContain('Maintenance on USDT on TEST Ethereum');
    expect(windowOf(closed.id)).toMatch(/^From .+ to .+$/);
    expect(windowOf(open.id)).toMatch(/^From .+, end not given$/);
  });

  it('says where the read stands: nothing open is an answer; a failed read says so and points to the status page', async () => {
    await mount(<FundingNoticesView asset="USDT" networkLabel="TEST Ethereum" notices={{ status: 'loading' }} />);
    expect(host.querySelector('[data-testid="funding-notices"]')!.getAttribute('data-state')).toBe('loading');
    await act(async () => root!.render(<FundingNoticesView asset="USDT" networkLabel="TEST Ethereum" notices={ready({})} />));
    const wrapper = host.querySelector('[data-testid="funding-notices"]')!;
    expect(wrapper.getAttribute('data-state')).toBe('none');
    expect(wrapper.textContent).toBe('');
    await act(async () =>
      root!.render(
        <FundingNoticesView
          asset="USDT"
          networkLabel="TEST Ethereum"
          notices={{ status: 'failed', failure: { ok: false, reason: 'http', code: 'notify.notices_unavailable', message: 'x' } as never }}
        />,
      ),
    );
    expect(host.querySelector('[data-testid="funding-notices"]')!.getAttribute('data-state')).toBe('failed');
    const failed = host.querySelector('[data-testid="funding-notices-failed"]')!;
    expect(failed.textContent).toContain('Notices for USDT on TEST Ethereum could not be loaded.');
    expect(failed.querySelector('a')!.getAttribute('href')).toBe('/status');
  });

  it('dates read in the language the person chose, with the zone named', async () => {
    const root = notice({ startsAt: '2026-10-24T10:00:00.000Z' });
    const spanish = new Intl.DateTimeFormat('es', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(Date.parse('2026-10-24T10:00:00.000Z'));
    preferences.language = 'es';
    await mount(<FundingNoticesView asset="USDT" networkLabel="TEST Ethereum" notices={ready({ incidents: [{ root, latest: root }] })} />);
    expect(host.querySelector('[data-testid="funding-incident-dates"]')!.textContent).toBe(`Empezó el ${spanish}`);
  });
});
