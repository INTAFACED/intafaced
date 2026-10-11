/**
 * OPERATOR TOOLS ALREADY MOUNTED ON THE EDGE — inventory, not invention.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `apps/admin` only reached kill-switches and ledger freeze. Roughly twenty
 * genuine operator procedures were already mounted behind `/api/*` with admin
 * scopes (`bank.ops.*`, `identity.kyc.*`, `compliance.freezeIdentity`,
 * `pay.merchantState.*`, `token.mintEpoch`, academy ambassador ops) and had no
 * console surface. An operator had to craft raw tRPC against the edge.
 *
 * This catalog is the list of those procedures the console will proxy. Nothing
 * here invents a backend. If a row is wrong, the edge returns a real error —
 * never a local green success for a money or compliance mutation.
 *
 * ── Authority mapping ───────────────────────────────────────────────────────
 *
 *   · `module`   → `ADMIN_OPERATOR_TOKEN`  (admin:write / admin:read / admin:compliance)
 *   · `treasury` → `ADMIN_TREASURY_TOKEN`  (admin:treasury — money plane)
 *
 * `admin:compliance` is NOT a separate console env var: the JWT on
 * `ADMIN_OPERATOR_TOKEN` must carry `admin:compliance` (+ MFA where the service
 * requires it). A missing scope is a real 403 from the service, not a fake
 * local refuse.
 *
 * Ledger reconcile is deliberately ABSENT — svc-edge has no route for it
 * (`operator-commands.ts` keeps it simulated).
 */

export type ToolAuthority = 'module' | 'treasury';

/** These legacy forms are replaced by versioned inspection in the account console. */
export function usesAccountConsole(toolId: string): boolean {
  return ['identity.compliance.freezeIdentity', 'identity.compliance.unfreezeIdentity', 'pay.merchantState.set'].includes(toolId);
}

export type ToolKind = 'query' | 'mutation';

/** Edge module prefix under `/api/<module>/trpc/...`. */
export type EdgeModule = 'identity' | 'bank' | 'pay' | 'token' | 'academy';

export type ToolGroup = 'identity' | 'bank' | 'pay' | 'token' | 'academy';

export type FieldType = 'string' | 'uuid' | 'number' | 'boolean' | 'json' | 'enum';

export interface ToolField {
  readonly name: string;
  readonly type: FieldType;
  /** Shown next to the control. */
  readonly label: string;
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly enumValues?: readonly string[];
  /** Help under the field. */
  readonly hint?: string;
}

export interface OperatorTool {
  readonly id: string;
  readonly group: ToolGroup;
  readonly label: string;
  /** One plain sentence an operator can act on. */
  readonly summary: string;
  readonly edgeModule: EdgeModule;
  /** tRPC path as mounted, e.g. `kyc.pending` or `ops.runDueTransfers`. */
  readonly procedure: string;
  readonly kind: ToolKind;
  readonly authority: ToolAuthority;
  /** Scope the service actually checks (for the badge, not enforcement). */
  readonly scope: string;
  /**
   * True when the procedure can move or create value, freeze identity, or
   * change merchant ability to take money. The UI adds friction and never
   * pretends local state is success.
   */
  readonly consequential: boolean;
  readonly fields: readonly ToolField[];
}

