import { z } from 'zod';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import { MockModelProvider } from '../providers/mock.js';
import { UpstreamModelProvider } from '../providers/upstream.js';
import type { ModelProvider, ProviderCapability } from '../providers/provider.js';

/**
 * PER-TASK MODEL ROUTING (§8.2).
 *
 * "Which model serves which task" is data. Not a switch statement, not a
 * constant in a service, not a default buried in an adapter — a table that is
 * parsed, validated, and can be replaced without a deploy.
 *
 * That matters for three separate reasons, and only the first is obvious:
 *
 *  1. A cheaper model can take over a task the moment it is good enough, and
 *     the change is a config edit with an audit trail rather than a release.
 *  2. **Price travels with the route.** A route carries the rate its task is
 *     billed at, so metering prices what was actually used instead of looking
 *     up a global price list that may have moved since the call. §8.2 bills
 *     premium tiers through the ledger; a bill that cannot be reconstructed
 *     from the record of the call is not a bill anyone can dispute.
 *  3. `model` is an ALIAS the provider resolves. Doctrine §0.7 forbids vendor
 *     names in shipped copy, and a routing table shipped in source is shipped
 *     copy. Aliases keep the default table honest while
 *     `UpstreamProviderConfig.models` maps them to concrete ids from env.
 */

/** Rates are per MILLION tokens, the unit every model is priced in. */
export const TOKENS_PER_PRICE_UNIT = 1_000_000n;

export interface ModelPrice {
  /** Cost of one million input tokens, in the fee asset. */
  readonly inputPerMillion: Amount;
  /** Cost of one million output tokens, in the fee asset. */
  readonly outputPerMillion: Amount;
}

export interface RouteDef {
  /** Stable task id, e.g. 'navigator.plan'. Agents name a task, never a model. */
  readonly task: string;
  /** Logical provider id, resolved against the gateway's provider registry. */
  readonly providerId: string;
  /** Model alias as the routing table names it; the adapter resolves it. */
  readonly model: string;
  /** Hard output ceiling for this task. An unbounded generation is an unbounded bill. */
  readonly maxOutputTokens: number;
  /** Null when no rate is published for this deployment: the route never runs (OWNER 107). */
  readonly price: ModelPrice | null;
  /** Which capability this route needs. Checked before the provider is called. */
  readonly capability: ProviderCapability;
}

export interface RoutingTable {
  readonly routes: readonly RouteDef[];
  /**
   * Task used when a requested task has no route.
   *
   * Optional on purpose. A fallback is convenient for a chat surface and wrong
   * for a metered one: silently serving an unknown task on a default model
   * means billing a user for something nobody configured. Deployments that want
   * the convenience opt in.
   */
  readonly fallbackTask?: string;
}

// ── Config parsing ───────────────────────────────────────────────────────────

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'a price is an unsigned decimal string with at most 18 decimal places');

export const modelPriceSchema = z.object({
  inputPerMillion: amountString,
  outputPerMillion: amountString,
});

export const routeSchema = z.object({
  task: z.string().min(1).max(120),
  providerId: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  maxOutputTokens: z.number().int().min(1).max(1_000_000),
  price: modelPriceSchema,
  capability: z.enum(['complete', 'stream', 'embed']).default('complete'),
});

export const routingTableSchema = z.object({
  routes: z.array(routeSchema).min(1),
  fallbackTask: z.string().min(1).optional(),
});

export type RoutingTableConfig = z.infer<typeof routingTableSchema>;

/**
 * Parse a routing table from configuration.
 *
 * Prices become `Amount` (scaled bigint) here and stay that way. A price that
 * lived as a `number` even briefly would already have lost precision before the
 * first multiplication — Doctrine's "never a float near money" applies to rates
 * exactly as it applies to balances.
 */
export function parseRoutingTable(input: unknown): RoutingTable {
  const config = routingTableSchema.parse(input);

  const seen = new Set<string>();
  for (const route of config.routes) {
    if (seen.has(route.task)) {
      throw new Error(`Duplicate route for task "${route.task}" — a task must resolve to exactly one model`);
    }
    seen.add(route.task);
  }

  if (config.fallbackTask && !seen.has(config.fallbackTask)) {
    throw new Error(`fallbackTask "${config.fallbackTask}" has no route of its own`);
  }

  return {
    routes: config.routes.map((r) => ({
      task: r.task,
      providerId: r.providerId,
      model: r.model,
      maxOutputTokens: r.maxOutputTokens,
      capability: r.capability,
      price: {
        inputPerMillion: parseAmount(r.price.inputPerMillion),
        outputPerMillion: parseAmount(r.price.outputPerMillion),
      },
    })),
    ...(config.fallbackTask ? { fallbackTask: config.fallbackTask } : {}),
  };
}

