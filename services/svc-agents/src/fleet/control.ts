import type { Sql } from 'postgres';
import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { OWN_TOOLS } from '../own/catalog.js';

/**
 * The operator's agent fleet (AG-registry-01, AG-control-02): every agent on the platform in one registry, with its
 * owner, publisher, channels and risk signals read from stored rows, an audited CSV export, and the switches. The brake
 * is easy and the release is hard: one operator quarantines an agent or switches a whole kind off; two distinct
 * founders restore either. Every action and every export writes one `agent_fleet_audit` row on a business key, in the
 * same transaction as what it records, so a retried request writes nothing twice. No money moves here.
 *
 * An agent is named by a reference: `product:<agent_id>` for a registered product agent, `own:<uuid>` for an agent a
 * person built.
 */

export const FLEET_KINDS = ['customer_built', 'product'] as const;
export type FleetKind = (typeof FLEET_KINDS)[number];
export const FLEET_STATUSES = ['active', 'quarantined', 'disabled_by_kind', 'disabled'] as const;
export type FleetStatus = (typeof FLEET_STATUSES)[number];
/** The risk signals, each computed from stored rows (AG-registry-01). */
export const RISK_SIGNALS = ['no_owner', 'write_tool', 'no_spend_cap', 'never_run'] as const;
export type RiskSignal = (typeof RISK_SIGNALS)[number];

/** The refusal an own agent's new session or run meets while it is quarantined or its kind is off. */
export const AGENT_DISABLED = 'agents.agent.disabled' as const;

export type FleetRefusalCode =
  | 'agents.registry_list_limit_unset'
  | 'agents.reason_required'
  | 'agents.agent_not_found'
  | 'agents.fleet_not_quarantined'
  | 'agents.fleet_already_quarantined'
  | 'agents.fleet_kind_not_off'
  | 'agents.fleet_kind_already_off'
  | 'agents.fleet_owner_present'
  | 'agents.fleet_request_reused'
  | 'agents.fleet_person_only';

export class FleetRefusal extends Error {
  constructor(readonly code: FleetRefusalCode) {
    super(code);
    this.name = 'FleetRefusal';
  }
}

const STATUS: Record<FleetRefusalCode, TRPCError['code']> = {
  'agents.registry_list_limit_unset': 'PRECONDITION_FAILED',
  'agents.reason_required': 'BAD_REQUEST',
  'agents.agent_not_found': 'NOT_FOUND',
  'agents.fleet_not_quarantined': 'CONFLICT',
  'agents.fleet_already_quarantined': 'CONFLICT',
  'agents.fleet_kind_not_off': 'CONFLICT',
  'agents.fleet_kind_already_off': 'CONFLICT',
  'agents.fleet_owner_present': 'CONFLICT',
  'agents.fleet_request_reused': 'CONFLICT',
  'agents.fleet_person_only': 'FORBIDDEN',
};

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof FleetRefusal)) throw err;
    throw new TRPCError({ code: STATUS[err.code], message: err.code, cause: err });
  }
}

/** The owner's values for the registry. Null is blank and refuses the read that needs it. */
export interface FleetSettings {
  /** AGENTS_REGISTRY_LIST_LIMIT: rows one registry read shows. The export always covers the full range. */
  readonly registryLimit: number | null;
}

export interface FleetSwitch {
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
  readonly restoreRequestedBy: string | null;
}

export interface FleetRow {
  readonly ref: string;
  readonly name: string | null;
  readonly kind: FleetKind;
  readonly ownerId: string | null;
  readonly publisherId: string | null;
  readonly channels: string[] | null;
  readonly riskSignals: RiskSignal[];
  readonly status: FleetStatus;
  readonly lastRunAt: string | null;
  readonly quarantine: FleetSwitch | null;
  readonly kindSwitch: FleetSwitch | null;
}

const OWN_PREFIX = 'own:';
const PRODUCT_PREFIX = 'product:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A tool of a person's own agent that writes (a draft it sends or a live write) or moves value. */
const OWN_WRITE_TOOLS: ReadonlySet<string> = new Set(
  OWN_TOOLS.filter((tool) => tool.movesMoney || tool.dataClass === 'draft_write' || tool.dataClass === 'live_write').map((t) => t.name),
);

