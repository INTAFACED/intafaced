import { describe, expect, it } from 'vitest';
import {
  canAddToWallet,
  FORBIDDEN_NETWORK_KINDS,
  NETWORK_KINDS,
  networkEntrySchema,
  protocolCapabilitiesOutputSchema,
  protocolDeploymentsOutputSchema,
  protocolNetworksListOutputSchema,
  routerIsSunset,
} from './protocol-networks.js';

const bare = {
  chainId: 84532,
  name: 'Base Sepolia',
  kind: 'testnet',
  nativeCurrency: null,
  rpcUrls: null,
  blockTimeSeconds: null,
  explorerUrls: null,
  faucets: null,
  ecosystem: null,
} as const;

describe('network entries', () => {
  it('never carries mainnet or intachain as a kind', () => {
    expect([...NETWORK_KINDS]).toEqual(['testnet', 'local', 'unconfirmed']);
    for (const kind of FORBIDDEN_NETWORK_KINDS) expect(networkEntrySchema.safeParse({ ...bare, kind }).success, kind).toBe(false);
  });

  it('accepts a network with everything unpublished (null is not published)', () => {
    expect(networkEntrySchema.parse(bare)).toEqual(bare);
  });

  it('requires https for faucets, explorers and ecosystem links, and http(s) for RPC', () => {
    expect(networkEntrySchema.safeParse({ ...bare, faucets: [{ name: 'f', url: 'http://faucet.test' }] }).success).toBe(false);
    expect(networkEntrySchema.safeParse({ ...bare, explorerUrls: ['http://scan.test'] }).success).toBe(false);
    expect(networkEntrySchema.safeParse({ ...bare, ecosystem: [{ name: 'x', url: 'ftp://x.test', kind: 'tool' }] }).success).toBe(false);
    expect(networkEntrySchema.safeParse({ ...bare, rpcUrls: ['ftp://rpc.test'] }).success).toBe(false);
    expect(networkEntrySchema.safeParse({ ...bare, rpcUrls: ['http://localhost:8545'] }).success).toBe(true);
  });

  it('offers Add to wallet only when the RPC URL and the currency are both published', () => {
    const currency = { name: 'TEST Ether', symbol: 'tETH', decimals: 18 };
    expect(canAddToWallet(bare)).toBe(false);
    expect(canAddToWallet({ rpcUrls: ['https://rpc.test'], nativeCurrency: null })).toBe(false);
    expect(canAddToWallet({ rpcUrls: null, nativeCurrency: currency })).toBe(false);
    expect(canAddToWallet({ rpcUrls: ['https://rpc.test'], nativeCurrency: currency })).toBe(true);
  });

  it('lists are strict', () => {
    expect(protocolNetworksListOutputSchema.safeParse({ networks: [bare] }).success).toBe(true);
    expect(protocolNetworksListOutputSchema.safeParse({ networks: [bare], extra: 1 }).success).toBe(false);
  });
});

describe('deployments and capabilities', () => {
  const address = '0x8d28045bbe8a1aed986751257c5711524a7ec73f';
  const out = {
    chainId: 84532,
    chainName: 'base-sepolia',
    deployedAt: null,
    contracts: [{ name: 'SovereignRouter', suite: 'router', address, verified: false, explorerUrl: null }],
    routers: [{ name: 'SovereignRouter', address, version: 'v1', deployedAt: null, verified: false, sunsetAt: null }],
  };

  it('parses a deployments answer and rejects a non-address', () => {
    expect(protocolDeploymentsOutputSchema.safeParse(out).success).toBe(true);
    expect(protocolDeploymentsOutputSchema.safeParse({ ...out, contracts: [{ ...out.contracts[0], address: '0x1' }] }).success).toBe(false);
  });

  it('calls a router sunset only when a date is published and has passed', () => {
    const now = new Date('2026-10-20T00:00:00.000Z');
    expect(routerIsSunset({ sunsetAt: null }, now)).toBe(false);
    expect(routerIsSunset({ sunsetAt: '2026-10-21T00:00:00.000Z' }, now)).toBe(false);
    expect(routerIsSunset({ sunsetAt: '2026-10-20T00:00:00.000Z' }, now)).toBe(true);
    expect(routerIsSunset({ sunsetAt: '2026-01-01T00:00:00.000Z' }, now)).toBe(true);
  });

  it('keeps capabilities honest: unknowns are null, preconfirmations are never "offered"', () => {
    const caps = {
      chainId: 84532,
      probed: false,
      pendingTag: null,
      bundlerReachable: null,
      paymasterFunded: null,
      preconfirmations: 'unknown',
    };
    expect(protocolCapabilitiesOutputSchema.safeParse(caps).success).toBe(true);
    expect(protocolCapabilitiesOutputSchema.safeParse({ ...caps, preconfirmations: 'offered' }).success).toBe(false);
  });
});
