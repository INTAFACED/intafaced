/**
 * Done bar: product agents cannot grant pay/ledger **scopes** (edge JWT scopes)
 * and cannot grant money-write **tools**. Routes stay on agents:read / agents:execute
 * (settlement is HMAC as svc-agents). A silent scopedProcedure('pay:write') would be a
 * second money door.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLEET_HARD_MONEY_WRITE_TOOLS, PRODUCT_AGENT_IDS, isFleetHardMoneyWriteTool, parseGuardrail } from './guardrails.js';
import { FLEET_PRODUCT_AGENTS } from './matrix.js';
import { navigatorAgentGuardrail } from '../navigator/guardrail.js';
import { supportAgentGuardrail } from '../support-agent/guardrail.js';
import { scannerAgentGuardrail } from '../scanner/guardrail.js';
import { merchantAgentGuardrail } from '../merchant/guardrail.js';
import { copyIntelAgentGuardrail } from '../copy-intel/guardrail.js';

function routerSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '../router.ts'), 'utf8');
}

/** Collect scopedProcedure('…') first-arg string literals in router.ts. */
function routerScopes(src: string): readonly string[] {
  const scopes: string[] = [];
  for (const m of src.matchAll(/scopedProcedure\(\s*'([^']+)'/g)) {
    scopes.push(m[1]!);
  }
  return scopes;
}

describe('money-scope honesty (product agents)', () => {
  it('router never grants pay:/ledger:/bank: scopes — only agents; settle is HMAC', () => {
    const src = routerSource();
    const scopes = routerScopes(src);
    expect(scopes.length).toBeGreaterThan(10);
    const banned = scopes.filter((s) => /^(pay|ledger|bank|trade|p2p):/.test(s));
    expect(banned, `money/trade scopes on agents router: ${banned.join(', ')}`).toEqual([]);
    for (const s of scopes) {
      expect(s === 'agents:read' || s === 'agents:execute' || s === 'admin:read').toBe(true);
    }
    expect(src).toMatch(/settleWriteProcedure/);
    expect(src).not.toMatch(/scopedProcedure\('admin:write'/);
  });

  it('no product factory grants a hard money-write tool', () => {
    for (const row of FLEET_PRODUCT_AGENTS) {
      const g = row.factory();
      for (const t of g.tools) {
        expect(isFleetHardMoneyWriteTool(t.name), `${row.agentId} granted ${t.name}`).toBe(false);
      }
    }
  });

  it('parseGuardrail throws when a product agent is handed a money-write tool', () => {
    for (const agentId of PRODUCT_AGENT_IDS) {
      for (const tool of ['ledger.post', 'pay.route.change', 'trade.order'] as const) {
        expect(() =>
          parseGuardrail({
            agentId,
            version: 1,
            tools: [{ name: tool, module: tool.startsWith('pay') ? 'pay' : tool.startsWith('trade') ? 'trade' : 'ledger', mode: 'write' }],
            limits: {
              maxActionsPerSession: 1,
              maxOutputTokensPerCall: 1,
              maxSpendPerSession: '0',
              allowedModules: ['ledger', 'pay', 'trade', 'agents'],
              allowedTasks: ['navigator.plan'],
            },
          }),
        ).toThrow(/cannot grant money-moving tool/);
      }
    }
  });

  it('product agents cannot carry withdraw scope even without a withdraw tool', () => {
    for (const agentId of PRODUCT_AGENT_IDS) {
      expect(() =>
        parseGuardrail({
          agentId,
          version: 1,
          scopes: ['withdraw'],
          tools: [{ name: 'trade.quote', module: 'trade', mode: 'read' }],
          limits: {
            maxActionsPerSession: 1,
            maxOutputTokensPerCall: 1,
            maxSpendPerSession: '0',
            allowedModules: ['trade'],
            allowedTasks: ['navigator.plan'],
          },
        }),
      ).toThrow(/cannot carry withdraw scope/);
    }
  });

  it('probe agents may still grant trade.order for approval tests (not product)', () => {
    expect(() =>
      parseGuardrail({
        agentId: 'probe',
        version: 1,
        tools: [{ name: 'trade.order', module: 'trade', mode: 'write', requiresApproval: true }],
        limits: {
          maxActionsPerSession: 5,
          maxOutputTokensPerCall: 256,
          maxSpendPerSession: '1',
          allowedModules: ['trade'],
          allowedTasks: ['probe.think'],
        },
      }),
    ).not.toThrow();
  });

  it('hostile tool by name is refused on every Stage-1 factory (not only navigator)', () => {
    const factories = [
      navigatorAgentGuardrail,
      supportAgentGuardrail,
      scannerAgentGuardrail,
      merchantAgentGuardrail,
      copyIntelAgentGuardrail,
    ];
    for (const factory of factories) {
      const names = new Set(factory().tools.map((t) => t.name));
      for (const bad of FLEET_HARD_MONEY_WRITE_TOOLS) {
        expect(names.has(bad), `${factory.name} must not declare ${bad}`).toBe(false);
      }
    }
  });
});