type SwitchRow = { key: string; reason: string; set_by: string; set_at: Date; restore_requested_by: string | null };
const switchView = (row: SwitchRow | undefined): FleetSwitch | null =>
  row ? { reason: row.reason, setBy: row.set_by, setAt: row.set_at.toISOString(), restoreRequestedBy: row.restore_requested_by } : null;

interface Guardrailish {
  readonly tools?: readonly { readonly mode?: string }[];
  readonly limits?: { readonly maxSpendPerSession?: unknown };
}

/** Every agent on the platform: product agents by id, then people's agents newest first, so a page never hides a new one. */
export async function readFleet(sql: Sql): Promise<FleetRow[]> {
  const [products, owns, switches, kinds, owners, runs, surfaces] = await Promise.all([
    sql<{ agent_id: string; name: string | null; guardrail: Guardrailish; enabled: boolean }[]>`
      SELECT agent_id, name, guardrail, enabled FROM agents.agent_definitions WHERE agent_id NOT LIKE 'own.%' ORDER BY agent_id
    `,
    sql<{ id: string; owner_id: string; name: string; tools: string[]; per_session_cap: string | null; state: string }[]>`
      SELECT id, owner_id, name, tools, per_session_cap::text AS per_session_cap, state FROM agents.own_agents ORDER BY created_at DESC, id
    `,
    sql<SwitchRow[]>`SELECT agent_ref AS key, reason, set_by, set_at, restore_requested_by FROM agents.agent_switches`,
    sql<SwitchRow[]>`SELECT kind AS key, reason, set_by, set_at, restore_requested_by FROM agents.agent_kind_switches`,
    sql<{ agent_ref: string; owner_id: string }[]>`SELECT agent_ref, owner_id FROM agents.agent_owner_assignments`,
    sql<{ agent_id: string; last: Date }[]>`SELECT agent_id, max(opened_at) AS last FROM agents.agent_sessions GROUP BY agent_id`,
    sql<{ agent_id: string; surfaces: string[] }[]>`
      SELECT agent_id::text AS agent_id, array_agg(surface ORDER BY surface) AS surfaces FROM agents.own_agent_surfaces GROUP BY agent_id
    `,
  ]);
  const switchOf = new Map(switches.map((row) => [row.key, row]));
  const kindOf = new Map(kinds.map((row) => [row.key, row]));
  const assigned = new Map(owners.map((row) => [row.agent_ref, row.owner_id]));
  const lastRun = new Map(runs.map((row) => [row.agent_id, row.last.toISOString()]));
  const channelsOf = new Map(surfaces.map((row) => [row.agent_id, row.surfaces]));

  const finish = (
    base: Omit<FleetRow, 'riskSignals' | 'status' | 'quarantine' | 'kindSwitch'>,
    flags: { writeTool: boolean; noCap: boolean; enabled: boolean },
  ): FleetRow => {
    const quarantine = switchView(switchOf.get(base.ref));
    const kindSwitch = switchView(kindOf.get(base.kind));
    const status: FleetStatus = quarantine ? 'quarantined' : kindSwitch ? 'disabled_by_kind' : flags.enabled ? 'active' : 'disabled';
    const riskSignals: RiskSignal[] = [];
    if (base.ownerId === null && status === 'active') riskSignals.push('no_owner');
    if (flags.writeTool) riskSignals.push('write_tool');
    if (flags.noCap) riskSignals.push('no_spend_cap');
    if (base.lastRunAt === null) riskSignals.push('never_run');
    return { ...base, riskSignals, status, quarantine, kindSwitch };
  };

  const rows: FleetRow[] = [];
  for (const product of products) {
    const ref = `${PRODUCT_PREFIX}${product.agent_id}`;
    const tools = Array.isArray(product.guardrail?.tools) ? product.guardrail.tools : [];
    const cap = product.guardrail?.limits?.maxSpendPerSession;
    rows.push(
      finish(
        {
          ref,
          name: product.name,
          kind: 'product',
          ownerId: assigned.get(ref) ?? null,
          // A product agent's publisher and channels are not stored yet: "not set", never an invented value.
          publisherId: null,
          channels: null,
          lastRunAt: lastRun.get(product.agent_id) ?? null,
        },
        { writeTool: tools.some((tool) => tool.mode === 'write'), noCap: cap === null || cap === undefined, enabled: product.enabled },
      ),
    );
  }
  for (const own of owns) {
    const ref = `${OWN_PREFIX}${own.id}`;
    const ownerId = assigned.get(ref) ?? own.owner_id;
    rows.push(
      finish(
        {
          ref,
          name: own.name === '' ? null : own.name,
          kind: 'customer_built',
          ownerId,
          // A person's agent is published by the person who built it; a draft is published by no one yet.
          publisherId: own.state === 'published' ? own.owner_id : null,
          channels: channelsOf.get(own.id) ?? null,
          lastRunAt: lastRun.get(`own.${own.id}`) ?? null,
        },
        { writeTool: own.tools.some((tool) => OWN_WRITE_TOOLS.has(tool)), noCap: own.per_session_cap === null, enabled: true },
      ),
    );
  }
  return rows;
}

