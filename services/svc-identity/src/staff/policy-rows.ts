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
 * The approval service reads the policy synchronously on every propose, approve and consume, so this keeps the console
 * rows in memory: read at start, after every write here, and every few seconds (a write on another instance reaches this
 * one within that interval).
 */
import type { Sql } from 'postgres';
import {
  APPROVAL_POLICY_SET_ACTION_TYPE,
  POLICY_GOVERNED_ACTION_TYPES,
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

export class ConsolePolicyRows {
  private rows: ReadonlyMap<string, ConsoleRow> = new Map();
  private timer: NodeJS.Timeout | null = null;
  readonly source: ApprovalPolicySource;

  constructor(
    private readonly sql: Sql,
    private readonly deployment: () => string | undefined,
  ) {
    this.source = approvalPolicySource(() => overlayPolicyRows(this.deployment(), this.rows));
  }

  async refresh(): Promise<void> {
    const found = await this.sql<Array<{ action_type: string; row: unknown; version: number }>>`
      SELECT action_type, row, version FROM approval_policy_rows
    `;
    const next = new Map<string, ConsoleRow>();
    for (const r of found) {
      if (!(POLICY_GOVERNED_ACTION_TYPES as readonly string[]).includes(r.action_type) || !isRecord(r.row)) continue;
      const row = Object.fromEntries(Object.entries(r.row).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
      next.set(r.action_type, { row, version: r.version });
    }
    this.rows = next;
  }

  start(everyMs = 5000): void {
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Every governed type, set or unset, with where its row comes from and the console version to bind a change to. */
  entries(): ActionApprovalPolicyEntry[] {
    return approvalPolicyEntries(this.source).map((entry) => {
      const consoleRow = this.rows.get(entry.actionType);
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
