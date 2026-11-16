import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { routeChangeSchema, routeDeskSchema } from '@intafaced/contracts/agents-routes';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { ModelGateway } from './gateway.js';
import type { ModelPrice, RouteDef, RouteEngine, RoutingTable } from './routing.js';

/**
 * THE ROUTING TABLE, CHANGED BY TWO FOUNDERS (J-agents-20; AG-usage-02, RC-agents-05).
 *
 * The configured table (AGENTS_ROUTING_TABLE) names each task's provider and model alias, and nothing here changes
 * them: a provider swap is a configuration change, and the source stays as it is. Founders change a route's output
 * ceiling and its rates, two of them together:
 *
 *   · one founder proposes (`routes.propose`): the change is stored as pending and the table does not move;
 *   · that founder may withdraw it (`routes.withdraw`); nobody else may;
 *   · a different founder confirms it (`routes.confirm`): the change is applied once, in the same transaction as its
 *     audit row naming both founders. A second confirm of the same change answers what was applied and changes nothing.
 *
 * Money: a rate change takes effect at the start of the next usage window. Until then the window's calls are priced at
 * the rate in force when the change was confirmed, so a window is never priced at two rates by one change. A route with
 * blank rates still refuses every metered run (`agents.price_unset`). An open session keeps the guardrail it copied when
 * it opened (`agent_sessions`): nothing here touches a session.
 */

export type RouteChangeRefusalCode =
  | 'agents.route_not_found'
  | 'agents.route_change_invalid'
  | 'agents.route_change_unchanged'
  | 'agents.route_change_pending'
  | 'agents.route_change_not_found'
  | 'agents.route_change_not_pending'
  | 'agents.route_change_same_founder'
  | 'agents.route_change_not_yours'
  | 'agents.route_change_request_reused'
  | 'agents.route_change_person_only'
  | 'agents.capability_unavailable';

export class RouteChangeRefusal extends Error {
  constructor(readonly code: RouteChangeRefusalCode) {
    super(code);
    this.name = 'RouteChangeRefusal';
  }
}

const STATUS: Record<RouteChangeRefusalCode, TRPCError['code']> = {
  'agents.route_not_found': 'NOT_FOUND',
  'agents.route_change_invalid': 'BAD_REQUEST',
  'agents.route_change_unchanged': 'CONFLICT',
  'agents.route_change_pending': 'CONFLICT',
  'agents.route_change_not_found': 'NOT_FOUND',
  'agents.route_change_not_pending': 'CONFLICT',
  'agents.route_change_same_founder': 'FORBIDDEN',
  'agents.route_change_not_yours': 'FORBIDDEN',
  'agents.route_change_request_reused': 'CONFLICT',
  'agents.route_change_person_only': 'FORBIDDEN',
  'agents.capability_unavailable': 'SERVICE_UNAVAILABLE',
};

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof RouteChangeRefusal)) throw err;
    throw new TRPCError({ code: STATUS[err.code], message: err.code, cause: err });
  }
}

// ── The founders' layer over the configured table ───────────────────────────

/** A confirmed change to one task's route, as stored. */
export interface RouteOverride {
  readonly task: string;
  readonly maxOutputTokens: number;
  readonly price: ModelPrice | null;
  /** The rate in force when the change was confirmed, kept until `priceFrom`. */
  readonly priorPrice: ModelPrice | null;
  readonly priceFrom: Date;
}

/** The price a route charges at `now` under its override. */
export function overridePriceAt(override: RouteOverride, now: Date): ModelPrice | null {
  return now.getTime() >= override.priceFrom.getTime() ? override.price : override.priorPrice;
}

/**
 * The configured table with the founders' changes laid over it. Provider, model and capability always come from the
 * configured table; an override for a task the configuration no longer has is ignored.
 */
export function withOverrides(base: RoutingTable, overrides: readonly RouteOverride[], now: Date): RoutingTable {
  const byTask = new Map(overrides.map((o) => [o.task, o]));
  return {
    ...base,
    routes: base.routes.map((route) => {
      const o = byTask.get(route.task);
      return o ? { ...route, maxOutputTokens: o.maxOutputTokens, price: overridePriceAt(o, now) } : route;
    }),
  };
}

