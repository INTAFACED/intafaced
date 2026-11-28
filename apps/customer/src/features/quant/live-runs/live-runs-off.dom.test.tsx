// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// With svc-trade's user-venue door off, /quant/live says so in words and never shows the service's raw sentence.
const RAW = 'the user-venue door is off on this deployment (TRADE_USER_VENUE_URL unset)';
const rest = vi.fn();
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../session/session', () => {
  const api = { rest };
  return { useApi: () => api, useSession: () => ({ userId: 'u-test' }) };
});

const { LiveRunsRoom } = await import('./LiveRunsRoom');

async function open() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<LiveRunsRoom />));
  await act(async () => {});
  return host;
}

describe('/quant/live', () => {
  it('says live trading is off here, in words, with no config name', async () => {
    rest.mockResolvedValue({ ok: false, reason: 'not_found', status: 404, code: 'trade.user_venue_off', message: RAW });
    const host = await open();
    expect(host.querySelector('[data-testid="live-runs-off"]')?.textContent).toBe(
      'Live trading on your own venue account is off on this service, so no strategy can run live. Your strategies, backtests and paper runs still work.',
    );
    expect(host.textContent).not.toContain('TRADE_USER_VENUE_URL');
    expect(host.querySelector('[data-testid="live-run-row"]')).toBeNull();
  });

  it('lists the runs when the door is on, and says none when there are none', async () => {
    rest.mockResolvedValue({ ok: true, data: { runs: [] } });
    const host = await open();
    expect(host.querySelector('[data-testid="live-runs-off"]')).toBeNull();
    expect(host.textContent).toContain('No live run is on this account.');
  });
});
