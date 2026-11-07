/**
 * Approval policy rows two founders set in the console (OPS-change-control-01 CR-1, J-ops-console-09 #1).
 *
 * The deployment's owner setting (`IDENTITY_ACTION_APPROVAL_POLICIES`) stays the first source. A row two founders set in
 * the console stands in for the deployment's row of that one type. Both are read by the same reader
 * (`readApprovalPolicies`), so a console row with a blank or unreadable value is an unset row exactly as a blank owner
 * value is: the type refuses `action_approval.policy_unset` at propose, approve and apply, and nothing of it applies.
 *
 * Writing a row is `identity.approval_policy.set`, a founder-only fixed-rule type: one founder asks, a different founder
 * approves the exact four values, and the approval is spent here once, in the same transaction as the write. A row is
 * bound to the version its founders read, so a row changed since refuses `action_approval.target_mismatch`.
 *
 * Only the privileged staff changes (`CONSOLE_SETTABLE_POLICY_ACTION_TYPES`) can be set here. The ledger correction rows
 * move money and stay the deployment owner's alone: a stored row for any other type is never read.
 *
 * The approval service reads the policy synchronously on every propose, approve and consume, so this keeps the console
 * rows in memory: read at start, after every write here, and every few seconds. A failed read is logged. Once the last
 * good read is older than `staleAfterMs`, every console-settable type reads as unset (`action_approval.policy_unset`)
 * until a read succeeds again: an instance that cannot see a row another instance tightened never keeps the old one.
 */
import type { Sql } from 'postgres';
import {
  APPROVAL_POLICY_SET_ACTION_TYPE,
  CONSOLE_SETTABLE_POLICY_ACTION_TYPES,
  isConsoleSettablePolicyActionType,
  approvalPolicySetPayloadFields,
  type ActionApprovalPolicyEntry,
  type ApprovalPolicySetInput,
  type PolicyGovernedActionType,
} from '@intafaced/contracts';
import { approvalPolicyEntries, approvalPolicySource, type ApprovalPolicySource } from '../auth/action-approval-policy.js';
import { PrivilegedDualControlError, requirePrivilegedDualControl } from '../auth/privileged-dual-control.js';
import type { ActionApprovalService } from '../auth/action-approval-service.js';

type ConsoleRow = { readonly row: Record<string, string>; readonly version: number };

export class PolicyRowError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PolicyRowError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The deployment's setting with each console row standing in for its type. Pure. */
export function overlayPolicyRows(deployment: string | undefined, rows: ReadonlyMap<string, ConsoleRow>): string | undefined {
  if (rows.size === 0) return deployment;
  let base: Record<string, unknown> = {};
  if (deployment !== undefined && deployment.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(deployment);
      // An unreadable deployment value leaves every one of its rows unset; the console rows still stand for their types.
      if (isRecord(parsed)) base = parsed;
    } catch {
      base = {};
    }
  }
  const out: Record<string, unknown> = {};
  // A deployment key spelled differently from a console type (case, spaces) would make the type ambiguous; drop it.
  for (const [key, value] of Object.entries(base)) {
    if (!rows.has(key.trim().toLowerCase())) out[key] = value;
  }
  for (const [type, row] of rows) out[type] = row.row;
  return JSON.stringify(out);
}

/** Every console-settable type as an unset row: what a stale instance reads. */
const ALL_UNSET: ReadonlyMap<string, ConsoleRow> = new Map(CONSOLE_SETTABLE_POLICY_ACTION_TYPES.map((t) => [t, { row: {}, version: 0 }]));

export interface ConsolePolicyRowsOptions {
  /** How old the last good read may be before every console-settable type reads as unset. */
  readonly staleAfterMs?: number;
  readonly clock?: () => number;
  readonly warn?: (obj: Record<string, unknown>, msg: string) => void;
}

export class ConsolePolicyRows {
  private rows: ReadonlyMap<string, ConsoleRow> = new Map();
  private freshAt = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | null = null;
  readonly source: ApprovalPolicySource;
  private readonly staleAfterMs: number;
  private readonly clock: () => number;
  private readonly warn: (obj: Record<string, unknown>, msg: string) => void;

  constructor(
    private readonly sql: Sql,
    private readonly deployment: () => string | undefined,
    options: ConsolePolicyRowsOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    this.clock = options.clock ?? (() => Date.now());
    this.warn = options.warn ?? (() => undefined);
    this.source = approvalPolicySource(() => overlayPolicyRows(this.deployment(), this.current()));
  }

