import { z } from 'zod';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import type { ProviderCapability } from '../providers/provider.js';

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
  /**
   * Absent when no rate is configured. A blank price is not zero and is not
   * a stand-in magnitude — metering it refuses.
   */
  readonly price?: ModelPrice;
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

const priceConfigSchema = z.object({
  inputPerMillion: z.string(),
  outputPerMillion: z.string(),
});

export const routeSchema = z.object({
  task: z.string().min(1).max(120),
  providerId: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  maxOutputTokens: z.number().int().min(1).max(1_000_000),
  price: priceConfigSchema.optional(),
  capability: z.enum(['complete', 'stream', 'embed']).default('complete'),
});

export const routingTableSchema = z.object({
  routes: z.array(routeSchema).min(1),
  fallbackTask: z.string().min(1).optional(),
});

export type RoutingTableConfig = z.infer<typeof routingTableSchema>;

/**
 * A configured price is two decimal strings. A missing or blank side is not a
 * rate: it stays unset so metering can refuse, and the other side is not filled in.
 * A non-blank side that is not a decimal string is a bad config and still fails parse.
 */
function configuredPrice(
  raw: { inputPerMillion: string; outputPerMillion: string } | undefined,
): ModelPrice | undefined {
  if (!raw) return undefined;
  const inputPerMillion = raw.inputPerMillion.trim();
  const outputPerMillion = raw.outputPerMillion.trim();
  if (inputPerMillion === '' || outputPerMillion === '') {
    if (inputPerMillion !== '') amountString.parse(inputPerMillion);
    if (outputPerMillion !== '') amountString.parse(outputPerMillion);
    return undefined;
  }
  const price = modelPriceSchema.parse({ inputPerMillion, outputPerMillion });
  return {
    inputPerMillion: parseAmount(price.inputPerMillion),
    outputPerMillion: parseAmount(price.outputPerMillion),
  };
}

/**
 * Parse a routing table from configuration.
 *
 * Prices become `Amount` (scaled bigint) here and stay that way. A price that
 * lived as a `number` even briefly would already have lost precision before the
 * first multiplication — Doctrine's "never a float near money" applies to rates
 * exactly as it applies to balances. A blank price is omitted; metering it refuses.
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
    routes: config.routes.map((r) => {
      const price = configuredPrice(r.price);
      return {
        task: r.task,
        providerId: r.providerId,
        model: r.model,
        maxOutputTokens: r.maxOutputTokens,
        capability: r.capability,
        ...(price ? { price } : {}),
      };
    }),
    ...(config.fallbackTask ? { fallbackTask: config.fallbackTask } : {}),
  };
}

/**
 * The rate a route may be metered at.
 *
 * A blank price stays blank. Billing must refuse here rather than substitute a magnitude.
 */
export function requireMeterPrice(route: RouteDef): ModelPrice {
  if (!route.price) {
    throw new AgentError(
      `No token price is configured for task "${route.task}"`,
      'agents.price_not_configured',
      'agents.error.price_not_configured',
      { task: route.task },
    );
  }
  return route.price;
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
 * The default table.
 *
 * Model values are capability TIERS, not product names: a deployment maps them
 * to whatever it has contracted for, through `AGENTS_UPSTREAM_MODELS`. Token
 * prices are not shipped on this table. A blank price refuses when metering
 * asks for it. A deployment that has a rate configures it as a decimal string.
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
    },
    {
      task: 'navigator.tool_select',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 1024,
    },

    // Grounded, high-volume, latency-sensitive paths.
    {
      task: 'support.reply',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 2048,
    },
    {
      task: 'support.classify',
      providerId: 'primary',
      model: 'fast-sm',
      maxOutputTokens: 256,
    },

    // Batch/analytical paths.
    {
      task: 'scanner.rank',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 2048,
    },
    {
      task: 'merchant.watch',
      providerId: 'primary',
      model: 'fast-sm',
      maxOutputTokens: 1024,
    },
    {
      task: 'copy_intel.stats',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 2048,
    },

    // Retrieval.
    {
      task: 'index.embed',
      providerId: 'primary',
      model: 'embed-sm',
      maxOutputTokens: 1,
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