export interface FleetFilter {
  readonly riskSignal?: RiskSignal | undefined;
  readonly status?: FleetStatus | undefined;
  readonly kind?: FleetKind | undefined;
  readonly ownerless?: boolean | undefined;
}

export const filterFleet = (rows: readonly FleetRow[], filter: FleetFilter): FleetRow[] =>
  rows.filter(
    (row) =>
      (!filter.riskSignal || row.riskSignals.includes(filter.riskSignal)) &&
      (!filter.status || row.status === filter.status) &&
      (!filter.kind || row.kind === filter.kind) &&
      (filter.ownerless === undefined || (row.ownerId === null) === filter.ownerless),
  );

/** Total, ownerless (no owner), unmanaged (no owner and not a product agent), disabled and quarantined. */
export function fleetCounts(rows: readonly FleetRow[]) {
  return {
    total: rows.length,
    ownerless: rows.filter((row) => row.ownerId === null).length,
    unmanaged: rows.filter((row) => row.ownerId === null && row.kind !== 'product').length,
    disabled: rows.filter((row) => row.status === 'disabled' || row.status === 'disabled_by_kind').length,
    quarantined: rows.filter((row) => row.status === 'quarantined').length,
  };
}

const CSV_HEADER = ['agent', 'name', 'kind', 'owner', 'publisher', 'channels', 'status', 'risk_signals', 'last_run_at'];
const csvCell = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** The filtered registry as CSV, one line per agent and a header. A value not stored is "not set". */
export function fleetCsv(rows: readonly FleetRow[]): string {
  const NOT_SET = 'not set';
  const lines = rows.map((row) =>
    [
      row.ref,
      row.name ?? NOT_SET,
      row.kind,
      row.ownerId ?? NOT_SET,
      row.publisherId ?? NOT_SET,
      row.channels ? row.channels.join(' ') : NOT_SET,
      row.status,
      row.riskSignals.join(' '),
      row.lastRunAt ?? NOT_SET,
    ]
      .map((cell) => csvCell(cell.replace(/[\r\n]+/g, ' ')))
      .join(','),
  );
  return [CSV_HEADER.join(','), ...lines].join('\n') + '\n';
}

/**
 * Whether new work of one of a person's agents may start: `active`, or the switch that stops it. Read at every session
 * open and every run, so a quarantine set after a session opened still stops the next run.
 */
