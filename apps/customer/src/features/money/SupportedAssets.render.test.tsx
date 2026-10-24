// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: {} }) }));
import { SupportedAssetsView } from './SupportedAssets';
import type { SupportedAsset } from './supported-assets-reads';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

async function mount(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
}
const row = (id: string) => host.querySelector(`tr[data-asset="${id}"]`)!;
const cell = (id: string, col: string) => row(id).querySelector(`[data-col="${col}"]`)!.textContent;

// TEST rows, not published settings.
const asset = (over: Partial<SupportedAsset>): SupportedAsset => ({
  assetId: 'USDT',
  kind: 'crypto',
  precision: 6,
  networks: [
    { networkId: 'ethereum', label: 'TEST Ethereum' },
    { networkId: 'base', label: 'TEST Base' },
  ],
  defaultNetworkId: 'ethereum',
  allowedActions: ['deposit', 'withdraw'],
  state: 'active',
  ...over,
});
const ready = (assets: SupportedAsset[]) => ({ status: 'ready', data: { assets } }) as const;

describe('supported assets and networks', () => {
  it('lists every row with its places, networks, actions and state; a retired or paused one allows nothing new and keeps its history link', async () => {
    await mount(
      <SupportedAssetsView
        resource={ready([
          asset({}),
          asset({ assetId: 'OLD', precision: 18, networks: [], defaultNetworkId: null, allowedActions: [], state: 'retired' }),
          asset({ assetId: 'PAUSED', precision: 2, state: 'halted' }),
        ])}
        reload={() => undefined}
      />,
    );
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(host.querySelector('[data-testid="supported-assets-count"]')!.textContent).toBe('Assets listed: 3. Retired: 1.');
    expect(cell('USDT', 'precision')).toBe('6');
    expect([...row('USDT').querySelectorAll('[data-col="networks"] li')].map((li) => li.textContent)).toEqual([
      'TEST Ethereum (default)',
      'TEST Base',
    ]);
    expect(cell('USDT', 'actions')).toBe('Deposit, Withdraw');
    expect(cell('USDT', 'state')).toBe('Active');
    expect(cell('OLD', 'networks')).toBe('No network');
    expect(cell('OLD', 'actions')).toBe('Nothing new');
    expect(cell('OLD', 'state')).toContain('Retired');
    expect(cell('OLD', 'state')).toContain('What you hold and your history with it stay.');
    expect(row('OLD').querySelector('a')!.getAttribute('href')).toBe('/money/balance/OLD');
    // A paused asset keeps its listed actions in the registry, but nothing new is allowed while it is paused.
    expect(cell('PAUSED', 'actions')).toBe('Nothing new');
    expect(cell('PAUSED', 'state')).toContain('Paused');
    expect(host.querySelector('a[href="/uc/recharge"]')).not.toBeNull();
    expect(host.querySelector('a[href="/uc/withdraw"]')).not.toBeNull();
  });

  it('an empty registry says nothing is published; a refusal is named with a retry; loading shows no rows', async () => {
    await mount(<SupportedAssetsView resource={ready([])} reload={() => undefined} />);
    expect(host.textContent).toContain('No asset is published');
    expect(host.querySelector('table')).toBeNull();
    const reload = vi.fn();
    const failed = { status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'The service did not answer' } } as const;
    await act(async () => root!.render(<SupportedAssetsView resource={failed} reload={reload} />));
    expect(host.querySelector('table')).toBeNull();
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => root!.render(<SupportedAssetsView resource={{ status: 'loading' }} reload={() => undefined} />));
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.querySelector('table')).toBeNull();
  });
});
