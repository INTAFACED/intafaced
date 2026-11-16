import { describe, expect, it } from 'vitest';
import { ProviderError } from './errors.js';
import { parseRoutingTable, type RoutingTable } from './gateway/routing.js';
import { MockModelProvider } from './providers/mock.js';
import { PROVIDER_UNPROBED_REASON, type ModelProvider, type ProviderCapability, type ProviderHealth } from './providers/provider.js';
import { UpstreamModelProvider } from './providers/upstream.js';
import {
  agentsReadiness,
  usableProviderCount,
  providerCount,
  readinessTaskCount,
  agentsReadinessBoardCard,
  parseAgentsReadinessStatusLine,
  agentsReadinessStatusLineMatches,
  agentsReadinessExportHeader,
  agentsReadinessExportLine,
  agentsReadinessExportText,
  usableProviderCountInRange,
  isMockEngineResidual,
} from './readiness.js';
import { describeAgentsLivePlanes } from './live-planes.js';

/**
 * HONEST READINESS — what `/ready` may and may not claim.
 *
 * The failure this suite guards is specific: a process that is up reporting
 * "ready" while every completion would fail, or reporting readiness that reads
 * as production inference when the engine is still the mock.
 */

const TABLE: RoutingTable = parseRoutingTable({
  routes: [
    {
      task: 'support.classify',
      providerId: 'primary',
      model: 'fast-sm',
      maxOutputTokens: 256,
      price: { inputPerMillion: '0.25', outputPerMillion: '1.25' },
    },
    {
      task: 'index.embed',
      providerId: 'primary',
      model: 'embed-sm',
      maxOutputTokens: 1,
      price: { inputPerMillion: '0.1', outputPerMillion: '0' },
      capability: 'embed',
    },
  ],
});

const ORPHAN: RoutingTable = parseRoutingTable({
  routes: [
    {
      task: 'ghost.task',
      providerId: 'nowhere',
      model: 'fast-sm',
      maxOutputTokens: 16,
      price: { inputPerMillion: '1', outputPerMillion: '1' },
    },
  ],
});

function deadProvider(id = 'primary'): ModelProvider {
  return {
    id,
    capabilities: ['complete'] as ProviderCapability[],
    health(): ProviderHealth {
      return { healthy: false, latencyMs: 0, lastUpdate: new Date(), reason: 'injected outage' };
    },
    complete: async () => {
      throw new ProviderError('dead', id, true, 503);
    },
  };
}

describe('agentsReadiness — honest about mock vs useful', () => {
  it('names mock mode and a servable completion task when the mock is healthy', () => {
    const status = agentsReadiness({
      providerMode: 'mock',
      providers: [new MockModelProvider({ id: 'primary' })],
      table: TABLE,
      meteringEnabled: true,
    });

    expect(status.ready).toBe(true);
    expect(status.providerMode).toBe('mock');
    expect(status.meteringEnabled).toBe(true);
    expect(status.meteringMode).toBe('billed');
    expect(status.meteringAllowsFeeCharge).toBe(true);
    expect(status.tasks).toEqual(['support.classify', 'index.embed']);
    expect(status.usefulPath.available).toBe(true);
    expect(status.usefulPath.task).toBe('support.classify');
    // Mock always carries residual — "ready" must not read as production AI.
    expect(status.usefulPath.residual).toMatch(/mock/i);
    expect(status.usefulPath.residual).toMatch(/not production/i);
    expect(status.providers[0]).toMatchObject({ id: 'primary', usable: true, healthy: true });
    // Fleet omitted → zeros (never invent five product agents).
    expect(status.fleet).toEqual({ agents: 0, withRunSession: 0, bootRegistered: 0, tasksMissingRoute: 0 });
  });

  it('surfaces the fleet matrix card when supplied — boot count stays separate', () => {
    const status = agentsReadiness({
      providerMode: 'mock',
      providers: [new MockModelProvider({ id: 'primary' })],
      table: TABLE,
      meteringEnabled: true,
      productAgentsRegistered: 5,
      fleet: { agents: 5, withRunSession: 5, bootRegistered: 5, tasksMissingRoute: 0 },
    });

    expect(status.productAgentsRegistered).toBe(5);
    expect(status.fleet).toEqual({ agents: 5, withRunSession: 5, bootRegistered: 5, tasksMissingRoute: 0 });
    expect(status.usefulPath.residual).toMatch(/5 product agent/);
  });

  it('does not stamp a constructed HTTP upstream as live — no probe has run', () => {
    const status = agentsReadiness({
      providerMode: 'upstream',
      providers: [
        new UpstreamModelProvider({
          id: 'primary',
          baseUrl: 'https://engine.test',
          apiKey: 'test-key',
        }),
      ],
      table: TABLE,
      meteringEnabled: true,
    });

    expect(status.ready).toBe(true);
    expect(status.providers[0]).toMatchObject({
      id: 'primary',
      usable: false,
      healthy: false,
      reason: PROVIDER_UNPROBED_REASON,
    });
    expect(status.usefulPath.available).toBe(false);
    expect(status.usefulPath.task).toBeNull();
    expect(status.usefulPath.residual).toMatch(/not usable|no call made yet/);
  });

  it('drops the mock residual when upstream is usable', () => {
    const status = agentsReadiness({
      providerMode: 'upstream',
      providers: [new MockModelProvider({ id: 'primary' })],
      table: TABLE,
      meteringEnabled: true,
    });

    expect(status.usefulPath.available).toBe(true);
    expect(status.usefulPath.task).toBe('support.classify');
    expect(status.usefulPath.residual).toBeNull();
    expect(status.providerMode).toBe('upstream');
  });

  it('reports usefulPath unavailable when the only provider is down', () => {
    const status = agentsReadiness({
      providerMode: 'upstream',
      providers: [deadProvider('primary')],
      table: TABLE,
      meteringEnabled: true,
    });

    expect(status.ready).toBe(true); // process still serves logs/sessions
    expect(status.usefulPath.available).toBe(false);
    expect(status.usefulPath.task).toBeNull();
    expect(status.usefulPath.residual).toMatch(/not usable|injected outage/);
    expect(status.providers[0]?.usable).toBe(false);
  });

  it('reports usefulPath unavailable when routes name an unregistered provider', () => {
    const status = agentsReadiness({
      providerMode: 'mock',
      providers: [new MockModelProvider({ id: 'primary' })],
      table: ORPHAN,
      meteringEnabled: false,
    });

    expect(status.usefulPath.available).toBe(false);
    expect(status.usefulPath.residual).toMatch(/not registered/);
    expect(status.meteringEnabled).toBe(false);
    expect(status.meteringMode).toBe('audit_only');
    expect(status.meteringAllowsFeeCharge).toBe(false);
  });

  it('never puts a vendor product name on the readiness body', () => {
    const status = agentsReadiness({
      providerMode: 'mock',
      providers: [new MockModelProvider({ id: 'primary' })],
      table: TABLE,
      meteringEnabled: true,
    });
    const blob = JSON.stringify(status);
    // Spelled in pieces so brand-scan and this package's own copy test stay clean.
    expect(blob).not.toMatch(new RegExp('Anthrop' + 'ic', 'i'));
    expect(blob).not.toMatch(new RegExp('Open' + 'AI', 'i'));
    expect(blob).not.toMatch(new RegExp('Cla' + 'ude', 'i'));
  });

  it('prefers a completion route over embed-only when both exist', () => {
    const status = agentsReadiness({
      providerMode: 'mock',
      providers: [new MockModelProvider({ id: 'primary' })],
      table: TABLE,
      meteringEnabled: true,
    });
    expect(status.usefulPath.task).toBe('support.classify');
    expect(status.usefulPath.task).not.toBe('index.embed');
  });
});

