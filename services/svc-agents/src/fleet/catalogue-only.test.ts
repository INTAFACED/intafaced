import { describe, expect, it } from 'vitest';
import { CATALOGUE_ONLY_AGENTS, catalogueOnlyGuardrail, registerCatalogueOnlyAgents } from './catalogue-only.js';
import { parseGuardrail, type Guardrail } from './guardrails.js';
import { FLEET_PRODUCT_AGENTS } from './matrix.js';

describe('catalogue-only agents (J-agents-01 #1)', () => {
  it('stores the four agents the catalogue names that hold no tools, the two no customer can use disabled', () => {
    expect(CATALOGUE_ONLY_AGENTS).toEqual([
      { agentId: 'launch', enabled: true },
      { agentId: 'growth', enabled: true },
      { agentId: 'portfolio', enabled: false },
      { agentId: 'risk-compliance', enabled: false },
    ]);
    const fleet = new Set(FLEET_PRODUCT_AGENTS.map((row) => row.agentId));
    for (const row of CATALOGUE_ONLY_AGENTS) expect(fleet.has(row.agentId)).toBe(false);
  });
  it('each guardrail can call no tool and no engine task, and spends nothing', () => {
    for (const { agentId } of CATALOGUE_ONLY_AGENTS) {
      const g = catalogueOnlyGuardrail(agentId);
      expect(g.tools).toEqual([]);
      expect(g.scopes).toEqual([]);
      expect(g.limits.allowedTasks).toEqual([]);
      expect(g.limits.allowedModules).toEqual([]);
      expect(g.limits.maxSpendPerSession).toBe(0n);
      expect(g.capacityMode).toBe('research_only');
    }
  });
  it('registers each with its insert-time enabled, through the same upsert that keeps an operator’s switch', async () => {
    const calls: { agentId: string; enabled: boolean | undefined }[] = [];
    const runtime = {
      async registerAgent(input: unknown, options?: { enabled?: boolean }): Promise<Guardrail> {
        const g = parseGuardrail(input);
        calls.push({ agentId: g.agentId, enabled: options?.enabled });
        return g;
      },
    };
    expect(await registerCatalogueOnlyAgents(runtime)).toEqual(['launch', 'growth', 'portfolio', 'risk-compliance']);
    expect(calls).toEqual(CATALOGUE_ONLY_AGENTS.map((row) => ({ agentId: row.agentId, enabled: row.enabled })));
  });
});
