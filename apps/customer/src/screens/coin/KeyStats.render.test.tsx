// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supportedAssetsSchema, type SupportedAssets } from '../../features/money/supported-assets-reads';

let registry: SupportedAssets;
vi.mock('./deps', async (original) => {
  const real = await original<typeof import('./deps')>();
  return {
    ...real,
    usePreferences: () => ({ timeZone: 'UTC' }),
    useSupportedAssets: () => ({ resource: { status: 'ready', data: registry } }),
  };
});
import { KeyStats } from './KeyStats';

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
});

async function mount() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<KeyStats asset="USDC" symbol={null} tickSize={null} portfolio={{ status: 'empty' }} />));
}

/** TEST rows, not published settings; parsed as the page parses svc-bank's reply. */
const usdc = (networks: unknown[]) =>
  supportedAssetsSchema.parse({
    assets: [
      {
        assetId: 'USDC',
        kind: 'crypto',
        precision: 6,
        networks,
        defaultNetworkId: 'ethereum',
        allowedActions: ['deposit'],
        state: 'active',
      },
    ],
  });

describe('coin key stats: network, contract and links where known (J-portfolio-10 #3)', () => {
  it('shows a network contract and its links where the registry knows them, and no row for a network that knows neither', async () => {
    registry = usdc([
      {
        networkId: 'ethereum',
        label: 'TEST Ethereum',
        contract: '0x7e57000000000000000000000000000000000001',
        links: [{ label: 'TEST explorer', url: 'https://example.com/test-explorer/usdc' }],
      },
      { networkId: 'base', label: 'TEST Base', contract: null, links: [] },
    ]);
    await mount();
    expect(host.querySelector('[data-testid="coin-network"] .coin-stats__value')!.textContent).toBe('TEST Ethereum, TEST Base');
    const details = host.querySelectorAll('[data-testid="coin-network-detail"]');
    expect([...details].map((d) => d.getAttribute('data-network'))).toEqual(['ethereum']);
    expect(details[0]!.textContent).toContain('On TEST Ethereum');
    expect(details[0]!.querySelector('[data-testid="coin-contract"]')!.textContent).toBe('0x7e57000000000000000000000000000000000001');
    const link = details[0]!.querySelector('a')!;
    expect([link.textContent, link.getAttribute('href'), link.getAttribute('rel')]).toEqual([
      'TEST explorer',
      'https://example.com/test-explorer/usdc',
      'noopener noreferrer',
    ]);
  });

  it('a registry reply with no contract or link fields shows none, never a guess', async () => {
    registry = usdc([{ networkId: 'ethereum', label: 'TEST Ethereum' }]);
    await mount();
    expect(host.querySelectorAll('[data-testid="coin-network-detail"]')).toHaveLength(0);
    expect(host.querySelectorAll('a')).toHaveLength(0);
  });

  it('refuses a link that is not https in the reply', () => {
    expect(() =>
      usdc([{ networkId: 'ethereum', label: 'TEST Ethereum', contract: null, links: [{ label: 'x', url: 'javascript:alert(1)' }] }]),
    ).toThrow();
  });
});