/**
 * The same routes with every rate blank. A deployment that has not published its rates (no `AGENTS_ROUTING_TABLE`)
 * serves the default table's tasks and ceilings and prices nothing: its placeholder rates are for tests, never a
 * person's bill, so every run refuses `agents.price_unset` until the rates are set.
 */
export function unpricedTable(table: RoutingTable): RoutingTable {
  return { ...table, routes: table.routes.map((route) => ({ ...route, price: null })) };
}

export function resolveRoute(table: RoutingTable, task: string): RouteDef {
  const direct = table.routes.find((r) => r.task === task);
  if (direct) return direct;

  if (table.fallbackTask) {
    const fallback = table.routes.find((r) => r.task === table.fallbackTask);
    if (fallback) return fallback;
  }

  throw new AgentError(`No route configured for task "${task}"`, 'agents.route_not_found', 'agents.error.route_not_found', { task });
}

export function tasksOf(table: RoutingTable): string[] {
  return table.routes.map((r) => r.task);
}

/**
 * Which engine is actually wired.
 *
 * The class of the adapter decides this. A provider id, an env string, or a
 * comment that says "live" does not. The deterministic mock is sandbox. The
 * HTTP upstream adapter is live. Anything else — missing registration, a test
 * double, a future adapter — is unknown. Whether the route is metered follows
 * `AGENTS_METERING_ENABLED` and the route price, never the engine.
 */
export type RouteEngine = 'sandbox' | 'live' | 'unknown';

export function engineOfAdapter(provider: ModelProvider | undefined): RouteEngine {
  if (provider instanceof MockModelProvider) return 'sandbox';
  if (provider instanceof UpstreamModelProvider) return 'live';
  return 'unknown';
}

/** A parsed rate is non-blank. A missing price object is blank. Zero is a published rate, not a blank. */
export function routePriceNonBlank(price: ModelPrice | null | undefined): price is ModelPrice {
  if (!price) return false;
  return typeof price.inputPerMillion === 'bigint' && typeof price.outputPerMillion === 'bigint';
}

/**
 * True when this route would be billed.
 *
 * Metered follows `AGENTS_METERING_ENABLED` and the route price, never the
 * engine. Absent metering is treated as billed. A blank price is not billed.
 * Both rates at zero are not billed.
 */
export function routeIsMetered(meteringEnabled: boolean | undefined, price: ModelPrice | null | undefined): boolean {
  return meteringEnabled !== false && routePriceNonBlank(price) && !(price.inputPerMillion === 0n && price.outputPerMillion === 0n);
}

/**
 * One engine for an agent: every allowed task must resolve to that same engine.
 * A missing route, a mixed pair, or an unknown adapter is `unknown`.
 *
 * `metered` follows `AGENTS_METERING_ENABLED` and the route price, never the
 * engine. It is true when metering is not known to be off and at least one
 * allowed task would be billed, or any allowed task has no route. With no
 * allowed tasks it is false only when metering is known to be off.
 */
export function engineForTasks(
  tasks: readonly string[],
  resolve: (task: string) => { engine: RouteEngine; billed: boolean } | null,
  meteringEnabled?: boolean,
): { engine: RouteEngine; metered: boolean } {
  if (tasks.length === 0) return { engine: 'unknown', metered: meteringEnabled !== false };
  const engines = new Set<RouteEngine>();
  let billed = false;
  let unresolved = false;
  for (const task of tasks) {
    const row = resolve(task);
    if (!row) {
      engines.add('unknown');
      unresolved = true;
      continue;
    }
    engines.add(row.engine);
    if (row.billed) billed = true;
  }
  const engine: RouteEngine = engines.size === 1 ? [...engines][0]! : 'unknown';
  return { engine, metered: meteringEnabled !== false && (billed || unresolved) };
}

/**
 * The default table.
 *
 * Model values are capability TIERS, not product names: a deployment maps them
 * to whatever it has contracted for, through `AGENTS_UPSTREAM_MODELS`. Prices
 * are placeholders in the fee asset and are expected to be overridden — they
 * are here so that a dev environment meters end-to-end rather than metering
 * zero and hiding a whole money path behind "not configured yet".
 *
 * `providerId: 'primary'` is likewise logical. Locally that id is registered to
 * the deterministic mock; in production it is the upstream adapter. Nothing
 * above the registry can tell the difference, which is the point.
 */