/** The start of the usage window after the one `now` is in (windows are whole minutes dividing a UTC day). */
export function nextWindowStart(now: Date, windowMinutes: number): Date {
  const ms = windowMinutes * 60_000;
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(day + (Math.floor((now.getTime() - day) / ms) + 1) * ms);
}

const samePrice = (a: ModelPrice | null, b: ModelPrice | null): boolean =>
  a === null || b === null ? a === b : a.inputPerMillion === b.inputPerMillion && a.outputPerMillion === b.outputPerMillion;

type Num = string | null;
const priceOf = (input: Num, output: Num): ModelPrice | null =>
  input === null || output === null ? null : { inputPerMillion: parseAmount(input), outputPerMillion: parseAmount(output) };
const rate = (price: ModelPrice | null) =>
  price ? { inputPerMillion: formatAmount(price.inputPerMillion), outputPerMillion: formatAmount(price.outputPerMillion) } : null;

interface OverrideRow {
  task: string;
  max_output_tokens: number;
  input_per_million: Num;
  output_per_million: Num;
  prior_input_per_million: Num;
  prior_output_per_million: Num;
  price_from: Date;
}

export async function readRouteOverrides(sql: Sql): Promise<RouteOverride[]> {
  const rows = await sql<OverrideRow[]>`
    SELECT task, max_output_tokens, input_per_million::text AS input_per_million, output_per_million::text AS output_per_million,
           prior_input_per_million::text AS prior_input_per_million, prior_output_per_million::text AS prior_output_per_million,
           price_from
      FROM agents.route_overrides ORDER BY task
  `;
  return rows.map((r) => ({
    task: r.task,
    maxOutputTokens: r.max_output_tokens,
    price: priceOf(r.input_per_million, r.output_per_million),
    priorPrice: priceOf(r.prior_input_per_million, r.prior_output_per_million),
    priceFrom: r.price_from,
  }));
}

/**
 * Keeps the gateway's table equal to the configured table plus the stored changes: read at boot, after each confirm,
 * every 30 s (another replica's confirm) and at the instant a confirmed rate takes effect.
 */
export class RouteTableSync {
  private boundary: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly gateway: Pick<ModelGateway, 'setRoutingTable'>,
    readonly base: RoutingTable,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async refresh(): Promise<RoutingTable> {
    const overrides = await readRouteOverrides(this.sql);
    const now = this.now();
    const table = withOverrides(this.base, overrides, now);
    this.gateway.setRoutingTable(table);
    const next = overrides.map((o) => o.priceFrom.getTime()).filter((t) => t > now.getTime());
    if (this.boundary) clearTimeout(this.boundary);
    this.boundary = null;
    if (next.length > 0) {
      this.boundary = setTimeout(() => void this.refresh().catch(() => undefined), Math.min(...next) - now.getTime() + 1);
      this.boundary.unref?.();
    }
    return table;
  }

  start(everyMs = 30_000): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.refresh().catch(() => undefined), everyMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.boundary) clearTimeout(this.boundary);
    this.interval = null;
    this.boundary = null;
  }
}

// ── The store ───────────────────────────────────────────────────────────────

export interface RouteChangeInput {
  readonly task: string;
  readonly maxOutputTokens: number;
  readonly inputPerMillion: string | null;
  readonly outputPerMillion: string | null;
}

