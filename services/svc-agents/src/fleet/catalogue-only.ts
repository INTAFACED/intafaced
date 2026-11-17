/**
 * The product agents the customer catalogue lists that hold no tools in this service (J-agents-01 #1).
 *
 * The catalogue is the stored list (`agent.catalogue` reads `agent_definitions`), so every agent a person can find has a
 * stored row. These four have no session surface here: Launch check and Growth drafts are used inside their rooms, the
 * Portfolio planner's data source is not connected, and Risk and compliance is for staff only. Each is stored with an
 * empty guardrail (no tools, no engine task, a spend cap of 0) and opens no session (`isCatalogueOnlyAgent`, read by
 * runtime.openSession), and the two no customer can use are stored disabled. Registration upserts the guardrail and keeps `enabled` as
 * stored, so an operator's switch survives a reboot (runtime.registerAgent).
 */

import { parseGuardrail, serialiseGuardrail, type Guardrail } from './guardrails.js';
import type { BootRegisterRuntime } from './boot-register.js';

export type CatalogueOnlyAgent = {
  readonly agentId: 'launch' | 'growth' | 'portfolio' | 'risk-compliance';
  /** Whether a person can use it now (inside its room); false keeps it listed with its open button off. */
  readonly enabled: boolean;
};

export const CATALOGUE_ONLY_AGENTS: readonly CatalogueOnlyAgent[] = [
  { agentId: 'launch', enabled: true },
  { agentId: 'growth', enabled: true },
  { agentId: 'portfolio', enabled: false },
  { agentId: 'risk-compliance', enabled: false },
];

/** Whether an agent id is one of these: such an agent is listed, and never opens a session (runtime.openSession). */
export function isCatalogueOnlyAgent(agentId: string): boolean {
  return CATALOGUE_ONLY_AGENTS.some((row) => row.agentId === agentId);
}

/** The empty guardrail of a catalogue-only agent: it may call no tool and no engine task, and spend nothing. */
export function catalogueOnlyGuardrail(agentId: CatalogueOnlyAgent['agentId']): Guardrail {
  return parseGuardrail({
    agentId,
    version: 1,
    capacityMode: 'research_only',
    tools: [],
    limits: { maxActionsPerSession: 1, maxOutputTokensPerCall: 1, maxSpendPerSession: '0', allowedModules: [], allowedTasks: [] },
  });
}

/** Stores every catalogue-only agent at boot; an existing row keeps its `enabled`. */
export async function registerCatalogueOnlyAgents(
  runtime: BootRegisterRuntime,
  rows: readonly CatalogueOnlyAgent[] = CATALOGUE_ONLY_AGENTS,
): Promise<readonly string[]> {
  const registered: string[] = [];
  for (const row of rows) {
    const written = await runtime.registerAgent(serialiseGuardrail(catalogueOnlyGuardrail(row.agentId)), { enabled: row.enabled });
    registered.push(written.agentId);
  }
  return registered;
}
