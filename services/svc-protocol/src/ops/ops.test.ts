/**
 * Protocol ops desk reads (D-order-controls-04): the label audit and the metrics read.
 *
 * Promise: the label audit lists every label and audited flag this service serves and turns FAIL on a mainnet claim or
 * `audited: true`; a source that fails reads "could not load", never zero; a blank metrics window refuses `owner.decision`;
 * the desk answers only the founder and compliance scopes. The hide, delist and restore writes live in svc-ops.
 * Break: a planted violation passes; a failed source shows 0; a window is invented; a plain read scope opens the desk.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type NetworkEntry } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { serviceLabelEntries } from './labels.js';
import { buildMetrics, OPS_SOURCE_UNAVAILABLE } from './metrics.js';

describe('labels', () => {
  const audit = { id: 'smart-accounts', audited: false };
  const network = (name: string): NetworkEntry => ({
    chainId: 1,
    name,
    kind: 'testnet',
    nativeCurrency: null,
    rpcUrls: null,
    blockTimeSeconds: null,
    explorerUrls: null,
    faucets: null,
    ecosystem: null,
  });
  it('lists every place the service serves a label or an audited flag, and passes honest ones', async () => {
    const { labelsOutput } = await import('./labels.js');
    const out = labelsOutput(
      serviceLabelEntries({ networks: [network('Base Sepolia test network')], configuredChainId: 84532, audit }),
      new Date(),
    );
    expect(out.verdict).toEqual({ pass: true, violations: [] });
    expect(out.entries.map((e) => e.where)).toEqual([
      'protocol.networks.list:1',
      'protocol.chainStatus:84532',
      'protocol.auditStatus:smart-accounts',
    ]);
  });
  it('turns FAIL on a planted mainnet claim or audited: true', async () => {
    const { labelsOutput } = await import('./labels.js');
    expect(
      labelsOutput(serviceLabelEntries({ networks: [network('INTACHAIN mainnet')], configuredChainId: 84532, audit }), new Date()).verdict
        .pass,
    ).toBe(false);
    expect(
      labelsOutput(serviceLabelEntries({ networks: [], configuredChainId: 84532, audit: { ...audit, audited: true } }), new Date()).verdict
        .violations,
    ).toEqual([{ where: 'protocol.auditStatus:smart-accounts', reason: 'audited_true' }]);
  });
});

describe('metrics', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const down = { status: 'down', reason: 'unreachable', message: 'x' } as const;
  it('reads a source that cannot be read as could not load with the time tried, never zero', () => {
    const out = buildMetrics({
      now,
      windowSeconds: 3600,
      indexer: down,
      dex: { status: 'down', reason: 'not_connected', message: 'x', code: 'edge.upstream_unwired' },
      chainReachable: null,
    });
    for (const reading of [out.quotes, out.wallets, out.refusalsByCode]) {
      expect(reading).toEqual({ status: 'could_not_load', triedAt: now.toISOString(), code: OPS_SOURCE_UNAVAILABLE });
    }
    expect(out.indexerLagBlocks).toMatchObject({ status: 'could_not_load', code: 'unreachable' });
    expect(out.window).toEqual({ from: '2026-10-20T11:00:00.000Z', to: now.toISOString() });
    expect(out.sections.find((s) => s.section === 'indexer')?.health).toBe('down');
    expect(out.sections.find((s) => s.section === 'chain')?.health).toBe('unknown');
    for (const section of ['audit', 'blockers', 'contracts', 'labels'] as const) {
      expect(out.sections.find((s) => s.section === section)?.health).toBe('unknown');
    }
    expect(out.sections.find((s) => s.section === 'metrics')?.health).toBe('ok');
  });
});

describe('ops over tRPC', () => {
  const SECRET = 'a-protocol-ops-desk-test-edge-secret-of-length';
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });
  const principal = (scopes: string[]): Principal =>
    ({
      sub: '11111111-1111-4111-8111-111111111111',
      userId: '11111111-1111-4111-8111-111111111111',
      sid: '22222222-2222-4222-8222-222222222222',
      scopes,
      tier: 'none',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    }) as Principal;
  const as = (scopes: string[]) => {
    const raw = encodePrincipal(principal(scopes));
    return edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-ops',
    });
  };
  const caller = (scopes: string[], over: Partial<ProtocolRouterDeps> = {}) => {
    const deps = {
      chain: { config: { chainId: 84532, factory: '0x0', implementation: '0x0' }, status: async () => ({ reachable: true }) },
      registry: {},
      relay: {},
      relayEnabled: () => true,
      ammFactoryAddress: () => '0x0',
      swapSlippageBps: () => null,
      ...over,
    } as unknown as ProtocolRouterDeps;
    return createProtocolRouter(deps).createCaller(as(scopes));
  };

  it('keeps the desk behind the founder desk scopes', async () => {
    const reader = caller(['protocol:read']);
    await expect(reader.ops.labels()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reader.ops.metrics({ windowSeconds: 3600 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(['admin:read']).ops.labels()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses the metrics read owner.decision while no window is published, and serves it once one is named', async () => {
    const api = caller(['admin:read']);
    await expect(api.ops.metrics()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('owner.decision'),
    });
    const out = await api.ops.metrics({ windowSeconds: 3600 });
    expect(out.quotes.status).toBe('could_not_load');
  });

  it('serves the label audit to the compliance scope with a PASS on the shipped registry', async () => {
    const out = await caller(['admin:compliance']).ops.labels();
    expect(out.verdict.pass).toBe(true);
    expect(out.entries.length).toBeGreaterThan(0);
  });
});