export interface RouteChangeView {
  readonly id: string;
  readonly task: string;
  readonly maxOutputTokens: number;
  readonly inputPerMillion: string | null;
  readonly outputPerMillion: string | null;
  readonly status: 'pending' | 'applied' | 'withdrawn';
  readonly proposedBy: string;
  readonly confirmedBy: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface RouteAuditView {
  readonly id: string;
  readonly at: string;
  readonly changeId: string;
  readonly task: string;
  readonly action: 'propose' | 'withdraw' | 'confirm';
  readonly operatorId: string;
  readonly proposedBy: string;
  readonly before: RouteSnapshot;
  readonly after: RouteSnapshot;
}

export interface RouteSnapshot {
  readonly maxOutputTokens: number;
  readonly inputPerMillion: string | null;
  readonly outputPerMillion: string | null;
}

interface RequestRow {
  id: string;
  request_id: string;
  task: string;
  max_output_tokens: number;
  input_per_million: Num;
  output_per_million: Num;
  status: 'pending' | 'applied' | 'withdrawn';
  proposed_by: string;
  confirmed_by: string | null;
  created_at: Date;
  decided_at: Date | null;
}

const canonical = (v: Num): Num => (v === null ? null : formatAmount(parseAmount(v)));

function changeView(r: RequestRow): RouteChangeView {
  return {
    id: r.id,
    task: r.task,
    maxOutputTokens: r.max_output_tokens,
    inputPerMillion: canonical(r.input_per_million),
    outputPerMillion: canonical(r.output_per_million),
    status: r.status,
    proposedBy: r.proposed_by,
    confirmedBy: r.confirmed_by,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
  };
}

const snapshot = (route: Pick<RouteDef, 'maxOutputTokens' | 'price'>): RouteSnapshot => ({
  maxOutputTokens: route.maxOutputTokens,
  inputPerMillion: rate(route.price)?.inputPerMillion ?? null,
  outputPerMillion: rate(route.price)?.outputPerMillion ?? null,
});

/** An id derived from the request's business key, so a retried proposal lands on the same row. */
function idFor(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const AMOUNT = /^\d{1,20}(\.\d{1,18})?$/;
const sameUser = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** Every write takes this lock, so a proposal, a withdrawal and a confirm of one table never interleave. */
const LOCK = 'agents-route-changes';

const REQUEST_COLUMNS = `id::text AS id, request_id, task, max_output_tokens, input_per_million::text AS input_per_million,
  output_per_million::text AS output_per_million, status, proposed_by, confirmed_by, created_at, decided_at`;

export interface RouteChangeStoreDeps {
  readonly sql: Sql;
  readonly sync: Pick<RouteTableSync, 'base' | 'refresh'>;
  readonly windowMinutes: number;
  readonly now?: () => Date;
}

export class RouteChangeStore {
  private readonly now: () => Date;
  constructor(private readonly deps: RouteChangeStoreDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private baseRoute(task: string): RouteDef {
    const route = this.deps.sync.base.routes.find((r) => r.task === task);
    if (!route) throw new RouteChangeRefusal('agents.route_not_found');
    return route;
  }

  /** The route as it stands now: the configured route with its stored change, if any. */
  private async current(tx: Sql, task: string): Promise<RouteDef> {
    const base = this.baseRoute(task);
    const overrides = await readRouteOverrides(tx);
    return withOverrides({ routes: [base] }, overrides, this.now()).routes[0]!;
  }

  /** One founder's change, stored as pending. The table does not move. Retried with the same request id, it answers the same row. */
  async propose(operatorId: string, input: RouteChangeInput, requestId: string): Promise<RouteChangeView> {
    const valid = validate(input);
    this.baseRoute(valid.task);
    const id = idFor(`route-change:${requestId}`);
    return transaction(this.deps.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
      const [mine] = await tx.unsafe<RequestRow[]>(`SELECT ${REQUEST_COLUMNS} FROM agents.route_change_requests WHERE request_id = $1`, [
        requestId,
      ]);
      if (mine) {
        const same =
          mine.task === valid.task &&
          sameUser(mine.proposed_by, operatorId) &&
          mine.max_output_tokens === valid.maxOutputTokens &&
          canonical(mine.input_per_million) === valid.inputPerMillion &&
          canonical(mine.output_per_million) === valid.outputPerMillion;
        if (!same) throw new RouteChangeRefusal('agents.route_change_request_reused');
        return changeView(mine);
      }
      const [waiting] = await tx`SELECT 1 FROM agents.route_change_requests WHERE task = ${valid.task} AND status = 'pending'`;
      if (waiting) throw new RouteChangeRefusal('agents.route_change_pending');
      const route = await this.current(tx, valid.task);
      const after: RouteSnapshot = {
        maxOutputTokens: valid.maxOutputTokens,
        inputPerMillion: valid.inputPerMillion,
        outputPerMillion: valid.outputPerMillion,
      };
      const before = snapshot(route);
      if (
        before.maxOutputTokens === after.maxOutputTokens &&
        before.inputPerMillion === after.inputPerMillion &&
        before.outputPerMillion === after.outputPerMillion
      )
        throw new RouteChangeRefusal('agents.route_change_unchanged');
      const [row] = await tx.unsafe<RequestRow[]>(
        `INSERT INTO agents.route_change_requests (id, request_id, task, max_output_tokens, input_per_million, output_per_million, proposed_by)
         VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7) RETURNING ${REQUEST_COLUMNS}`,
        [id, requestId, valid.task, valid.maxOutputTokens, valid.inputPerMillion, valid.outputPerMillion, operatorId],
      );
      await audit(tx, {
        key: `route-change:propose:${id}`,
        changeId: id,
        task: valid.task,
        action: 'propose',
        operatorId,
        proposedBy: operatorId,
        before,
        after,
      });
      return changeView(row!);
    });
  }

  /** The proposer takes their pending change back. Nothing else changes. */
  async withdraw(operatorId: string, changeId: string): Promise<RouteChangeView> {
    return transaction(this.deps.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
      const row = await this.request(tx, changeId);
      if (!sameUser(row.proposed_by, operatorId)) throw new RouteChangeRefusal('agents.route_change_not_yours');
      if (row.status === 'withdrawn') return changeView(row);
      if (row.status !== 'pending') throw new RouteChangeRefusal('agents.route_change_not_pending');
      const route = await this.current(tx, row.task);
      const [done] = await tx.unsafe<RequestRow[]>(
        `UPDATE agents.route_change_requests SET status = 'withdrawn', decided_at = now() WHERE id = $1 RETURNING ${REQUEST_COLUMNS}`,
        [changeId],
      );
      const now = snapshot(route);
      await audit(tx, {
        key: `route-change:withdraw:${changeId}`,
        changeId,
        task: row.task,
        action: 'withdraw',
        operatorId,
        proposedBy: row.proposed_by,
        before: now,
        after: now,
      });
      return changeView(done!);
    });
  }

  /**
   * A second founder applies the change: once, with its audit row, in one transaction. The proposer is refused. A rate
   * change is in force from the next usage window; the ceiling at once.
   */
  async confirm(operatorId: string, changeId: string): Promise<RouteChangeView> {
    const view = await transaction(this.deps.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
      const row = await this.request(tx, changeId);
      if (row.status === 'applied' && row.confirmed_by && sameUser(row.confirmed_by, operatorId)) return changeView(row);
      if (row.status !== 'pending') throw new RouteChangeRefusal('agents.route_change_not_pending');
      if (sameUser(row.proposed_by, operatorId)) throw new RouteChangeRefusal('agents.route_change_same_founder');
      const now = this.now();
      const route = await this.current(tx, row.task);
      const price = priceOf(row.input_per_million, row.output_per_million);
      const rateMoves = !samePrice(route.price, price);
      const priceFrom = rateMoves ? nextWindowStart(now, this.deps.windowMinutes) : now;
      const prior = rate(route.price);
      await tx`
        INSERT INTO agents.route_overrides
          (task, max_output_tokens, input_per_million, output_per_million, prior_input_per_million, prior_output_per_million, price_from, change_id)
        VALUES (${row.task}, ${row.max_output_tokens}, ${row.input_per_million}::numeric, ${row.output_per_million}::numeric,
                ${prior?.inputPerMillion ?? null}::numeric, ${prior?.outputPerMillion ?? null}::numeric, ${priceFrom}, ${changeId})
        ON CONFLICT (task) DO UPDATE SET
          max_output_tokens = EXCLUDED.max_output_tokens, input_per_million = EXCLUDED.input_per_million,
          output_per_million = EXCLUDED.output_per_million, prior_input_per_million = EXCLUDED.prior_input_per_million,
          prior_output_per_million = EXCLUDED.prior_output_per_million, price_from = EXCLUDED.price_from,
          change_id = EXCLUDED.change_id, updated_at = now()
      `;
      const [done] = await tx.unsafe<RequestRow[]>(
        `UPDATE agents.route_change_requests SET status = 'applied', confirmed_by = $2, decided_at = now()
          WHERE id = $1 AND status = 'pending' RETURNING ${REQUEST_COLUMNS}`,
        [changeId, operatorId],
      );
      await audit(tx, {
        key: `route-change:confirm:${changeId}`,
        changeId,
        task: row.task,
        action: 'confirm',
        operatorId,
        proposedBy: row.proposed_by,
        before: snapshot(route),
        after: {
          maxOutputTokens: row.max_output_tokens,
          inputPerMillion: canonical(row.input_per_million),
          outputPerMillion: canonical(row.output_per_million),
        },
      });
      return changeView(done!);
    });
    await this.deps.sync.refresh();
    return view;
  }

