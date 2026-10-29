import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  AuthError,
  bearerToken,
  hasScope,
  requireMfa,
  requireScope,
  verifyAccessToken,
  type Principal,
  type TokenConfig,
} from '@intafaced/auth';
import {
  MODULE_IDS,
  enforcementOf,
  isModuleId,
  type ComplianceQueueDispositionRequest,
  type ComplianceQueueDispositionResult,
  type ComplianceQueueItem,
  type ModuleId,
} from '@intafaced/config';
import {
  queryWarehouseSurface,
  resolveWarehouseReplicaConfig,
  warehouseSurfaceStatusLine,
  type ActionApproval,
  type ActionApprovalConsumeInput,
  type LagSource,
  type WarehouseLagProbe,
  type WarehouseSurfaceResult,
} from '@intafaced/contracts';
import {
  defineReconciliationControlInputSchema,
  listReconciliationControlRunsInputSchema,
  runReconciliationControlInputSchema,
  updateReconciliationControlInputSchema,
} from '@intafaced/contracts/ledger-reconciliation';
import { createEdgeWarehouseLagProbe, warehouseLagProbeEnabled } from './analytics-lag-probe.js';
import {
  ActionApprovalConsumeError,
  edgeActionPayloadHash,
  readApprovalIds,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';
import { EdgeComplianceQueue, edgeComplianceHonesty, type EdgeComplianceHonesty } from './compliance-honesty.js';
import { readConfirmOperatorId, requireDualControl } from './dual-control.js';

import type { KillSwitchAuditEntry, KillSwitchDurability, KillSwitchState } from './kill-switch.js';
import { ENFORCEABLE_MODULES, OUTSIDE_THE_DOOR } from './routes.js';

export type WarehouseDoorSnapshot = {
  readonly replicaConfigured: boolean;
  readonly replicaCount: number;
  readonly refuse: string | null;
  readonly surfaceStatus: WarehouseSurfaceResult['status'];
  readonly mayLabelLive: boolean;
  readonly statusLine: string;
  readonly etlWatermark: EdgeComplianceHonesty['analytics']['etlWatermark'];
  readonly etlWatermarkAt: string | null;
  readonly etlNote: string;
  readonly surface: WarehouseSurfaceResult;
  readonly lagSource: LagSource;
  readonly lagSeconds: number | null;
  readonly lagMeasuredAt: number | null;
};

/**
 * THE OPERATOR CONTROL SURFACE (§14.6) — what `apps/admin` reaches.
 *
 * Mounted at `/admin/*`, deliberately OUTSIDE `/api/*`: nothing here is
 * proxied, and the catch-all proxy must never be the thing that decides whether
 * an admin path is real. `resolve()` returns null for `/admin/...` and an
 * unlisted prefix is a 404, so these routes have to be registered explicitly —
 * which is the property that keeps `/admin` from ever becoming a pass-through.
 *
 * ── Authentication: the platform's own tokens, not a shared operator key ────
 *
 * The obvious shortcut is a static `ADMIN_CONTROL_SECRET` header. It was
 * rejected: a static secret has no subject, so the audit line for the most
 * consequential action in the platform would read "somebody with the key", and
 * rotating it means restarting the edge — during an incident, which is when the
 * key is most likely to have been in a screenshot.
 *
 * The edge already holds `JWT_ACCESS_SECRET`, because verifying user tokens is
 * its entire job. So an operator presents the same kind of token every other
 * caller presents, and it is checked with the same guards every service uses.
 *
 * ── Two scopes, because there are two different authorities here ────────────
 *
 *   · `admin:write` — halt a module. No user session carries it;
 *     `defaultScopes()` in svc-identity does not list it, `SESSION_SCOPES`
 *     excludes every `admin:*` scope, and `assertDelegatableScopes` refuses to
 *     mint an API key with one.
 *
 *     `requireMfa` is applied locally, exactly as `kyc.approve` does it and for
 *     the same stated reason: `admin:write` is not in `INTERACTIVE_ONLY_SCOPES`
 *     (whose membership test is "does this move value OFF the platform"), but a
 *     switch that can stop the exchange is a privilege whose leak must cost a
 *     second factor. Arguing the shared list should grow belongs in its own PR
 *     (§15.2).
 *
 *   · `admin:treasury` — the ledger freeze, and anything else that touches the
 *     money plane. Already in `INTERACTIVE_ONLY_SCOPES`, so `requireScope`
 *     enforces MFA by itself and no local check is needed.
 *
 * Halting one market and halting all value movement platform-wide are not the
 * same authority and must not share a credential. An operator on the trading
 * desk needs the first; the second is the switch `flags.ts` calls "the most
 * consequential in the platform", and `svc-ledger` gates it on `admin:treasury`
 * on its own side too. Checking it here as well is not redundancy for its own
 * sake — it means the edge refuses before it forwards a token, so an
 * under-scoped operator never reaches the money plane at all.
 *
 * The two ledger object lookups are reads and take a founder's `admin:read`
 * with a second factor on a live session instead (`authenticateLookup`, owner
 * decision 2026-10-23, ADR 2026-10-22 §3.9); svc-ledger applies the same rule.
 *
 * Mutate of `/admin/kill-switches` is dual-control: the signed `admin:write`
 * principal plus a distinct `confirmOperatorId`. Missing or same-as-operator
 * confirm refuses (`missing_operator`) — one operator cannot kill or resume a
 * module. Matching halt and ledger freeze already require the same pair; a
 * one-operator kill-all at this door would be the same lie as a one-operator halt.
 * GET stays single-operator (read is not mutate).
 *
 * The token names a user, so every flip is attributable. The confirmer is a
 * named identity on the body; the edge does not invent a second caller.
 */

/**
 * Why this module cannot be armed from here, or null if it can.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 *
 * The refinement below used to be `isModuleId` alone: every one of the 23
 * `MODULE_IDS` was accepted, while the edge can only enforce the 13 that have a
 * prefix in the route table. The other ten were armable and unenforceable — a
 * halt that returned 200, showed up in `disabledModules`, appeared in the audit
 * trail as a real event, and refused nothing.
 *
 * `ws` was the one that mattered: svc-ws is deployed, publishes 4014, and the
 * browser talks to it directly. An operator halting the market data socket
 * during an incident got a green console and a live socket.
 *
 * A kill-switch the operator can arm but the platform cannot enforce is worse
 * than an absent one, for the same reason a check that fails open is: the
 * failure is invisible precisely when it is being relied on. So the control
 * plane now refuses, and says which control to reach for instead.
 */
function unenforceable(module: ModuleId): string | null {
  if (ENFORCEABLE_MODULES.has(module)) return null;
  const known = OUTSIDE_THE_DOOR[module];
  if (known) return known;
  // A module in the registry with no service behind this edge yet. Refused
  // rather than accepted, so an operator is never told a phase-5 surface was
  // halted when there is nothing there to halt.
  return `no route on this edge forwards to "${module}", so halting it would refuse nothing`;
}

const toggleSchema = z.object({
  module: z
    .string()
    .refine(isModuleId, { message: `module must be one of: ${MODULE_IDS.join(', ')}` })
    // Carries the SPECIFIC reason rather than a generic rejection — which control
    // to reach for instead is the half an operator at 3am actually needs.
    .superRefine((m, ctx) => {
      if (!isModuleId(m)) return; // already reported above
      const why = unenforceable(m);
      if (why) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${m}" cannot be halted at this edge: ${why}` });
    }),
  disabled: z.boolean(),
  /**
   * Required, and required to be useful.
   *
   * `apps/admin` already makes the operator type a reason before a ledger
   * freeze, on the argument that friction should be proportional to blast
   * radius. The same argument applies here and the check belongs on the server
   * as well as in the console — a control plane that trusts the UI to have
   * asked is a control plane with no record of why the platform went down.
   */
  reason: z.string().min(12).max(500),
  /**
   * Distinct confirming operator. Dual-control is enforced after parse
   * (`requireDualControl`) so missing/blank/same all refuse `missing_operator`
   * rather than a generic schema dump.
   */
  confirmOperatorId: z.string().optional().nullable(),
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
});

const freezeSchema = z.object({
  reason: z.string().min(12).max(500),
  confirmOperatorId: z.string().optional().nullable(),
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
});

const thawSchema = z.object({
  confirmOperatorId: z.string().optional().nullable(),
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
});

const reconcileSchema = thawSchema;

/** A control body Edge refuses before forwarding. Only this is a 400; a ledger that cannot be reached is not. */
export class InvalidControlBodyError extends Error {}

function parsedControlBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new InvalidControlBodyError(parsed.error.issues.map((issue) => issue.message).join('; '));
  return parsed.data;
}