export async function ownAgentSwitch(sql: Sql, agentId: string): Promise<'active' | 'quarantined' | 'disabled_by_kind'> {
  const rows = await sql<{ quarantined: boolean; kind_off: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM agents.agent_switches WHERE agent_ref = ${`${OWN_PREFIX}${agentId}`}) AS quarantined,
           EXISTS (SELECT 1 FROM agents.agent_kind_switches WHERE kind = 'customer_built') AS kind_off
  `;
  const row = rows[0];
  return row?.quarantined ? 'quarantined' : row?.kind_off ? 'disabled_by_kind' : 'active';
}

/** Whether the product agents' kind is switched off: a new product session refuses while it is. */
export async function productKindOff(sql: Sql): Promise<boolean> {
  const rows = await sql<{ off: boolean }[]>`SELECT EXISTS (SELECT 1 FROM agents.agent_kind_switches WHERE kind = 'product') AS off`;
  return rows[0]?.off === true;
}

type Action = 'export' | 'quarantine' | 'restore_request' | 'restore' | 'kill_kind' | 'restore_kind_request' | 'restore_kind' | 'reassign';

/** One action's business key: the same request again writes no second row and changes nothing a second time. */
export const fleetKey = (action: string, operatorId: string, requestId: string): string =>
  `agents:fleet:${action}:${operatorId}:${requestId}`;

/**
 * Writes the action's audit row once. True when this call wrote it (the action runs now); false when the same request
 * already did (the action ran then). A key already used for a different target is refused.
 */
async function recordAction(
  tx: Sql,
  row: {
    key: string;
    operatorId: string;
    action: Action;
    agentRef?: string | null;
    kind?: string | null;
    reason?: string | null;
    filter?: Record<string, string>;
    rowCount?: number | null;
  },
): Promise<boolean> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO agents.agent_fleet_audit (business_key, operator_id, action, agent_ref, kind, reason, filter, row_count)
    VALUES (${row.key}, ${row.operatorId}, ${row.action}, ${row.agentRef ?? null}, ${row.kind ?? null}, ${row.reason ?? null},
            ${tx.json(row.filter ?? {})}, ${row.rowCount ?? null})
    ON CONFLICT (business_key) DO NOTHING
    RETURNING id
  `;
  if (inserted.length > 0) return true;
  const [stored] = await tx<{ action: string; agent_ref: string | null; kind: string | null }[]>`
    SELECT action, agent_ref, kind FROM agents.agent_fleet_audit WHERE business_key = ${row.key}
  `;
  if (!stored || stored.agent_ref !== (row.agentRef ?? null) || stored.kind !== (row.kind ?? null)) {
    throw new FleetRefusal('agents.fleet_request_reused');
  }
  return false;
}

function assertReason(reason: string | undefined): string {
  const picked = reason?.trim() ?? '';
  if (picked === '') throw new FleetRefusal('agents.reason_required');
  return picked;
}

/** The agent a reference names, as it is stored now; an unknown reference is `agents.agent_not_found`. */
async function assertAgent(tx: Sql, ref: string): Promise<{ kind: FleetKind; id: string }> {
  if (ref.startsWith(PRODUCT_PREFIX)) {
    const id = ref.slice(PRODUCT_PREFIX.length);
    if (!id.startsWith('own.')) {
      const rows = await tx`SELECT 1 FROM agents.agent_definitions WHERE agent_id = ${id}`;
      if (rows.length > 0) return { kind: 'product', id };
    }
  } else if (ref.startsWith(OWN_PREFIX)) {
    const id = ref.slice(OWN_PREFIX.length);
    if (UUID_RE.test(id)) {
      const rows = await tx`SELECT 1 FROM agents.own_agents WHERE id = ${id}`;
      if (rows.length > 0) return { kind: 'customer_built', id };
    }
  }
  throw new FleetRefusal('agents.agent_not_found');
}

export type RestoreOutcome = 'waiting_second_founder' | 'restored';

export class FleetStore {
  constructor(private readonly sql: Sql) {}

  async quarantine(operatorId: string, ref: string, reason: string | undefined, requestId: string): Promise<void> {
    const why = assertReason(reason);
    await transaction(this.sql, async (tx) => {
      const agent = await assertAgent(tx, ref);
      const key = fleetKey('quarantine', operatorId, requestId);
      const [existing] = await tx`SELECT 1 FROM agents.agent_switches WHERE agent_ref = ${ref} FOR UPDATE`;
      if (existing) {
        // The same request again is the first answer; a new request on a quarantined agent is refused by name.
        const [mine] = await tx`SELECT 1 FROM agents.agent_fleet_audit WHERE business_key = ${key} AND agent_ref = ${ref}`;
        if (mine) return;
        throw new FleetRefusal('agents.fleet_already_quarantined');
      }
      if (!(await recordAction(tx, { key, operatorId, action: 'quarantine', agentRef: ref, reason: why }))) return;
      await tx`INSERT INTO agents.agent_switches (agent_ref, reason, set_by) VALUES (${ref}, ${why}, ${operatorId})`;
      // A product agent's own switch goes off too, which a boot re-register keeps (registerAgent preserves enabled).
      if (agent.kind === 'product') await tx`UPDATE agents.agent_definitions SET enabled = false WHERE agent_id = ${agent.id}`;
    });
  }