  private async request(tx: Sql, changeId: string): Promise<RequestRow> {
    const [row] = await tx.unsafe<RequestRow[]>(`SELECT ${REQUEST_COLUMNS} FROM agents.route_change_requests WHERE id = $1 FOR UPDATE`, [
      changeId,
    ]);
    if (!row) throw new RouteChangeRefusal('agents.route_change_not_found');
    return row;
  }
}

function validate(input: RouteChangeInput): RouteChangeInput {
  const { maxOutputTokens, inputPerMillion: i, outputPerMillion: o } = input;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1_000_000)
    throw new RouteChangeRefusal('agents.route_change_invalid');
  // Both rates or neither: a route is priced on both sides, or it is not priced and refuses its metered runs.
  if ((i === null) !== (o === null)) throw new RouteChangeRefusal('agents.route_change_invalid');
  if ((i !== null && !AMOUNT.test(i)) || (o !== null && !AMOUNT.test(o))) throw new RouteChangeRefusal('agents.route_change_invalid');
  return { task: input.task, maxOutputTokens, inputPerMillion: canonical(i), outputPerMillion: canonical(o) };
}

async function audit(
  tx: Sql,
  row: {
    key: string;
    changeId: string;
    task: string;
    action: 'propose' | 'withdraw' | 'confirm';
    operatorId: string;
    proposedBy: string;
    before: RouteSnapshot;
    after: RouteSnapshot;
  },
): Promise<void> {
  await tx`
    INSERT INTO agents.route_change_audit (business_key, change_id, task, action, operator_id, proposed_by, before, after)
    VALUES (${row.key}, ${row.changeId}, ${row.task}, ${row.action}, ${row.operatorId}, ${row.proposedBy},
            ${tx.json(row.before as never)}, ${tx.json(row.after as never)})
    ON CONFLICT (business_key) DO NOTHING
  `;
}