  /** True when the last good read is too old to judge by. */
  stale(): boolean {
    return this.clock() - this.freshAt > this.staleAfterMs;
  }

  private current(): ReadonlyMap<string, ConsoleRow> {
    return this.stale() ? ALL_UNSET : this.rows;
  }

  async refresh(): Promise<void> {
    const found = await this.sql<Array<{ action_type: string; row: unknown; version: number }>>`
      SELECT action_type, row, version FROM approval_policy_rows
    `;
    const next = new Map<string, ConsoleRow>();
    for (const r of found) {
      if (!isConsoleSettablePolicyActionType(r.action_type) || !isRecord(r.row)) continue;
      const row = Object.fromEntries(Object.entries(r.row).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
      next.set(r.action_type, { row, version: r.version });
    }
    this.rows = next;
    this.freshAt = this.clock();
  }

  start(everyMs = 5000): void {
    this.timer = setInterval(
      () =>
        void this.refresh().catch((err: unknown) =>
          this.warn(
            { err: err instanceof Error ? err.message : String(err), stale: this.stale() },
            'identity.approval_policy_rows_refresh_failed',
          ),
        ),
      everyMs,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Every governed type, set or unset, with where its row comes from and the console version to bind a change to. */
  entries(): ActionApprovalPolicyEntry[] {
    return approvalPolicyEntries(this.source).map((entry) => {
      const consoleRow = this.current().get(entry.actionType);
      return { ...entry, source: consoleRow ? 'console' : 'deployment', rowVersion: String(consoleRow?.version ?? 0) };
    });
  }

  entryOf(actionType: PolicyGovernedActionType): ActionApprovalPolicyEntry {
    return this.entries().find((e) => e.actionType === actionType)!;
  }

  /**
   * Write one type's row, spending the second founder's approval once. The approval binds the type and the four values
   * as typed; `expectedVersion` binds the row the founders read.
   */
  async set(
    approvals: Pick<ActionApprovalService, 'consume'>,
    actorId: string,
    input: ApprovalPolicySetInput,
  ): Promise<ActionApprovalPolicyEntry> {
    const fields = approvalPolicySetPayloadFields(input);
    await this.refresh();
    const current = this.rows.get(input.actionType)?.version ?? 0;
    if (String(current) !== input.expectedVersion) {
      throw new PolicyRowError('the row changed since it was read; read it again', 'action_approval.target_mismatch');
    }
    const row = {
      requiredApprovals: fields.requiredApprovals!,
      approverAudience: fields.approverAudience!,
      applier: fields.applier!,
      maxAgeSeconds: fields.maxAgeSeconds!,
    };
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`identity.approval_policy_rows:${input.actionType}`}))`;
      const [locked] = await tx<Array<{ version: number }>>`
        SELECT version FROM approval_policy_rows WHERE action_type = ${input.actionType}`;
      if ((locked?.version ?? 0) !== current) {
        throw new PolicyRowError('the row changed since it was read; read it again', 'action_approval.target_mismatch');
      }
      // Spent once, here, after the version check under the lock: a stale or repeated apply never spends it.
      let approved: { requesterId: string; approverId: string };
      try {
        approved = await requirePrivilegedDualControl(approvals, {
          approvalId: input.approvalId,
          operationId: input.operationId,
          targetId: APPROVAL_POLICY_SET_ACTION_TYPE,
          fields,
        });
      } catch (err) {
        if (err instanceof PrivilegedDualControlError) throw new PolicyRowError(err.message, err.code);
        throw err;
      }
      const version = current + 1;
      await tx`
        INSERT INTO approval_policy_rows (action_type, row, version, set_by, approved_by, approval_id)
        VALUES (${input.actionType}, ${tx.json(row)}, ${version}, ${actorId}, ${approved.approverId}, ${input.approvalId})
        ON CONFLICT (action_type) DO UPDATE SET row = EXCLUDED.row, version = EXCLUDED.version, set_by = EXCLUDED.set_by,
          approved_by = EXCLUDED.approved_by, approval_id = EXCLUDED.approval_id, set_at = now()`;
      await tx`
        INSERT INTO approval_policy_row_changes (action_type, row, version, set_by, approved_by, approval_id)
        VALUES (${input.actionType}, ${tx.json(row)}, ${version}, ${actorId}, ${approved.approverId}, ${input.approvalId})`;
    });
    await this.refresh();
    return this.entryOf(input.actionType);
  }
}
