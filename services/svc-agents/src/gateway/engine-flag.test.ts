/**
 * Engine flag: the adapter class, never a free-text id.
 * Sandbox is the deterministic mock. Live is the upstream adapter. Unwired is unknown.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { ModelGateway } from './gateway.js';
import { engineOfAdapter, parseRoutingTable } from './routing.js';
import { MockModelProvider } from '../providers/mock.js';
import { UpstreamModelProvider } from '../providers/upstream.js';
import type { ModelProvider } from '../providers/provider.js';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';
import type { Guardrail } from '../fleet/guardrails.js';

const SECRET = 'agents-engine-flag-test-secret-32b';
const USER = '11111111-1111-4111-8111-111111111111';
const API_KEY = 'super-secret-key';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

function signed() {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['agents:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-engine',
  });
}

function guardrail(agentId: string, tasks: readonly string[]): Guardrail {
  return {
    agentId,
    version: 3,
    scopes: [],
    tools: [],
    limits: {
      maxActionsPerSession: 4,
      maxOutputTokensPerCall: 16,
      maxSpendPerSession: null,
      allowedModules: [],
      allowedTasks: tasks,
    },
  };
}

const table = parseRoutingTable({
  routes: [
    {
      task: 'mock.task',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 32,
      price: { inputPerMillion: '3', outputPerMillion: '15' },
    },
    {
      task: 'live.task',
      providerId: 'upstream',
      model: 'reasoning-md',
      maxOutputTokens: 32,
      price: { inputPerMillion: '3', outputPerMillion: '15' },
    },
    {
      task: 'missing.task',
      providerId: 'nowhere',
      model: 'reasoning-md',
      maxOutputTokens: 32,
      price: { inputPerMillion: '3', outputPerMillion: '15' },
    },
    {
      task: 'labelled.task',
      providerId: 'live',
      model: 'reasoning-md',
      maxOutputTokens: 32,
      price: { inputPerMillion: '3', outputPerMillion: '15' },
    },
  ],
});

describe('route and agent engine flag', () => {
  const gateway = new ModelGateway(
    [
      new MockModelProvider({ id: 'primary' }),
      new UpstreamModelProvider({ id: 'upstream', baseUrl: 'https://engine.internal', apiKey: API_KEY }),
      // The id says live. The class is the mock. The flag follows the class.
      new MockModelProvider({ id: 'live' }),
    ],
    table,
  );

  const definitions = new Map<string, Guardrail>([
    ['sand', guardrail('sand', ['mock.task'])],
    ['paid', guardrail('paid', ['live.task'])],
    ['open', guardrail('open', ['missing.task'])],
    ['mislabeled', guardrail('mislabeled', ['labelled.task'])],
  ]);

  const deps = {
    runtime: {
      agentDefinition: async (agentId: string) => {
        const found = definitions.get(agentId);
        return found ? { guardrail: found, enabled: true } : null;
      },
    } as unknown as AgentsRouterDeps['runtime'],
    gateway,
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'FEE',
  } satisfies Partial<AgentsRouterDeps>;

  const caller = createAgentsRouter(deps as AgentsRouterDeps).createCaller(signed());

  it('reports sandbox for the mock, live for the upstream adapter, unknown when unwired', async () => {
    const rows = await caller.routes.list();
    const byTask = Object.fromEntries(rows.map((row) => [row.task, row]));

    expect(byTask['mock.task']).toMatchObject({ engine: 'sandbox', metered: true });
    expect(byTask['live.task']).toMatchObject({ engine: 'live', metered: true });
    expect(byTask['missing.task']).toMatchObject({ engine: 'unknown', metered: true });
    expect(byTask['labelled.task']).toMatchObject({ engine: 'sandbox', metered: true });

    for (const row of rows) {
      const flagged = JSON.stringify({ engine: row.engine, metered: row.metered });
      expect(flagged).not.toContain(API_KEY);
      expect(flagged).not.toContain('15');
      expect(flagged).not.toContain('3');
    }
  });

  it('derives the agent engine from the adapters of its allowed tasks', async () => {
    expect(await caller.agent.get({ agentId: 'sand' })).toMatchObject({ engine: 'sandbox', metered: true });
    expect(await caller.agent.get({ agentId: 'paid' })).toMatchObject({ engine: 'live', metered: true });
    expect(await caller.agent.get({ agentId: 'open' })).toMatchObject({ engine: 'unknown', metered: true });
    expect(await caller.agent.get({ agentId: 'mislabeled' })).toMatchObject({ engine: 'sandbox', metered: true });
  });

  it('metered follows AGENTS_METERING_ENABLED and the route price, not the engine', async () => {
    const on = createAgentsRouter({ ...deps, meteringEnabled: true } as AgentsRouterDeps).createCaller(signed());
    const onByTask = Object.fromEntries((await on.routes.list()).map((row) => [row.task, row]));
    expect(onByTask['mock.task']).toMatchObject({ engine: 'sandbox', metered: true });
    expect(onByTask['live.task']).toMatchObject({ engine: 'live', metered: true });
    expect(onByTask['missing.task']).toMatchObject({ engine: 'unknown', metered: true });
    expect(await on.agent.get({ agentId: 'sand' })).toMatchObject({ engine: 'sandbox', metered: true });

    const off = createAgentsRouter({ ...deps, meteringEnabled: false } as AgentsRouterDeps).createCaller(signed());
    const offByTask = Object.fromEntries((await off.routes.list()).map((row) => [row.task, row]));
    for (const row of Object.values(offByTask)) expect(row.metered).toBe(false);
    expect(offByTask['mock.task']).toMatchObject({ engine: 'sandbox', metered: false });
    expect(offByTask['live.task']).toMatchObject({ engine: 'live', metered: false });
    expect(offByTask['missing.task']).toMatchObject({ engine: 'unknown', metered: false });
    expect(await off.agent.get({ agentId: 'sand' })).toMatchObject({ engine: 'sandbox', metered: false });
    expect(await off.agent.get({ agentId: 'paid' })).toMatchObject({ engine: 'live', metered: false });
    expect(await off.agent.get({ agentId: 'open' })).toMatchObject({ engine: 'unknown', metered: false });
    expect(await off.agent.get({ agentId: 'mislabeled' })).toMatchObject({ engine: 'sandbox', metered: false });

    const absent = createAgentsRouter(deps as AgentsRouterDeps).createCaller(signed());
    const absentByTask = Object.fromEntries((await absent.routes.list()).map((row) => [row.task, row]));
    expect(absentByTask['mock.task']).toMatchObject({ engine: 'sandbox', metered: true });

    const freeGateway = new ModelGateway(
      [new MockModelProvider({ id: 'primary' })],
      parseRoutingTable({
        routes: [
          {
            task: 'free.task',
            providerId: 'primary',
            model: 'reasoning-md',
            maxOutputTokens: 32,
            price: { inputPerMillion: '0', outputPerMillion: '0' },
          },
        ],
      }),
    );
    const free = createAgentsRouter({ ...deps, gateway: freeGateway, meteringEnabled: true } as AgentsRouterDeps).createCaller(signed());
    expect((await free.routes.list()).find((row) => row.task === 'free.task')).toMatchObject({
      engine: 'sandbox',
      metered: false,
    });
  });

  it('does not treat a non-adapter object as live because its id says so', () => {
    const stranger = { id: 'live', capabilities: ['complete'] } as unknown as ModelProvider;
    const odd = new ModelGateway([stranger], table);
    expect(odd.registeredProvider('live')?.id).toBe('live');
    expect(engineOfAdapter(odd.registeredProvider('live'))).toBe('unknown');
    expect(engineOfAdapter(odd.registeredProvider('missing'))).toBe('unknown');
  });
});