  /**
   * The first founder's press records the request; a different founder's press restores the agent. The same founder
   * pressing again changes nothing: the restore waits for a second founder.
   */
  async restore(operatorId: string, ref: string, requestId: string): Promise<RestoreOutcome> {
    return transaction(this.sql, async (tx) => {
      const agent = await assertAgent(tx, ref);
      const [current] = await tx<{ restore_requested_by: string | null }[]>`
        SELECT restore_requested_by FROM agents.agent_switches WHERE agent_ref = ${ref} FOR UPDATE
      `;
      if (!current) {
        const [restored] = await tx`
          SELECT 1 FROM agents.agent_fleet_audit WHERE business_key = ${fleetKey('restore', operatorId, requestId)} AND agent_ref = ${ref}
        `;
        if (restored) return 'restored';
        throw new FleetRefusal('agents.fleet_not_quarantined');
      }
      if (current.restore_requested_by === null || current.restore_requested_by === operatorId) {
        if (
          await recordAction(tx, {
            key: fleetKey('restore_request', operatorId, requestId),
            operatorId,
            action: 'restore_request',
            agentRef: ref,
          })
        ) {
          await tx`
            UPDATE agents.agent_switches SET restore_requested_by = ${operatorId}, restore_requested_at = now()
             WHERE agent_ref = ${ref} AND restore_requested_by IS NULL
          `;
        }
        return 'waiting_second_founder';
      }
      if (await recordAction(tx, { key: fleetKey('restore', operatorId, requestId), operatorId, action: 'restore', agentRef: ref })) {
        await tx`DELETE FROM agents.agent_switches WHERE agent_ref = ${ref}`;
        if (agent.kind === 'product') await tx`UPDATE agents.agent_definitions SET enabled = true WHERE agent_id = ${agent.id}`;
      }
      return 'restored';
    });
  }

  /** Every agent of one kind off in one audited action. A restart reads the row again and never re-enables it. */
  async killKind(operatorId: string, kind: FleetKind, reason: string | undefined, requestId: string): Promise<number> {
    const why = assertReason(reason);
    await transaction(this.sql, async (tx) => {
      const key = fleetKey('kill_kind', operatorId, requestId);
      const [existing] = await tx`SELECT 1 FROM agents.agent_kind_switches WHERE kind = ${kind} FOR UPDATE`;
      if (existing) {
        const [mine] = await tx`SELECT 1 FROM agents.agent_fleet_audit WHERE business_key = ${key} AND kind = ${kind}`;
        if (mine) return;
        throw new FleetRefusal('agents.fleet_kind_already_off');
      }
      const count = await kindCount(tx, kind);
      if (!(await recordAction(tx, { key, operatorId, action: 'kill_kind', kind, reason: why, rowCount: count }))) return;
      await tx`INSERT INTO agents.agent_kind_switches (kind, reason, set_by) VALUES (${kind}, ${why}, ${operatorId})`;
    });
    return kindCount(this.sql, kind);
  }

