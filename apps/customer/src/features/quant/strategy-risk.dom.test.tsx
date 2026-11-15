// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { QuantRiskScreen, QuantStrategyDetail } from '@intafaced/contracts/quant-algo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// J-algo-dev-05 #7: the trading switch is off by default; with a cap blank the service refuses it, the screen names the
// cap, and the switch stays off.
const BLANK: QuantRiskScreen = {
  strategyId: 's-test',
  caps: { depositPercent: null, maxPositionNotional: '10', maxDailyLoss: '10', equityFloor: '10' },
  floorPolicy: 'reduce_only',
  unset: ['depositPercent'],
  trading: { on: false, version: null, offByNewVersion: false },
  latestVersion: 1,
  updatedAt: '2026-11-15T00:00:00.000Z',
};
const query = vi.fn(async () => ({ ok: true as const, data: BLANK }));
const mutate = vi.fn(async (_service: string, procedure: string) =>
  procedure === 'risk.trading'
    ? { ok: false as const, reason: 'refused', message: 'quant.risk_cap_unset — trading stays off — still blank: Deposit-percentage cap' }
    : { ok: true as const, data: BLANK },
);
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => {
  const api = { query, mutate };
  return { useApi: () => api, useSession: () => ({ userId: 'u-test' }) };
});

const { StrategyRisk } = await import('./StrategyRisk');

async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<StrategyRisk strategy={{ id: 's-test' } as QuantStrategyDetail} />));
  await act(async () => {});
  return host;
}

describe('the risk screen trading switch', () => {
  it('starts off, and a refusal for a blank cap names it and leaves the switch off', async () => {
    const host = await mount();
    const toggle = host.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('[data-testid="quant-risk-unset"]')?.textContent).toBe('Still blank: Deposit-percentage cap.');
    await act(async () => toggle.click());
    expect(mutate).toHaveBeenCalledWith('quant', 'risk.trading', { strategyId: 's-test', on: true }, expect.anything());
    expect(host.querySelector('[data-testid="quant-risk-refusal"]')?.textContent).toBe(
      'Trading stays off. Set every cap first; still blank: Deposit-percentage cap.',
    );
    expect(host.querySelector('input[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(false);
  });

  it('shows every cap as its own input, the deposit percentage blank', async () => {
    const host = await mount();
    const caps = [...host.querySelectorAll('[data-testid="quant-risk-cap"] input')].map((el) => [
      el.getAttribute('data-cap'),
      (el as HTMLInputElement).value,
    ]);
    expect(caps).toEqual([
      ['depositPercent', ''],
      ['maxPositionNotional', '10'],
      ['maxDailyLoss', '10'],
      ['equityFloor', '10'],
    ]);
  });
});