export const DEFAULT_ROUTING_TABLE: RoutingTable = parseRoutingTable({
  routes: [
    // Planning and tool selection — the reasoning-heavy paths.
    {
      task: 'navigator.plan',
      providerId: 'primary',
      model: 'reasoning-lg',
      maxOutputTokens: 4096,
      price: { inputPerMillion: '3', outputPerMillion: '15' },
    },
    {
      task: 'navigator.tool_select',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 1024,
      price: { inputPerMillion: '1', outputPerMillion: '5' },
    },

    // Grounded, high-volume, latency-sensitive paths.
    {
      task: 'support.reply',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 2048,
      price: { inputPerMillion: '1', outputPerMillion: '5' },
    },
    // A run of an agent the person built: their instructions and their question, answered for them alone.
    {
      task: 'own.run',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 2048,
      price: { inputPerMillion: '1', outputPerMillion: '5' },
    },
    {
      task: 'support.classify',
      providerId: 'primary',
      model: 'fast-sm',
      maxOutputTokens: 256,
      price: { inputPerMillion: '0.25', outputPerMillion: '1.25' },
    },

    // Batch/analytical paths.
    {
      task: 'scanner.rank',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 2048,
      price: { inputPerMillion: '1', outputPerMillion: '5' },
    },
    {
      task: 'merchant.watch',
      providerId: 'primary',
      model: 'fast-sm',
      maxOutputTokens: 1024,
      price: { inputPerMillion: '0.25', outputPerMillion: '1.25' },
    },
    {
      task: 'copy_intel.stats',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 2048,
      price: { inputPerMillion: '1', outputPerMillion: '5' },
    },

    // Retrieval.
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

/** L3 — route count (no invent). */
export function routeCount(table: RoutingTable): number {
  return table.routes.length;
}

/** L3 — complete capability route count. */
export function completeRouteCount(table: RoutingTable): number {
  return table.routes.filter((r) => (r.capability ?? 'complete') === 'complete').length;
}

/** L3 — unique provider ids in table. */
export function routingProviderIds(table: RoutingTable): readonly string[] {
  return [...new Set(table.routes.map((r) => r.providerId))].sort();
}

/** L3 — board card. */
export function routingTableBoardCard(table: RoutingTable): {
  readonly routes: number;
  readonly complete: number;
  readonly providers: number;
  readonly hasFallback: boolean;
  readonly tasks: readonly string[];
} {
  return {
    routes: routeCount(table),
    complete: completeRouteCount(table),
    providers: routingProviderIds(table).length,
    hasFallback: table.fallbackTask != null && table.fallbackTask.length > 0,
    tasks: tasksOf(table),
  };
}

/** L3 — status line. */
export function routingTableStatusLine(table: RoutingTable): string {
  const c = routingTableBoardCard(table);
  return `routes=${c.routes} complete=${c.complete} providers=${c.providers} fallback=${c.hasFallback ? '1' : '0'}`;
}

/** L3 — parse status. Invalid → null. */
export function parseRoutingTableStatusLine(
  line: string,
): { readonly routes: number; readonly complete: number; readonly providers: number; readonly fallback: boolean } | null {
  const m = line.trim().match(/^routes=(\d+) complete=(\d+) providers=(\d+) fallback=([01])$/);
  if (!m) return null;
  return {
    routes: Number(m[1]),
    complete: Number(m[2]),
    providers: Number(m[3]),
    fallback: m[4] === '1',
  };
}

/** L3 — true when status matches table. */
export function routingTableStatusLineMatches(table: RoutingTable): boolean {
  const p = parseRoutingTableStatusLine(routingTableStatusLine(table));
  if (!p) return false;
  const c = routingTableBoardCard(table);
  return p.routes === c.routes && p.complete === c.complete && p.providers === c.providers && p.fallback === c.hasFallback;
}

/** L3 — export header. */
export function routingTableExportHeader(): string {
  return 'routes,complete,providers,fallback';
}

/** L3 — export line. */
export function routingTableExportLine(table: RoutingTable): string {
  const c = routingTableBoardCard(table);
  return `${c.routes},${c.complete},${c.providers},${c.hasFallback ? '1' : '0'}`;
}

/** L3 — full export. */
export function routingTableExportText(table: RoutingTable): string {
  return [routingTableExportHeader(), routingTableExportLine(table)].join('\n');
}

/** L3 — true when route count is within [min,max]. Invalid → false. */
export function routeCountInRange(table: RoutingTable, min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const n = routeCount(table);
  return n >= min && n <= max;
}

/** L3 — true when task is listed. */
export function routingHasTask(table: RoutingTable, task: string): boolean {
  return table.routes.some((r) => r.task === task);
}