  async restoreKind(operatorId: string, kind: FleetKind, requestId: string): Promise<RestoreOutcome> {
    return transaction(this.sql, async (tx) => {
      const [current] = await tx<{ restore_requested_by: string | null }[]>`
        SELECT restore_requested_by FROM agents.agent_kind_switches WHERE kind = ${kind} FOR UPDATE
      `;
      if (!current) {
        const [restored] = await tx`
          SELECT 1 FROM agents.agent_fleet_audit WHERE business_key = ${fleetKey('restore_kind', operatorId, requestId)} AND kind = ${kind}
        `;
        if (restored) return 'restored';
        throw new FleetRefusal('agents.fleet_kind_not_off');
      }
      if (current.restore_requested_by === null || current.restore_requested_by === operatorId) {
        const key = fleetKey('restore_kind_request', operatorId, requestId);
        if (await recordAction(tx, { key, operatorId, action: 'restore_kind_request', kind })) {
          await tx`
            UPDATE agents.agent_kind_switches SET restore_requested_by = ${operatorId}, restore_requested_at = now()
             WHERE kind = ${kind} AND restore_requested_by IS NULL
          `;
        }
        return 'waiting_second_founder';
      }
      if (await recordAction(tx, { key: fleetKey('restore_kind', operatorId, requestId), operatorId, action: 'restore_kind', kind })) {
        await tx`DELETE FROM agents.agent_kind_switches WHERE kind = ${kind}`;
      }
      return 'restored';
    });
  }

  /** Gives an agent with no owner an owner of record. An agent that has an owner is refused, never taken from them. */
  async reassign(operatorId: string, ref: string, ownerId: string, requestId: string): Promise<void> {
    await transaction(this.sql, async (tx) => {
      const agent = await assertAgent(tx, ref);
      const key = fleetKey('reassign', operatorId, requestId);
      const [assigned] = await tx<{ owner_id: string }[]>`
        SELECT owner_id FROM agents.agent_owner_assignments WHERE agent_ref = ${ref} FOR UPDATE
      `;
      const [mine] = await tx`SELECT 1 FROM agents.agent_fleet_audit WHERE business_key = ${key} AND agent_ref = ${ref}`;
      if (mine) return;
      if (assigned || agent.kind === 'customer_built') throw new FleetRefusal('agents.fleet_owner_present');
      await recordAction(tx, { key, operatorId, action: 'reassign', agentRef: ref });
      await tx`INSERT INTO agents.agent_owner_assignments (agent_ref, owner_id, assigned_by) VALUES (${ref}, ${ownerId}, ${operatorId})`;
    });
  }