export interface KillSwitchSnapshot {
  readonly disabledModules: readonly ModuleId[];
  readonly reasons: Readonly<Record<string, string>>;
  /** Who halted what, when, and what the state was before. Newest first. */
  readonly audit: readonly KillSwitchAuditEntry[];
}

/**
 * What the registry says about `edge.gateway` — never invent that the flag gates
 * the proxy when it is still `NOT_ENFORCED`.
 *
 * Live kill is `POST /admin/kill-switches` + the `onRequest` guard. Flipping the
 * flag in a console that only reads `isEnabled` does not stop traffic.
 */
export interface FlagEdgeGatewayHonesty {
  readonly key: 'edge.gateway';
  /**
   * Always false while `enforcementOf('edge.gateway').kind === 'none'`.
   * When a deliberate enforcement PR lands, this flips from the registry —
   * status must never hard-code "enforced".
   */
  readonly enforced: boolean;
  /** One sentence an operator can act on at 3am. */
  readonly note: string;
}

/**
 * Control-plane honesty fields the console needs so a green status is never
 * mistaken for a closed market-data socket or a fleet-wide kill.
 */
export interface ControlPlaneHonesty {
  /**
   * Modules the control plane will refuse to arm, with the reason the operator
   * must act on instead. `ws` is the load-bearing entry: svc-ws is outside this
   * edge (SOCKET §13 socket.ws-behind-the-edge).
   */
  readonly outsideTheDoor: Readonly<Record<string, string>>;
  /** Modules this edge can actually refuse traffic for (route-table-derived). */
  readonly enforceableModules: readonly ModuleId[];
  /** File and memory are process-local. True only when a shared kill store is attached. */
  readonly killState: KillSwitchDurability;
  /**
   * Live control surface name — not a feature-flag key.
   * Operators who only know `edge.gateway` must not invent a green halt.
   */
  readonly liveKillControl: 'operator-kill-switch';
  /** Registry honesty for the drop-I flag that still does not gate the proxy. */
  readonly flagEdgeGateway: FlagEdgeGatewayHonesty;
  /**
   * Mutate is dual-control. A console that omits `confirmOperatorId` must not
   * invent a green one-operator halt.
   */
  readonly killMutateDualControl: true;
}

