// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { StudioRules } from './studio-save';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// J-algo-dev-05 #4: Save on a form whose sizing rule is blank refuses naming it and sends nothing to the service.
const mutate = vi.fn(async () => ({ ok: false as const, reason: 'unreachable', message: 'not called' }));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => {
  const api = { query: mutate, mutate };
  return { useApi: () => api, useSession: () => ({ userId: 'u-test' }) };
});

const { StudioSave } = await import('./StudioSave');
const { newLink } = await import('./studio-save');

const complete: StudioRules = {
  name: 'TEST rules',
  cash: '1000',
  blocks: [],
  modules: {
    symbol: 'BTC/USDT',
    barSize: '1m',
    signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
    sizing: { kind: 'quantity', value: '0.01' },
    exit: { stopLossPercent: '', takeProfitPercent: '' },
    pyramiding: '2',
  },
  risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
};

async function press(rules: StudioRules) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<StudioSave rules={rules} link={newLink('TEST-draft')} onSaved={() => {}} />));
  const button = host.querySelector<HTMLButtonElement>('[data-testid="quant-save-library"]');
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  return host;
}

describe('Save to library with a blank sizing rule', () => {
  it('names the blank size and never calls the service', async () => {
    mutate.mockClear();
    const host = await press({ ...complete, modules: { ...complete.modules!, sizing: { kind: 'quantity', value: '' } } });
    expect(host.querySelector('[data-testid="quant-save-state"]')?.textContent).toBe(
      'Not saved. Still blank: Size. Studio never picks a value for you, so nothing was sent.',
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it('names every blank signal-rule input in the builder order', async () => {
    mutate.mockClear();
    const host = await press({ ...complete, modules: { ...complete.modules!, symbol: '', sizing: { kind: 'quantity', value: ' ' } } });
    expect(host.querySelector('[data-testid="quant-save-state"]')?.textContent).toContain('Still blank: Symbol, Size.');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('with every input filled, the same press sends the save', async () => {
    mutate.mockClear();
    await press(complete);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect((mutate.mock.calls[0] as unknown[])[1]).toBe('studio.save');
  });
});