  /** Records one export of the filtered registry: one audit row per request id, naming the filter and the row count. */
  async recordExport(operatorId: string, requestId: string, filter: Record<string, string>, rowCount: number): Promise<number> {
    return transaction(this.sql, async (tx) => {
      const key = fleetKey('export', operatorId, requestId);
      await recordAction(tx, { key, operatorId, action: 'export', filter, rowCount });
      const [stored] = await tx<{ filter: Record<string, string> }[]>`
        SELECT filter FROM agents.agent_fleet_audit WHERE business_key = ${key}
      `;
      if (JSON.stringify(Object.entries(stored?.filter ?? {}).sort()) !== JSON.stringify(Object.entries(filter).sort())) {
        throw new FleetRefusal('agents.fleet_request_reused');
      }
      const [n] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.agent_fleet_audit WHERE business_key = ${key}`;
      return n!.n;
    });
  }
}

async function kindCount(sql: Sql, kind: FleetKind): Promise<number> {
  const [row] =
    kind === 'product'
      ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.agent_definitions WHERE agent_id NOT LIKE 'own.%'`
      : await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.own_agents`;
  return row!.n;
}

const switchSchema = z.object({ reason: z.string(), setBy: z.string(), setAt: z.string(), restoreRequestedBy: z.string().nullable() });
export const fleetRowSchema = z.object({
  ref: z.string(),
  name: z.string().nullable(),
  kind: z.enum(FLEET_KINDS),
  ownerId: z.string().nullable(),
  publisherId: z.string().nullable(),
  channels: z.array(z.string()).nullable(),
  riskSignals: z.array(z.enum(RISK_SIGNALS)),
  status: z.enum(FLEET_STATUSES),
  lastRunAt: z.string().nullable(),
  quarantine: switchSchema.nullable(),
  kindSwitch: switchSchema.nullable(),
});

const filterInput = {
  riskSignal: z.enum(RISK_SIGNALS).optional(),
  status: z.enum(FLEET_STATUSES).optional(),
  kind: z.enum(FLEET_KINDS).optional(),
  ownerless: z.boolean().optional(),
};
const requestId = z.string().min(8).max(200);
const ref = z.string().min(1).max(120);

const filterRecord = (filter: FleetFilter): Record<string, string> =>
  Object.fromEntries(Object.entries(filter).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));

function sqlOf(sql: Sql | undefined): Sql {
  if (!sql) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
  return sql;
}

export function fleetRouter(sql: Sql | undefined, settings: FleetSettings) {
  // A signed-in operator's own session: never a service forwarding a principal, an API key or a sub-account.
  const operator = (scope: 'admin:read' | 'admin:write') =>
    scopedProcedure(scope, { module: 'agents', person: true }).use(({ ctx, next }) => {
      if (ctx.principal.kid || ctx.principal.sub_account) throw new TRPCError({ code: 'FORBIDDEN', message: 'agents.fleet_person_only' });
      return next();
    });
  const store = () => new FleetStore(sqlOf(sql));

  return router({
    /** One page of the registry under a filter, with the counts over the whole fleet and how many rows the filter matches. */
    registry: operator('admin:read')
      // No filter is no input at all on a GET: the whole fleet.
      .input(z.object(filterInput).optional())
      .output(
        z.object({
          counts: z.object({
            total: z.number().int(),
            ownerless: z.number().int(),
            unmanaged: z.number().int(),
            disabled: z.number().int(),
            quarantined: z.number().int(),
          }),
          rows: z.array(fleetRowSchema),
          filtered: z.number().int(),
          more: z.boolean(),
          limit: z.number().int(),
        }),
      )
      .query(({ input }) =>
        guard(async () => {
          if (settings.registryLimit === null) throw new FleetRefusal('agents.registry_list_limit_unset');
          const all = await readFleet(sqlOf(sql));
          const matched = filterFleet(all, input ?? {});
          return {
            counts: fleetCounts(all),
            rows: matched.slice(0, settings.registryLimit),
            filtered: matched.length,
            more: matched.length > settings.registryLimit,
            limit: settings.registryLimit,
          };
        }),
      ),

    /** The filtered registry as CSV over the full range, never the loaded page, with one audit row per request id. */
    export: operator('admin:read')
      .input(z.object({ ...filterInput, requestId }))
      .output(z.object({ csv: z.string(), rows: z.number().int(), auditRows: z.number().int() }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const { requestId: id, ...filter } = input;
          const matched = filterFleet(await readFleet(sqlOf(sql)), filter);
          const auditRows = await store().recordExport(ctx.principal.userId, id, filterRecord(filter), matched.length);
          return { csv: fleetCsv(matched), rows: matched.length, auditRows };
        }),
      ),

    quarantine: operator('admin:write')
      .input(z.object({ ref, reason: z.string().max(500).optional(), requestId }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          await store().quarantine(ctx.principal.userId, input.ref, input.reason, input.requestId);
          return { ok: true as const };
        }),
      ),

    restore: operator('admin:write')
      .input(z.object({ ref, requestId }))
      .output(z.object({ outcome: z.enum(['waiting_second_founder', 'restored']) }))
      .mutation(({ ctx, input }) =>
        guard(async () => ({ outcome: await store().restore(ctx.principal.userId, input.ref, input.requestId) })),
      ),

    killKind: operator('admin:write')
      .input(z.object({ kind: z.enum(FLEET_KINDS), reason: z.string().max(500).optional(), requestId }))
      .output(z.object({ agents: z.number().int() }))
      .mutation(({ ctx, input }) =>
        guard(async () => ({ agents: await store().killKind(ctx.principal.userId, input.kind, input.reason, input.requestId) })),
      ),

    restoreKind: operator('admin:write')
      .input(z.object({ kind: z.enum(FLEET_KINDS), requestId }))
      .output(z.object({ outcome: z.enum(['waiting_second_founder', 'restored']) }))
      .mutation(({ ctx, input }) =>
        guard(async () => ({ outcome: await store().restoreKind(ctx.principal.userId, input.kind, input.requestId) })),
      ),

    reassign: operator('admin:write')
      .input(z.object({ ref, ownerId: z.string().uuid(), requestId }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          await store().reassign(ctx.principal.userId, input.ref, input.ownerId, input.requestId);
          return { ok: true as const };
        }),
      ),
  });
}