export interface FreezeSnapshot {
  readonly frozen: boolean;
  readonly reason: string | null;
  readonly actor: string | null;
  readonly changedAt: string;
}

/**
 * How the edge reaches svc-ledger's operator surface.
 *
 * A function rather than a URL so the transport is injectable in a test without
 * a live ledger, and so this file states exactly what it needs: forward one
 * operator's own bearer token to one named path. It is not a proxy and cannot
 * become one.
 */
export type LedgerControlPath =
  | '/operator/reconciliation/controls'
  | '/operator/reconciliation/controls/update'
  | '/operator/reconciliation/controls/run'
  | '/operator/reconciliation/controls/runs';

export type LedgerOperatorCall = (
  path:
    | '/operator/freeze'
    | '/operator/unfreeze'
    | '/operator/reconcile'
    | LedgerLookupPath
    | LedgerDeskPath
    | LedgerControlPath
    | LedgerMetadataPath,
  method: 'GET' | 'POST',
  bearer: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

/**
 * The two operator object lookups svc-ledger serves (OPS-rules-monitoring-12). Built here from a checked UUID or an
 * encoded business key, never from a caller's raw path, so the forward still reaches exactly one named route.
 */
export type LedgerLookupPath = `/operator/transactions/${string}` | `/operator/trace?businessKey=${string}`;
/** The ledger desk's named reads, with or without their query. */
export type LedgerDeskPath =
  (typeof LEDGER_DESK_READS)[LedgerDeskRead]['path'] | `${(typeof LEDGER_DESK_READS)[LedgerDeskRead]['path']}?${string}`;

const LOOKUP_TX_ID = z.string().guid();
const LOOKUP_BUSINESS_KEY = z.string().trim().min(1).max(512);
const invalidLookup = (message: string) => ({ status: 400, body: { error: message, code: 'edge.invalid_ledger_lookup' } });

/**
 * The ledger desk's browsing reads (OPS-ledger-desk-01) and the query keys each one forwards. svc-ledger checks every
 * value; the edge forwards only these keys, each a single string of bounded length, re-encoded onto one named route.
 */
export const LEDGER_DESK_READS = {
  transactions: { path: '/operator/transactions', keys: ['assetId', 'from', 'to', 'before'] },
  accounts: { path: '/operator/accounts', keys: ['prefix', 'after'] },
  stats: { path: '/operator/stats', keys: [] },
} as const satisfies Record<string, { path: string; keys: readonly string[] }>;
export type LedgerDeskRead = keyof typeof LEDGER_DESK_READS;
const DESK_QUERY_VALUE_MAX = 256;

/**
 * An account's operator metadata (J-ops-console-03 #6, #7): the read, and the two treasury writes. Built from a checked
 * account UUID, never from a caller's raw path. svc-ledger checks every field; the edge forwards only the named ones.
 */
export type LedgerMetadataPath =
  `/operator/accounts/${string}/metadata` | `/operator/accounts/${string}/metadata/set` | `/operator/accounts/${string}/metadata/delete`;
const metadataField = z.string().max(DESK_QUERY_VALUE_MAX);
const metadataRevision = z.number().int().min(0).max(2_147_483_646);
const accountMetadataSetBody = z
  .object({ key: metadataField, value: z.string().max(500), reason: z.string().max(500), revision: metadataRevision })
  .strict();
const accountMetadataDeleteBody = z
  .object({
    key: metadataField,
    reason: z.string().max(500),
    revision: metadataRevision,
    approvalId: z.string().max(128),
    operationId: z.string().max(128),
  })
  .strict();

export interface AdminApi {
  /** Verify an Authorization header for module control, or throw `AuthError`. */
  authenticate(header: string | undefined): Promise<Principal>;
  /** Verify an Authorization header for founder reads. `admin:read`, no MFA. */
  authenticateRead(header: string | undefined): Promise<Principal>;
  /** Verify an Authorization header for treasury control, or throw `AuthError`. */
  authenticateTreasury(header: string | undefined): Promise<Principal>;
  /**
   * Verify an Authorization header for the ledger object lookups: `admin:read` with a second factor, on a live session
   * (owner decision 2026-10-23), the same rule svc-ledger applies. Or throw `AuthError`.
   */
  authenticateLookup(header: string | undefined): Promise<Principal>;
  /** Current kill-switch state and its audit trail, as the console renders it. */
  read(): KillSwitchSnapshot;
  /**
   * What the door cannot enforce, and how durable a kill is on this process.
   *
   * Used by `/admin/status` so an operator never reads "halted" for market data
   * that still streams on 4014, and never assumes a second replica saw the flip.
   */
  honesty(): ControlPlaneHonesty;
  /** Apply one module toggle. Dual-control; returns the new state. */
  apply(body: unknown, operator: Principal): Promise<KillSwitchSnapshot & { changed: boolean; confirmOperatorId: string }>;
  /**
   * Whether this edge process was started with a ledger URL.
   *
   * Boolean only — never pretends the freeze row was read. Used by `/admin/status`
   * so an operator can see "money plane unreachable from this edge" without a
   * treasury token.
   */
  ledgerConfigured(): boolean;
  /** Read the ledger's durable freeze row through svc-ledger. */
  readFreeze(header: string): Promise<{ status: number; body: unknown }>;
  /** Freeze or thaw the ledger. Attribution and durability are svc-ledger's. */
  setFreeze(frozen: boolean, body: unknown, header: string): Promise<{ status: number; body: unknown }>;
  /** Last ledger reconcile the edge successfully proxied, or a typed miss. */
  readReconcile(): Promise<{ status: number; body: unknown }>;
  /** Forward POST /operator/reconcile and keep a 2xx body as the last result. */
  runReconcile(body: unknown, header: string): Promise<{ status: number; body: unknown }>;
  /** One booked transaction by id, read by svc-ledger as the operator (it records the lookup first). */
  lookupTransaction(txId: unknown, header: string): Promise<{ status: number; body: unknown }>;
  /** The transaction a business key booked, or svc-ledger's `found: false`. Recorded by svc-ledger first. */
  traceBusinessKey(businessKey: unknown, header: string): Promise<{ status: number; body: unknown }>;
  /** One ledger desk read (list, address search or counts), read by svc-ledger as the operator. */
  readLedgerDesk(read: LedgerDeskRead, query: unknown, header: string): Promise<{ status: number; body: unknown }>;
  /** An account's operator metadata, forwarded with the operator's own token (lookup authority). */
  readAccountMetadata(accountId: unknown, header: string): Promise<{ status: number; body: unknown }>;
  /** Set or delete one metadata key (treasury). Throws `InvalidControlBodyError` for a body it will not forward. */
  writeAccountMetadata(
    write: 'set' | 'delete',
    accountId: unknown,
    body: unknown,
    header: string,
  ): Promise<{ status: number; body: unknown }>;
  /**
   * Reconciliation control list. `admin:treasury` (with a second factor) or `admin:compliance`.
   * Same rule as svc-ledger's list door.
   */
  authenticateControlRead(header: string | undefined): Promise<Principal>;
  /** Forward GET /operator/reconciliation/controls. */
  listReconciliationControls(header: string): Promise<{ status: number; body: unknown }>;
  /** Forward POST /operator/reconciliation/controls. Reason is required; the ledger audits it. */
  defineReconciliationControl(body: unknown, header: string): Promise<{ status: number; body: unknown }>;
  /** Forward POST /operator/reconciliation/controls/update. */
  updateReconciliationControl(body: unknown, header: string): Promise<{ status: number; body: unknown }>;
  /** Forward POST /operator/reconciliation/controls/run. Reason and approval travel in the body. */
  runReconciliationControl(body: unknown, header: string): Promise<{ status: number; body: unknown }>;
  /** Forward POST /operator/reconciliation/controls/runs: one control's evaluations, newest first. Read-only. */
  listReconciliationControlRuns(body: unknown, header: string): Promise<{ status: number; body: unknown }>;
  consumeApproval(input: ActionApprovalConsumeInput, operator: Principal): Promise<ActionApproval>;
  /**
   * Ops honesty residual (VPN/network, freeze invent, compliance queue, analytics dark).
   * Reads env at call time so tests can inject without rebooting the process.
   */
  opsHonesty(): EdgeComplianceHonesty;
  /** In-memory compliance queue snapshot (honest empty when nothing pending). */
  complianceQueueSnapshot(): ReturnType<EdgeComplianceQueue['snapshot']>;
  /** Open a case — never auto-invented. */
  openComplianceCase(item: ComplianceQueueItem): ReturnType<EdgeComplianceQueue['snapshot']>;
  /** Dispose a case — partner_cleared refuses without screening partner. */
  disposeComplianceCase(
    itemId: string,
    request: ComplianceQueueDispositionRequest,
    meta?: { readonly approverId?: string | null; readonly reason?: string | null },
  ): ComplianceQueueDispositionResult;
  /**
   * Analytics warehouse door with a real replica lag probe when URLs are set.
   * Absent URL / probe off / connect fail → unknown, never invented live.
   */
  probeWarehouse(): Promise<WarehouseDoorSnapshot>;
}

export interface AdminApiDeps {
  readonly tokens: TokenConfig;
  /**
   * Absent when the deployment has no `LEDGER_URL`.
   *
   * Null rather than a stub that returns success. A console that cannot reach
   * the money plane must be told so; the failure mode of pretending is an
   * operator who believes the platform is halted when it is not.
   */
  readonly ledger: LedgerOperatorCall | null;
  /**
   * Injected replica lag probe (tests). Production uses createEdgeWarehouseLagProbe
   * unless ANALYTICS_REPLICA_PROBE=off or VITEST (no sockets in unit tests).
   */
  readonly warehouseLagProbe?: WarehouseLagProbe | null;
  /** Kill-switch consume. Tests inject a stub. Unset → refuse. */
  readonly approvals?: ActionApprovalConsumer;
  /**
   * Live identity session. Production wires this. A random sid with `mfa: true`
   * in the token is not an operator. Unset in unit tests that mint their own tokens.
   */
  readonly sessionLive?: (principal: Principal) => Promise<void>;
  /** Restart file for the compliance queue. Unset keeps the queue in memory. */
  readonly complianceQueuePath?: string | undefined;
  /** Restart file for the last successful reconcile report. */
  readonly reconcileLastPath?: string | undefined;
}

export function createAdminApi(state: KillSwitchState, deps: AdminApiDeps): AdminApi {
  const snapshot = (): KillSwitchSnapshot => {
    const disabled = state.disabledModules();
    const reasons: Record<string, string> = {};
    for (const m of disabled) reasons[m] = state.reasonFor(m) ?? '';
    return { disabledModules: disabled, reasons, audit: state.auditTrail() };
  };

  const verify = async (header: string | undefined): Promise<Principal> => {
    const token = bearerToken(header ?? null);
    if (!token) throw new AuthError('An operator token is required', 'token.invalid');
    return verifyAccessToken(token, deps.tokens);
  };

  const unreachable = { status: 503, body: { error: 'This edge is not configured to reach svc-ledger', code: 'edge.ledger_unreachable' } };

  /** File-backed when a path is configured; otherwise process memory. */
  const complianceQueue = new EdgeComplianceQueue(() => process.env, { statePath: deps.complianceQueuePath });
  let lastReconcile: { status: number; body: unknown } | null = readReconcileFile(deps.reconcileLastPath);

  return {
    async authenticate(header) {
      const principal = await verify(header);
      // Order matters only for the message the operator sees; both throw.
      requireScope(principal, 'admin:write');
      requireMfa(principal);
      if (deps.sessionLive) await deps.sessionLive(principal);
      return principal;
    },

    async authenticateRead(header) {
      const principal = await verify(header);
      requireScope(principal, 'admin:read');
      if (deps.sessionLive) await deps.sessionLive(principal);
      return principal;
    },

    async authenticateTreasury(header) {
      const principal = await verify(header);
      // `admin:treasury` is interactive-only, so this enforces MFA too.
      requireScope(principal, 'admin:treasury');
      if (deps.sessionLive) await deps.sessionLive(principal);
      return principal;
    },

    async authenticateLookup(header) {
      const principal = await verify(header);
      // `admin:read` is interactive-only (refused on an API key); a lookup also needs the second factor.
      requireScope(principal, 'admin:read');
      requireMfa(principal);
      if (deps.sessionLive) await deps.sessionLive(principal);
      return principal;
    },

    read: snapshot,

    honesty(): ControlPlaneHonesty {
      // Read enforcement from the registry — never hard-code "not enforced" so a
      // future deliberate wiring of edge.gateway cannot leave this surface lying.
      const gatewayEnforcement = enforcementOf('edge.gateway');
      const gatewayEnforced = gatewayEnforcement.kind !== 'none';
      return {
        outsideTheDoor: { ...OUTSIDE_THE_DOOR },
        // MODULE_IDS order so the status payload is stable across processes.
        enforceableModules: MODULE_IDS.filter((id) => ENFORCEABLE_MODULES.has(id)),
        killState: state.durability(),
        liveKillControl: 'operator-kill-switch',
        flagEdgeGateway: {
          key: 'edge.gateway',
          enforced: gatewayEnforced,
          note: gatewayEnforced
            ? 'edge.gateway is enforced in FLAG_REGISTRY — confirm the edge process actually consults it before trusting a flag-only halt.'
            : 'edge.gateway is NOT_ENFORCED — flipping the flag does not stop the proxy. Live kill is POST /admin/kill-switches (admin:write + MFA + distinct confirmOperatorId).',
        },
        killMutateDualControl: true,
      };
    },

    async apply(body, operator) {
      /**
       * Zod's own `.message` is a JSON dump of the issue array, and
       * `control-plane.ts` puts `err.message` straight on the wire. An operator
       * refused mid-incident should read WHY in a sentence, not un-escape a
       * nested array to find it.
       */
      let input;
      try {
        input = toggleSchema.parse(body);
      } catch (err) {
        if (err instanceof z.ZodError) throw new Error(err.issues.map((i) => i.message).join('; '));
        throw err;
      }
      const ids = readApprovalIds(input);
      const approvals = deps.approvals ?? unwiredApprovalConsumer();
      const consumed = await approvals.consume(
        {
          approvalId: ids.approvalId,
          operationId: ids.operationId,
          payloadHash: edgeActionPayloadHash('edge.kill', {
            module: input.module,
            disabled: input.disabled ? 'true' : 'false',
            reason: input.reason,
          }),
          targetService: 'svc-edge',
          targetId: `kill:${input.module}`,
          expectedVersion: '1',
        },
        operator,
      );
      const confirmOperatorId = requireDualControl(operator.userId, readConfirmOperatorId({ confirmOperatorId: consumed.approverId }));

      /**
       * The audit entry is written by `state.set` before the booleans move, and
       * if that throws nothing is switched — the request fails and the platform
       * stays in the state the last recorded action left it in. A halt with no
       * record of who called it is an incident with no timeline, so the record
       * is not a side effect of the flip; the flip is a consequence of the
       * record landing. Dual-control runs first so a one-operator body never
       * lands a halt.
       */
      // Read after the approval await: two overlapping identical calls must not both see the old state.
      const before = state.isKilled(input.module as ModuleId);
      state.set(input.module as ModuleId, input.disabled, operator.userId, input.reason, confirmOperatorId);

      return { ...snapshot(), changed: before !== input.disabled, confirmOperatorId };
    },

    ledgerConfigured: () => deps.ledger !== null,

    async readFreeze(header) {
      if (!deps.ledger) return unreachable;
      return deps.ledger('/operator/freeze', 'GET', header);
    },

    async setFreeze(frozen, body, header) {
      if (!deps.ledger) return unreachable;
      // A thaw carries no reason — svc-ledger clears it, because "why it is
      // frozen" is meaningless once it is not.
      const payload = frozen ? freezeSchema.parse(body) : thawSchema.parse(body ?? {});
      readApprovalIds(payload);
      return deps.ledger(frozen ? '/operator/freeze' : '/operator/unfreeze', 'POST', header, payload);
    },

    async readReconcile() {
      if (!deps.ledger) return unreachable;
      if (!lastReconcile) {
        return {
          status: 404,
          body: {
            error: 'No reconciliation has completed through this edge, so there is no result to show.',
            code: 'edge.reconcile_never_run',
          },
        };
      }
      return lastReconcile;
    },

    async runReconcile(body, header) {
      if (!deps.ledger) return unreachable;
      const payload = reconcileSchema.parse(body ?? {});
      readApprovalIds(payload);
      const res = await deps.ledger('/operator/reconcile', 'POST', header, payload);
      if (res.status >= 200 && res.status < 300) {
        lastReconcile = { status: res.status, body: res.body };
        writeReconcileFile(deps.reconcileLastPath, lastReconcile);
      }
      return res;
    },

    async lookupTransaction(txId, header) {
      if (!deps.ledger) return unreachable;
      const id = LOOKUP_TX_ID.safeParse(txId);
      if (!id.success) return invalidLookup('A transaction id is a UUID.');
      return deps.ledger(`/operator/transactions/${id.data}`, 'GET', header);
    },

    async traceBusinessKey(businessKey, header) {
      if (!deps.ledger) return unreachable;
      const key = LOOKUP_BUSINESS_KEY.safeParse(businessKey);
      if (!key.success) return invalidLookup('A business key is 1 to 512 characters.');
      return deps.ledger(`/operator/trace?businessKey=${encodeURIComponent(key.data)}`, 'GET', header);
    },

    async readLedgerDesk(read, query, header) {
      if (!deps.ledger) return unreachable;
      const spec = LEDGER_DESK_READS[read];
      const given = query && typeof query === 'object' ? (query as Record<string, unknown>) : {};
      const params = new URLSearchParams();
      for (const key of Object.keys(given)) {
        if (!(spec.keys as readonly string[]).includes(key))
          return invalidLookup(`This ledger read takes ${spec.keys.join(', ') || 'no query'}.`);
        const value = given[key];
        if (typeof value !== 'string' || value.length > DESK_QUERY_VALUE_MAX) {
          return invalidLookup(`${key} is one value of at most ${DESK_QUERY_VALUE_MAX} characters.`);
        }
        params.set(key, value);
      }
      const search = params.toString();
      return deps.ledger(search ? `${spec.path}?${search}` : spec.path, 'GET', header);
    },

    async readAccountMetadata(accountId, header) {
      if (!deps.ledger) return unreachable;
      const id = LOOKUP_TX_ID.safeParse(accountId);
      if (!id.success) return invalidLookup('An account id is a UUID.');
      return deps.ledger(`/operator/accounts/${id.data}/metadata`, 'GET', header);
    },

    async writeAccountMetadata(write, accountId, body, header) {
      if (!deps.ledger) return unreachable;
      const id = LOOKUP_TX_ID.safeParse(accountId);
      if (!id.success) throw new InvalidControlBodyError('An account id is a UUID.');
      const payload =
        write === 'set' ? parsedControlBody(accountMetadataSetBody, body) : parsedControlBody(accountMetadataDeleteBody, body);
      return deps.ledger(`/operator/accounts/${id.data}/metadata/${write}`, 'POST', header, payload);
    },

    async authenticateControlRead(header) {
      const principal = await verify(header);
      const scopes = ['admin:treasury', 'admin:compliance'] as const;
      let sawMfa = false;
      for (const scope of scopes) {
        if (!hasScope(principal.scopes, scope)) continue;
        try {
          requireScope(principal, scope);
        } catch (err) {
          if (err instanceof AuthError && err.code === 'mfa.required') {
            sawMfa = true;
            continue;
          }
          throw err;
        }
        // Outside the scope catch: a revoked or unknown session refuses as itself, never as a missing scope.
        if (deps.sessionLive) await deps.sessionLive(principal);
        return principal;
      }
      if (sawMfa) throw new AuthError('A second factor is required', 'mfa.required');
      throw new AuthError('One of admin:treasury, admin:compliance is required', 'scope.denied');
    },

    async listReconciliationControls(header) {
      if (!deps.ledger) return unreachable;
      return deps.ledger('/operator/reconciliation/controls', 'GET', header);
    },

    async defineReconciliationControl(body, header) {
      if (!deps.ledger) return unreachable;
      const payload = parsedControlBody(defineReconciliationControlInputSchema, body);
      return deps.ledger('/operator/reconciliation/controls', 'POST', header, payload);
    },

    async updateReconciliationControl(body, header) {
      if (!deps.ledger) return unreachable;
      const payload = parsedControlBody(updateReconciliationControlInputSchema, body);
      return deps.ledger('/operator/reconciliation/controls/update', 'POST', header, payload);
    },

    async runReconciliationControl(body, header) {
      if (!deps.ledger) return unreachable;
      const payload = parsedControlBody(runReconciliationControlInputSchema, body);
      return deps.ledger('/operator/reconciliation/controls/run', 'POST', header, payload);
    },

    async listReconciliationControlRuns(body, header) {
      if (!deps.ledger) return unreachable;
      const payload = parsedControlBody(listReconciliationControlRunsInputSchema, body);
      return deps.ledger('/operator/reconciliation/controls/runs', 'POST', header, payload);
    },

    async consumeApproval(input, operator) {
      const consumer = deps.approvals ?? unwiredApprovalConsumer();
      return consumer.consume(input, operator);
    },

    opsHonesty: () =>
      edgeComplianceHonesty(process.env, {
        queueItems: complianceQueue.snapshot().items,
      }),

    complianceQueueSnapshot: () => complianceQueue.snapshot(),

    openComplianceCase: (item) => complianceQueue.open(item),

    disposeComplianceCase: (itemId, request, meta) => complianceQueue.dispose(itemId, request, meta),

    async probeWarehouse() {
      const honesty = edgeComplianceHonesty(process.env, {
        queueItems: complianceQueue.snapshot().items,
      });
      const etl = {
        etlWatermark: honesty.analytics.etlWatermark,
        etlWatermarkAt: honesty.analytics.etlWatermarkAt,
        etlNote: honesty.analytics.etlNote,
      };

      const probe = resolveDoorLagProbe(deps);
      const resolved = await resolveWarehouseReplicaConfig({
        env: process.env,
        probe,
      });

      if (resolved.status === 'refuse') {
        const surface = queryWarehouseSurface({ replicaConfigured: false, lagSeconds: null, facts: [] });
        return {
          replicaConfigured: false,
          replicaCount: 0,
          refuse: resolved.reason,
          surfaceStatus: surface.status,
          mayLabelLive: false,
          statusLine: `status=refuse reason=writer_or_bad_role live=0`,
          ...etl,
          surface,
          lagSource: 'unknown',
          lagSeconds: null,
          lagMeasuredAt: null,
        };
      }

      const surface = queryWarehouseSurface({
        replicaConfigured: resolved.replicaConfigured,
        lagSeconds: resolved.lagSeconds,
        lagMeasuredAt: resolved.lagMeasuredAt,
        lagSource: resolved.lagSource,
        facts: [],
      });
      return {
        replicaConfigured: resolved.replicaConfigured,
        replicaCount: resolved.endpoints.length,
        refuse: null,
        surfaceStatus: surface.status,
        mayLabelLive: surface.mayLabelLive,
        statusLine: warehouseSurfaceStatusLine(surface),
        ...etl,
        surface,
        lagSource: resolved.lagSource,
        lagSeconds: resolved.lagSeconds,
        lagMeasuredAt: resolved.lagMeasuredAt,
      };
    },
  };
}

function resolveDoorLagProbe(deps: AdminApiDeps): WarehouseLagProbe | null {
  if (deps.warehouseLagProbe !== undefined) return deps.warehouseLagProbe;
  if (!warehouseLagProbeEnabled(process.env)) return null;
  // Vitest must not open sockets when a leftover ANALYTICS_REPLICA_*_URL is set.
  if (process.env.VITEST === 'true') return null;
  return createEdgeWarehouseLagProbe();
}

/** Map an `AuthError` to the status an operator console can branch on. */
export function statusForAuthError(err: AuthError): number {
  switch (err.code) {
    case 'token.expired':
    case 'token.invalid':
    case 'token.malformed':
      return 401;
    case 'mfa.required':
      return 401;
    case 'scope.denied':
      return 403;
    default:
      return 401;
  }
}

/**
 * The default `LedgerOperatorCall` — an HTTP call to one of two named paths.
 *
 * Forwards the OPERATOR's own bearer token rather than a service credential, so
 * `posting_freeze.actor` is written by svc-ledger from its own verification of
 * that token. The edge cannot cause a freeze attributed to anyone but the human
 * who presented the credential, which is the property that makes the ledger's
 * audit row trustworthy rather than merely present.
 */
export function httpLedgerOperator(baseUrl: string, timeoutMs: number): LedgerOperatorCall {
  const base = baseUrl.replace(/\/$/, '');

  return async (path, method, bearer, body) => {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: bearer,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } catch (err) {
      // 502, not 500: the edge is fine, the ledger did not answer, and an
      // operator must be able to tell those apart before deciding what to do
      // next. Never a success — an unconfirmed freeze reported as done is how
      // somebody walks away from a platform that is still moving money.
      return {
        status: 502,
        body: { error: `svc-ledger did not answer: ${(err as Error).message}`, code: 'edge.ledger_unavailable' },
      };
    }
  };
}

function readReconcileFile(path: string | undefined): { status: number; body: unknown } | null {
  const file = path?.trim();
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { status?: unknown; body?: unknown };
    if (parsed.status === 200 && parsed.body && typeof parsed.body === 'object') return { status: 200, body: parsed.body };
  } catch {
    return null;
  }
  return null;
}

function writeReconcileFile(path: string | undefined, value: { status: number; body: unknown }): void {
  const file = path?.trim();
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