export const OPERATOR_TOOLS: readonly OperatorTool[] = [
  // ── Identity / compliance ─────────────────────────────────────────────────
  {
    id: 'identity.kyc.pending',
    group: 'identity',
    label: 'KYC pending queue',
    summary: 'List KYC records waiting for an operator decision.',
    edgeModule: 'identity',
    procedure: 'kyc.pending',
    kind: 'query',
    authority: 'module',
    scope: 'admin:compliance',
    consequential: false,
    fields: [{ name: 'limit', type: 'number', label: 'Limit', placeholder: '50', hint: '1–200, optional' }],
  },
  {
    id: 'identity.kyc.approve',
    group: 'identity',
    label: 'KYC approve',
    summary: 'Approve a pending KYC record — grants custodial access at that tier. Requires MFA on the token.',
    edgeModule: 'identity',
    procedure: 'kyc.approve',
    kind: 'mutation',
    authority: 'module',
    scope: 'admin:compliance',
    consequential: true,
    fields: [
      { name: 'recordId', type: 'uuid', label: 'Record id', required: true },
      {
        name: 'expiresAt',
        type: 'string',
        label: 'Expires at (ISO, optional)',
        placeholder: '2027-01-01T00:00:00.000Z',
        hint: 'Omit or empty for no expiry',
      },
    ],
  },
  {
    id: 'identity.kyc.reject',
    group: 'identity',
    label: 'KYC reject',
    summary: 'Reject a pending KYC record. Grants nothing. Requires MFA on the token.',
    edgeModule: 'identity',
    procedure: 'kyc.reject',
    kind: 'mutation',
    authority: 'module',
    scope: 'admin:compliance',
    consequential: true,
    fields: [{ name: 'recordId', type: 'uuid', label: 'Record id', required: true }],
  },
  {
    id: 'identity.compliance.freezeIdentity',
    group: 'identity',
    label: 'Freeze identity',
    summary: 'Freeze a user: status frozen, sessions revoked, sub-accounts revoked.',
    edgeModule: 'identity',
    procedure: 'compliance.freezeIdentity',
    kind: 'mutation',
    authority: 'module',
    scope: 'admin:compliance',
    consequential: true,
    fields: [{ name: 'userId', type: 'uuid', label: 'User id', required: true }],
  },
  {
    id: 'identity.compliance.unfreezeIdentity',
    group: 'identity',
    label: 'Unfreeze identity',
    summary: 'Restore a frozen user to active. Does not re-open revoked sub-accounts.',
    edgeModule: 'identity',
    procedure: 'compliance.unfreezeIdentity',
    kind: 'mutation',
    authority: 'module',
    scope: 'admin:compliance',
    consequential: true,
    fields: [{ name: 'userId', type: 'uuid', label: 'User id', required: true }],
  },

  // ── Bank ops (admin:treasury) ──────────────────────────────────────────────
  {
    id: 'bank.ops.runDueTransfers',
    group: 'bank',
    label: 'Run due standing transfers',
    summary: 'Sweep schedules that are due. Safe to re-run; stranded claims are counted.',
    edgeModule: 'bank',
    procedure: 'ops.runDueTransfers',
    kind: 'mutation',
    authority: 'treasury',
    scope: 'admin:treasury',
    consequential: true,
    fields: [{ name: 'limit', type: 'number', label: 'Limit', placeholder: '1000' }],
  },
  {
    id: 'bank.ops.accrueInterest',
    group: 'bank',
    label: 'Accrue earn interest',
    summary: 'Pay daily interest for one pool or every pool. Idempotent per pool/date.',
    edgeModule: 'bank',
    procedure: 'ops.accrueInterest',
    kind: 'mutation',
    authority: 'treasury',
    scope: 'admin:treasury',
    consequential: true,
    fields: [
      { name: 'poolId', type: 'uuid', label: 'Pool id (optional — omit for all)' },
      { name: 'at', type: 'string', label: 'At (ISO, optional)', placeholder: '2026-08-08T00:00:00.000Z' },
    ],
  },
  {
    id: 'bank.ops.runRiskSweep',
    group: 'bank',
    label: 'Loan risk sweep',
    summary: 'Mark loans, call margin, liquidate where the ladder requires. Operator-only.',
    edgeModule: 'bank',
    procedure: 'ops.runRiskSweep',
    kind: 'mutation',
    authority: 'treasury',
    scope: 'admin:treasury',
    consequential: true,
    fields: [{ name: 'limit', type: 'number', label: 'Limit', placeholder: '1000' }],
  },
  {
    id: 'bank.ops.resumePendingLoans',
    group: 'bank',
    label: 'Resume pending loans',
    summary: 'Re-drive loans stuck between collateral lock and draw.',
    edgeModule: 'bank',
    procedure: 'ops.resumePendingLoans',
    kind: 'mutation',
    authority: 'treasury',
    scope: 'admin:treasury',
    consequential: true,
    fields: [{ name: 'limit', type: 'number', label: 'Limit', placeholder: '100' }],
  },
  {
    id: 'bank.ops.abandonPendingLoan',
    group: 'bank',
    label: 'Abandon pending loan',
    summary: 'Give up on a pending loan and release collateral back to the borrower.',
    edgeModule: 'bank',
    procedure: 'ops.abandonPendingLoan',
    kind: 'mutation',
    authority: 'treasury',
    scope: 'admin:treasury',
    consequential: true,
    fields: [{ name: 'loanId', type: 'uuid', label: 'Loan id', required: true }],
  },
  {
    id: 'bank.ops.reconcileLoanReserve',
    group: 'bank',
    label: 'Reconcile loan reserve',
    summary: 'Read reserve vs outstanding principal for a debt asset — not ledger.reconcile.',
    edgeModule: 'bank',
    procedure: 'ops.reconcileLoanReserve',
    kind: 'query',
    authority: 'treasury',
    scope: 'admin:treasury',
    consequential: false,
    fields: [{ name: 'debtAssetId', type: 'string', label: 'Debt asset id', required: true, placeholder: 'USDT' }],
  },

  // ── Pay ────────────────────────────────────────────────────────────────────
  {
    id: 'pay.merchantState.history',
    group: 'pay',
    label: 'Merchant status history',
    summary: 'Why a merchant is suspended / closed — newest first.',
    edgeModule: 'pay',
    procedure: 'merchantState.history',
    kind: 'query',
    authority: 'module',
    scope: 'admin:read',
    consequential: false,
    fields: [
      { name: 'merchantId', type: 'uuid', label: 'Merchant id', required: true },
      { name: 'limit', type: 'number', label: 'Limit', placeholder: '50' },
    ],
  },
  {
    id: 'pay.merchantState.set',
    group: 'pay',
    label: 'Set merchant status',
    summary: 'Suspend, reinstate, close, or set pending — with a recorded reason. Actor is the token subject.',
    edgeModule: 'pay',
    procedure: 'merchantState.set',
    kind: 'mutation',
    authority: 'module',
    scope: 'admin:write',
    consequential: true,
    fields: [
      { name: 'merchantId', type: 'uuid', label: 'Merchant id', required: true },
      {
        name: 'to',
        type: 'enum',
        label: 'Status',
        required: true,
        enumValues: ['pending', 'active', 'suspended', 'closed'],
      },
      { name: 'reason', type: 'string', label: 'Reason (≥ 3 chars)', required: true },
    ],
  },
  {
    id: 'pay.deposit.credit',
    group: 'pay',
    label: 'Operator deposit credit',
    summary: 'Credit a user from a rail boundary. Moves value. MFA + admin:treasury on the token.',
    edgeModule: 'pay',
    procedure: 'deposit.credit',
    kind: 'mutation',
    authority: 'treasury',
    scope: 'admin:treasury',
    consequential: true,
    fields: [
      { name: 'userId', type: 'uuid', label: 'User id', required: true },
      { name: 'assetId', type: 'string', label: 'Asset id', required: true, placeholder: 'USDT' },
      { name: 'amount', type: 'string', label: 'Amount (decimal string)', required: true, placeholder: '10.00' },
      { name: 'railId', type: 'string', label: 'Rail id', required: true },
      { name: 'railRef', type: 'string', label: 'Rail reference', required: true },
    ],
  },

  // ── Token ──────────────────────────────────────────────────────────────────
  {
    id: 'token.mintEpoch',
    group: 'token',
    label: 'Mint emission epoch',
    summary: 'Mint next epoch (or a named epoch). Refuses when EMISSIONS_ENABLED=false.',
    edgeModule: 'token',
    procedure: 'mintEpoch',
    kind: 'mutation',
    authority: 'treasury',
    scope: 'admin:treasury',
    consequential: true,
    fields: [{ name: 'epoch', type: 'number', label: 'Epoch (optional — omit for next)' }],
  },
  {
    id: 'token.distributeRevenue',
    group: 'token',
    label: 'Distribute revenue window',
    summary: 'Hand-invoked yield settlement. Amounts are typed by the operator — no houseFees auto-read.',
    edgeModule: 'token',
    procedure: 'distributeRevenue',
    kind: 'mutation',
    authority: 'treasury',
    scope: 'admin:treasury',
    consequential: true,
    fields: [
      { name: 'windowId', type: 'string', label: 'Window id', required: true },
      {
        name: 'sources',
        type: 'json',
        label: 'Sources JSON',
        required: true,
        placeholder: '[{"module":"trade","amount":"100.00"}]',
        hint: 'Array of { module, amount } — amount is a decimal string',
      },
    ],
  },

  // ── Academy ────────────────────────────────────────────────────────────────
  {
    id: 'academy.ambassadors',
    group: 'academy',
    label: 'List ambassadors',
    summary: 'Programme roster (status filter optional). No pay plane.',
    edgeModule: 'academy',
    procedure: 'ambassadors',
    kind: 'query',
    authority: 'module',
    scope: 'admin:read',
    consequential: false,
    fields: [
      {
        name: 'status',
        type: 'enum',
        label: 'Status filter',
        enumValues: ['active', 'frozen'],
        hint: 'Optional',
      },
    ],
  },
  {
    id: 'academy.appointAmbassador',
    group: 'academy',
    label: 'Appoint ambassador',
    summary: 'Appoint a user to the ambassador programme. Operator id from token.',
    edgeModule: 'academy',
    procedure: 'appointAmbassador',
    kind: 'mutation',
    authority: 'module',
    scope: 'admin:write',
    consequential: true,
    fields: [{ name: 'userId', type: 'uuid', label: 'User id', required: true }],
  },
  {
    id: 'academy.freezeAmbassador',
    group: 'academy',
    label: 'Freeze ambassador',
    summary: 'Freeze an ambassador with a recorded reason.',
    edgeModule: 'academy',
    procedure: 'freezeAmbassador',
    kind: 'mutation',
    authority: 'module',
    scope: 'admin:write',
    consequential: true,
    fields: [
      { name: 'userId', type: 'uuid', label: 'User id', required: true },
      { name: 'reason', type: 'string', label: 'Reason', required: true },
    ],
  },
  {
    id: 'academy.openResidencies',
    group: 'academy',
    label: 'Open residencies',
    summary: 'List open residency applications for operator decision.',
    edgeModule: 'academy',
    procedure: 'openResidencies',
    kind: 'query',
    authority: 'module',
    scope: 'admin:read',
    consequential: false,
    fields: [{ name: 'cohortSlug', type: 'string', label: 'Cohort slug (optional)' }],
  },
  {
    id: 'academy.decideResidency',
    group: 'academy',
    label: 'Decide residency',
    summary: 'Accept or reject an open residency application.',
    edgeModule: 'academy',
    procedure: 'decideResidency',
    kind: 'mutation',
    authority: 'module',
    scope: 'admin:write',
    consequential: true,
    fields: [
      { name: 'id', type: 'uuid', label: 'Application id', required: true },
      { name: 'decision', type: 'enum', label: 'Decision', required: true, enumValues: ['accepted', 'rejected'] },
      { name: 'note', type: 'string', label: 'Note (optional)' },
    ],
  },
  {
    id: 'academy.ambassadorPayPlane',
    group: 'academy',
    label: 'Ambassador pay plane status',
    summary: 'Always refuse-closed until owner schedule + ledger recipes. Read is honest dark.',
    edgeModule: 'academy',
    procedure: 'ambassadorPayPlane',
    kind: 'query',
    authority: 'module',
    scope: 'admin:read',
    consequential: false,
    fields: [],
  },
] as const;

export function toolById(id: string): OperatorTool | undefined {
  return OPERATOR_TOOLS.find((t) => t.id === id);
}

export const TOOL_GROUPS: readonly { id: ToolGroup; label: string }[] = [
  { id: 'identity', label: 'Identity & compliance' },
  { id: 'bank', label: 'Bank ops' },
  { id: 'pay', label: 'Pay' },
  { id: 'token', label: 'Token treasury' },
  { id: 'academy', label: 'Academy' },
];
