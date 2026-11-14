import { describe, expect, it } from 'vitest';
import type { RegistryAsset } from '@intafaced/contracts';
import { listSupportedAssets, memoryAssetRegistry } from './supported-assets.js';

/** Test rows, not owner values. */
const row = (networks: RegistryAsset['networks']): RegistryAsset => ({
  id: 'TESTCOIN',
  kind: 'crypto',
  precision: 6,
  networks,
  defaultNetworkId: networks[0]?.networkId ?? null,
  allowedActions: ['deposit', 'withdraw'],
  state: 'active',
  revision: 1,
  updatedAt: '2026-11-12T00:00:00.000Z',
});

describe('listSupportedAssets: contract and links where known (J-portfolio-10 #3)', () => {
  it('hands on a network contract and its links as the registry publishes them', async () => {
    const [asset] = await listSupportedAssets(
      memoryAssetRegistry([
        row([
          { networkId: 'test-a', label: 'TEST A', contract: '0x7e57', links: [{ label: 'TEST explorer', url: 'https://example.com/a' }] },
          { networkId: 'test-b', label: 'TEST B' },
        ]),
      ]),
    );
    expect(asset!.networks).toEqual([
      { networkId: 'test-a', label: 'TEST A', contract: '0x7e57', links: [{ label: 'TEST explorer', url: 'https://example.com/a' }] },
      // Not known: null and empty, never guessed.
      { networkId: 'test-b', label: 'TEST B', contract: null, links: [] },
    ]);
  });
});
