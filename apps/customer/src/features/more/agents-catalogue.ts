import { z } from 'zod';
import { formatAmount, parseAmount } from '../../shared/money';

/** How a product agent can be used from a customer account.
 * session: it has a guardrail and metered sessions; room: it is used inside
 * another room; staff: staff-only drafts; unwired: named by doctrine, no port. */
export type AgentKind = 'session' | 'room' | 'staff' | 'unwired';
export type CatalogueAgent = { id: string; kind: AgentKind; href?: string; tab?: 'Coach' };

export const AGENT_CATALOGUE: readonly CatalogueAgent[] = [
  { id: 'navigator', kind: 'session' },
  { id: 'support', kind: 'session' },
  { id: 'scanner', kind: 'session' },
  { id: 'merchant', kind: 'session' },
  { id: 'copy-intel', kind: 'session' },
  { id: 'coach', kind: 'room', tab: 'Coach' },
  { id: 'launch', kind: 'room', href: '/launch' },
  { id: 'growth', kind: 'room', href: '/campaigns' },
  { id: 'portfolio', kind: 'unwired' },
  { id: 'risk-compliance', kind: 'staff' },
];
export const SESSION_AGENT_IDS = AGENT_CATALOGUE.filter((agent) => agent.kind === 'session').map((agent) => agent.id);

/** The guardrail a session agent publishes (svc-agents `agent.get`). */
export const guardrailSchema = z
  .object({
    agentId: z.string(),
    version: z.number().int().positive(),
    enabled: z.boolean(),
    tools: z.array(
      z.object({
        name: z.string(),
        module: z.string(),
        mode: z.enum(['read', 'write']),
        requiresApproval: z.boolean(),
        maxCallsPerSession: z.number().int().nullable(),
        /** Every refusal the runtime can return for this tool, as codes, in the order it checks them. */
        refusals: z.array(z.string()),
      }),
    ),
    capacityMode: z.string().nullable(),
    limits: z.object({
      maxActionsPerSession: z.number().int(),
      maxOutputTokensPerCall: z.number().int(),
      maxSpendPerSession: z.string().nullable(),
      allowedModules: z.array(z.string()),
      allowedTasks: z.array(z.string()),
    }),
  })
  .nullable();

export type Guardrail = NonNullable<z.infer<typeof guardrailSchema>>;

/** The stored agent list (svc-agents `agent.catalogue`): disabled agents stay in it with enabled false. */
export const storedCatalogueSchema = z.array(
  z.object({
    agentId: z.string(),
    name: z.string().nullable(),
    purpose: z.string().nullable(),
    enabled: z.boolean(),
    version: z.number().int(),
  }),
);
export type StoredAgent = z.infer<typeof storedCatalogueSchema>[number];

/**
 * Whether a person can use an agent now. A session agent follows its stored
 * row, and one the deployment has not stored cannot open a session. A room
 * agent is used inside its room; staff and unconnected agents cannot be used.
 */
export function agentEnabled(agent: CatalogueAgent, stored: readonly StoredAgent[]): boolean {
  if (agent.kind === 'session') return stored.some((row) => row.agentId === agent.id && row.enabled);
  return agent.kind === 'room';
}

export type CatalogueSort = 'catalogue' | 'name';
export function sortCatalogue(agents: readonly CatalogueAgent[], sort: CatalogueSort, label: (id: string) => string): CatalogueAgent[] {
  return sort === 'name' ? [...agents].sort((a, b) => label(a.id).localeCompare(label(b.id))) : [...agents];
}

/**
 * The exact cost of each completed engine run of one task this person made with an agent,
 * from their own action log. Empty means no run history, so no expected range.
 */
export function runCosts(rows: readonly ActionRow[], agentId: string, task: string): bigint[] {
  return rows
    .filter((row) => row.agentId === agentId && row.task === task && row.kind === 'completion' && row.status === 'executed')
    .map((row) => parseAmount(row.cost));
}
export function costRange(costs: readonly bigint[]): { low: string; high: string } | null {
  if (!costs.length) return null;
  let low = costs[0]!,
    high = costs[0]!;
  for (const cost of costs) {
    if (cost < low) low = cost;
    if (cost > high) high = cost;
  }
  return { low: formatAmount(low), high: formatAmount(high) };
}

export function filterCatalogue(
  agents: readonly CatalogueAgent[],
  filter: { query: string; kind: AgentKind | 'all' },
  label: (id: string) => string,
): CatalogueAgent[] {
  const query = filter.query.trim().toLowerCase();
  return agents.filter(
    (agent) =>
      (filter.kind === 'all' || agent.kind === filter.kind) &&
      (!query || agent.id.includes(query) || label(agent.id).toLowerCase().includes(query)),
  );
}

export type ActionRow = {
  id: string;
  sessionId: string;
  agentId: string;
  sequence: number;
  kind: string;
  status: 'executed' | 'refused' | 'failed';
  tool: string | null;
  task: string | null;
  inputTokens: string;
  outputTokens: string;
  cost: string;
  refusalCode: string | null;
  occurredAt: string;
};
export type AgentUse = {
  agentId: string;
  sessions: number;
  actions: number;
  executed: number;
  refused: number;
  failed: number;
  /** Exact sum of the logged costs. The log does not name the asset. */
  spend: string;
  lastUsed: string;
};

/** What the account has actually done with each agent, from its own log only.
 * Newest-used agent first. A count covers the rows loaded, not all history. */
export function agentUse(rows: readonly ActionRow[]): AgentUse[] {
  const byAgent = new Map<string, { sessions: Set<string>; use: AgentUse; spend: bigint }>();
  for (const row of rows) {
    let entry = byAgent.get(row.agentId);
    if (!entry) {
      entry = {
        sessions: new Set(),
        spend: 0n,
        use: { agentId: row.agentId, sessions: 0, actions: 0, executed: 0, refused: 0, failed: 0, spend: '0', lastUsed: row.occurredAt },
      };
      byAgent.set(row.agentId, entry);
    }
    entry.sessions.add(row.sessionId);
    entry.use.actions += 1;
    entry.use[row.status] += 1;
    entry.spend += parseAmount(row.cost);
    if (Date.parse(row.occurredAt) > Date.parse(entry.use.lastUsed)) entry.use.lastUsed = row.occurredAt;
  }
  return [...byAgent.values()]
    .map(({ sessions, use, spend }) => ({ ...use, sessions: sessions.size, spend: formatAmount(spend) }))
    .sort((a, b) => Date.parse(b.lastUsed) - Date.parse(a.lastUsed));
}

export const ACTION_LOG_HEADER = [
  'occurred_at',
  'agent',
  'session',
  'sequence',
  'kind',
  'status',
  'tool_or_task',
  'input_tokens',
  'output_tokens',
  'cost',
  'refusal_code',
] as const;
export function actionLogRows(rows: readonly ActionRow[]): string[][] {
  return rows.map((row) => [
    row.occurredAt,
    row.agentId,
    row.sessionId,
    String(row.sequence),
    row.kind,
    row.status,
    row.tool ?? row.task ?? '',
    row.inputTokens,
    row.outputTokens,
    row.cost,
    row.refusalCode ?? '',
  ]);
}