const AUDIT_LIMIT = 100;

export async function readRouteDesk(
  sql: Sql,
): Promise<{ pending: RouteChangeView[]; applied: RouteChangeView[]; audit: RouteAuditView[] }> {
  const [pending, applied, audits] = await Promise.all([
    sql.unsafe<RequestRow[]>(`SELECT ${REQUEST_COLUMNS} FROM agents.route_change_requests WHERE status = 'pending' ORDER BY created_at`),
    // The newest applied change of each task: the one its row names.
    sql.unsafe<RequestRow[]>(
      `SELECT DISTINCT ON (task) ${REQUEST_COLUMNS} FROM agents.route_change_requests WHERE status = 'applied' ORDER BY task, decided_at DESC`,
    ),
    sql<
      {
        id: string;
        at: Date;
        change_id: string;
        task: string;
        action: RouteAuditView['action'];
        operator_id: string;
        proposed_by: string;
        before: RouteSnapshot;
        after: RouteSnapshot;
      }[]
    >`
      SELECT id::text AS id, at, change_id::text AS change_id, task, action, operator_id, proposed_by, before, after
        FROM agents.route_change_audit ORDER BY at DESC, id DESC LIMIT ${AUDIT_LIMIT}
    `,
  ]);
  return {
    pending: pending.map(changeView),
    applied: applied.map(changeView),
    audit: audits.map((a) => ({
      id: a.id,
      at: a.at.toISOString(),
      changeId: a.change_id,
      task: a.task,
      action: a.action,
      operatorId: a.operator_id,
      proposedBy: a.proposed_by,
      before: a.before,
      after: a.after,
    })),
  };
}

// ── The procedures (mounted under `routes`) ─────────────────────────────────

const changeSchema = routeChangeSchema;