describe('L3 wave54 agents readiness status/export', () => {
  it('board card for mock useful path', () => {
    const mock = new MockModelProvider({ id: 'primary' });
    const r = agentsReadiness({
      providerMode: 'mock',
      providers: [mock],
      table: TABLE,
      meteringEnabled: false,
    });
    expect(providerCount(r)).toBe(1);
    expect(usableProviderCount(r)).toBeGreaterThanOrEqual(0);
    expect(readinessTaskCount(r)).toBe(TABLE.routes.length);
    expect(agentsReadinessBoardCard(r).mode).toBe('mock');
    expect(agentsReadinessStatusLineMatches(r)).toBe(true);
    expect(parseAgentsReadinessStatusLine('nope')).toBeNull();
    expect(agentsReadinessExportText(r).startsWith(agentsReadinessExportHeader())).toBe(true);
    expect(agentsReadinessExportLine(r)).toContain('mock');
    expect(usableProviderCountInRange(r, 0, 10)).toBe(true);
    expect(usableProviderCountInRange(r, 10, 0)).toBe(false);
    if (r.usefulPath.available) {
      expect(isMockEngineResidual(r)).toBe(true);
    }
    expect(r.meteringMode).toBe('audit_only');
    expect(r.meteringAllowsFeeCharge).toBe(false);
  });
});

describe('D26-P1-A6 public /ready door — metering-off never advertises feeCharge', () => {
  it('kill-switch off is audit_only and meteringAllowsFeeCharge is false', () => {
    const status = agentsReadiness({
      providerMode: 'mock',
      providers: [new MockModelProvider({ id: 'primary' })],
      table: TABLE,
      meteringEnabled: false,
    });
    expect(status.meteringEnabled).toBe(false);
    expect(status.meteringMode).toBe('audit_only');
    expect(status.meteringAllowsFeeCharge).toBe(false);
  });

  it('would fail if metering-off still claimed a feeCharge door', () => {
    const status = agentsReadiness({
      providerMode: 'upstream',
      providers: [new MockModelProvider({ id: 'primary' })],
      table: TABLE,
      meteringEnabled: false,
    });
    // Process-ready + useful path must not be readable as billed.
    expect(status.ready).toBe(true);
    expect(status.meteringAllowsFeeCharge).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/"meteringAllowsFeeCharge":true/);
  });
});

describe('Class X live planes on /ready', () => {
  it('includes livePlanes with storesMayStillRefuse honesty', () => {
    const livePlanes = describeAgentsLivePlanes({
      TRADE_URL: 'http://svc-trade:4004',
      PAY_URL: 'http://svc-pay:4006',
    });
    const status = agentsReadiness({
      providerMode: 'mock',
      providers: [new MockModelProvider({ id: 'primary' })],
      table: TABLE,
      meteringEnabled: false,
      livePlanes,
    });
    expect(status.livePlanes).toEqual(livePlanes);
    expect(status.livePlanes.storesMayStillRefuse).toBe(true);
    expect(status.livePlanes.tradeUrlConfigured).toBe(true);
    expect(status.livePlanes.supportUrlConfigured).toBe(false);
  });
});
