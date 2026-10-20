import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { NetworkEntry } from '@intafaced/contracts/protocol-networks';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const answers: Record<string, unknown> = {};
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  return { ...real, useApi: () => ({ query: () => new Promise(() => undefined) }) as never };
});
vi.mock('../../shared/resource', () => ({
  useResource: (_load: unknown, key: string) => ({ resource: answers[key] ?? { status: 'loading' }, reload: () => undefined }),
}));
import { protocolCopy } from './copy';
import { addChainParams, ContractsPanel, NetworkPanel, SupportedNetworksPanel } from './NetworkPanels';

const { t } = protocolCopy.forLocale('en');
const bare: NetworkEntry = {
  chainId: 84532,
  name: 'Base Sepolia test network',
  kind: 'testnet',
  nativeCurrency: null,
  rpcUrls: null,
  blockTimeSeconds: null,
  explorerUrls: null,
  faucets: null,
  ecosystem: null,
};
const ready84532 = { status: 'ready' as const, chainId: 84532 };
const ready = (data: unknown) => ({ status: 'ready', data });
const full: NetworkEntry = {
  ...bare,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.example'],
  explorerUrls: ['https://explorer.example'],
  faucets: [{ name: 'Faucet one', url: 'https://faucet.example' }],
};

describe('Network card', () => {
  it('shows only what is published, disables Add to wallet and names why, and lists None listed', () => {
    answers['protocol-room:networks'] = ready({ networks: [bare] });
    const html = renderToStaticMarkup(<NetworkPanel chain={ready84532} t={t} />);
    expect(html).toContain('Base Sepolia test network');
    expect(html).toContain('Not published');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Add to wallet/);
    expect(html).toContain('protocol.network_params_unset');
    expect(html).toContain('Gas troubleshooting');
    expect(html).toContain('Faucets');
    expect(html).toContain('Ecosystem');
    expect(html.match(/None listed\./g)).toHaveLength(3);
    expect(html).not.toMatch(/mainnet|INTACHAIN network/i);
  });
  it('with every wallet parameter published it asks only for a wallet, and links https addresses', () => {
    answers['protocol-room:networks'] = ready({ networks: [full] });
    const html = renderToStaticMarkup(<NetworkPanel chain={ready84532} t={t} />);
    expect(html).toContain('no browser wallet was found');
    expect(html).not.toContain('protocol.network_params_unset');
    expect(html).toContain('href="https://faucet.example"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it('builds the wallet_addEthereumChain parameters from published fields only', () => {
    expect(addChainParams(bare)).toBeNull();
    expect(addChainParams(full)).toEqual({
      chainId: '0x14a34',
      chainName: 'Base Sepolia test network',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://rpc.example'],
      blockExplorerUrls: ['https://explorer.example'],
    });
  });
  it('says so when no entry is published for the configured chain', () => {
    answers['protocol-room:networks'] = ready({ networks: [bare] });
    expect(renderToStaticMarkup(<NetworkPanel chain={{ status: 'ready', chainId: 1 }} t={t} />)).toContain(
      'No entry is published for this chain.',
    );
  });
});

describe('Deployed contracts and supported networks', () => {
  it('renders the service record and never a built-in list', () => {
    answers['protocol-room:deployments:84532'] = ready({
      chainId: 84532,
      chainName: 'Base Sepolia',
      deployedAt: null,
      routers: [],
      contracts: [{ name: 'PoolFactory', suite: 'amm', address: '0x' + '1'.repeat(40), verified: false, explorerUrl: null }],
    });
    const html = renderToStaticMarkup(<ContractsPanel chain={ready84532} t={t} />);
    expect(html).toContain('PoolFactory');
    expect(html).toContain('0x' + '1'.repeat(40));
    answers['protocol-room:deployments:84532'] = { status: 'loading' };
    expect(renderToStaticMarkup(<ContractsPanel chain={ready84532} t={t} />)).not.toContain('PoolFactory');
    for (const chain of [
      { status: 'loading' as const },
      { status: 'failed' as const, failure: { ok: false as const, reason: 'unreachable' as const, message: 'x' }, reload: () => undefined },
    ]) {
      const loadingOrFailed =
        renderToStaticMarkup(<ContractsPanel chain={chain} t={t} />) + renderToStaticMarkup(<NetworkPanel chain={chain} t={t} />);
      expect(loadingOrFailed).not.toContain('No deployment is recorded');
      expect(loadingOrFailed).not.toContain('No entry is published');
    }
    expect(renderToStaticMarkup(<ContractsPanel chain={{ status: 'loading' }} t={t} />)).toContain('Checking');
  });
  it('lists router versions per chain, marks a past sunset, and gives a chain with none one honest row', () => {
    const router = (version: string, sunsetAt: string | null, address: string) => ({
      name: 'SovereignRouter',
      address,
      version,
      deployedAt: null,
      verified: false,
      sunsetAt,
    });
    answers['protocol-room:supported-networks'] = ready([
      {
        chainId: 84532,
        name: 'Base Sepolia test network',
        deployments: {
          chainId: 84532,
          chainName: 'Base Sepolia',
          deployedAt: null,
          contracts: [],
          routers: [router('v1', '2026-01-01T00:00:00.000Z', '0x' + 'a'.repeat(40)), router('v2', null, '0x' + 'b'.repeat(40))],
        },
      },
      { chainId: 31337, name: 'Local test chain', deployments: 'unrecorded' },
      { chainId: 1337, name: 'Odd chain', deployments: 'unreadable' },
    ]);
    const html = renderToStaticMarkup(<SupportedNetworksPanel t={t} now={new Date('2026-10-20T00:00:00Z')} />);
    expect(html).toContain('>Sunset<');
    expect(html).toContain('None published');
    expect(html).toContain('No router recorded');
    expect(html).toContain('Local test chain (31337)');
    expect(html).toContain('Could not read the deployment record for this chain.');
  });
  it('keeps no hand copy of a deployment record in the app', () => {
    const root = join(__dirname, '..', '..');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [join(dir, entry.name)] : [],
      );
    const offenders = walk(root).filter(
      (file) =>
        !file.endsWith('network-panels.test.tsx') &&
        /BASE_SEPOLIA_DEPLOYMENT|0x780627a9d781edf08bd81fbf2263fa85dd8c135e/i.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