export interface RouteDeskDeps {
  readonly sql: Sql | undefined;
  readonly gateway: Pick<ModelGateway, 'routingTable'>;
  readonly store: RouteChangeStore | undefined;
  readonly sync: Pick<RouteTableSync, 'refresh'> | undefined;
  readonly feeAssetId: string;
  readonly routeEngine: (route: RouteDef) => { engine: RouteEngine; metered: boolean };
  readonly overrides: (sql: Sql) => Promise<RouteOverride[]>;
  readonly now?: () => Date;
}

export function routeDeskProcedures(deps: RouteDeskDeps) {
  // A signed-in founder's own session: never a service forwarding a principal, an API key or a sub-account.
  const operator = (scope: 'admin:read' | 'admin:write') =>
    scopedProcedure(scope, { module: 'agents', person: true }).use(({ ctx, next }) => {
      if (ctx.principal.kid || ctx.principal.sub_account)
        throw new TRPCError({ code: 'FORBIDDEN', message: 'agents.route_change_person_only' });
      return next();
    });
  const ready = () => {
    if (!deps.sql || !deps.store) throw new RouteChangeRefusal('agents.capability_unavailable');
    return { sql: deps.sql, store: deps.store };
  };
  const now = deps.now ?? (() => new Date());
  const changeId = z.string().uuid();

  return {
    /**
     * The routing table as founders read it: each task with its provider and model alias (always from configuration),
     * its ceiling and rates in force now ("not set" is null), a rate that takes effect at the next window, the change
     * waiting for a second founder, the last change two founders made, and the newest audit rows.
     */
    desk: operator('admin:read')
      .output(routeDeskSchema)
      .query(() =>
        guard(async () => {
          const { sql } = ready();
          // Read fresh, so the desk never shows a table this replica has not caught up with.
          if (deps.sync) await deps.sync.refresh();
          const [desk, overrides] = await Promise.all([readRouteDesk(sql), deps.overrides(sql)]);
          const at = now();
          const pendingOf = new Map(desk.pending.map((c) => [c.task, c]));
          const lastOf = new Map(desk.applied.map((c) => [c.task, c]));
          const overrideOf = new Map(overrides.map((o) => [o.task, o]));
          return {
            routes: deps.gateway.routingTable.routes.map((route) => {
              const o = overrideOf.get(route.task);
              const next = o && o.priceFrom.getTime() > at.getTime() ? o : null;
              const flagged = deps.routeEngine(route);
              return {
                task: route.task,
                capability: route.capability,
                providerId: route.providerId,
                model: route.model,
                providerSource: 'configuration' as const,
                maxOutputTokens: route.maxOutputTokens,
                inputPerMillion: rate(route.price)?.inputPerMillion ?? null,
                outputPerMillion: rate(route.price)?.outputPerMillion ?? null,
                nextRate: next
                  ? {
                      inputPerMillion: rate(next.price)?.inputPerMillion ?? null,
                      outputPerMillion: rate(next.price)?.outputPerMillion ?? null,
                      from: next.priceFrom.toISOString(),
                    }
                  : null,
                assetId: deps.feeAssetId,
                engine: flagged.engine,
                metered: flagged.metered,
                pending: pendingOf.get(route.task) ?? null,
                lastChange: lastOf.get(route.task) ?? null,
              };
            }),
            audit: desk.audit,
          };
        }),
      ),

    propose: operator('admin:write')
      .input(
        z.object({
          task: z.string().min(1).max(120),
          maxOutputTokens: z.number().int(),
          inputPerMillion: z.string().max(40).nullable(),
          outputPerMillion: z.string().max(40).nullable(),
          requestId: z.string().min(8).max(200),
        }),
      )
      .output(changeSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const { requestId, ...change } = input;
          return ready().store.propose(ctx.principal.userId, change, requestId);
        }),
      ),

    withdraw: operator('admin:write')
      .input(z.object({ changeId }))
      .output(changeSchema)
      .mutation(({ ctx, input }) => guard(async () => ready().store.withdraw(ctx.principal.userId, input.changeId))),

    confirm: operator('admin:write')
      .input(z.object({ changeId }))
      .output(changeSchema)
      .mutation(({ ctx, input }) => guard(async () => ready().store.confirm(ctx.principal.userId, input.changeId))),
  };
}

export const routeChangesRouter = (deps: RouteDeskDeps) => router(routeDeskProcedures(deps));
