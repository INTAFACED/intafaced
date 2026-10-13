/**
 * G-reporting (PTX-M14-R03–R07). NAV / SFTP / regulator export.
 * Completeness refuses if required IDs are missing. Never invent cost basis.
 * B5 missing-lot refuse stays. G-statements-happy is not recut. svc-trade is not.
 */

import { z } from 'zod';
import { STATEMENT_LOTS_MISSING } from './statement-pnl.js';
import { refuseInventedCostBasis } from './statement-pnl-book.js';

export const REPORT_KINDS = ['nav', 'sftp', 'regulator'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type ReportRefuseReason = 'completeness_ids_missing' | 'cost_basis_invented' | typeof STATEMENT_LOTS_MISSING;

export type ReportExportRefusal = {
  readonly ok: false;
  readonly reason: ReportRefuseReason;
  readonly kind: ReportKind;
  readonly complete: false;
  readonly missing: readonly string[];
  readonly included: readonly string[];
  readonly detail: string;
};

export type ReportExportOk = {
  readonly ok: true;
  readonly kind: ReportKind;
  readonly complete: boolean;
  readonly included: readonly string[];
};

export type ReportExportResult = ReportExportOk | ReportExportRefusal;

const REQUIRED: Readonly<Record<ReportKind, readonly string[]>> = {
  nav: ['ownerId', 'reportingPeriod'],
  sftp: ['ownerId', 'legalEntityId', 'reportingPeriod'],
  regulator: ['ownerId', 'legalEntityId', 'regulatorId', 'reportingPeriod'],
};

function text(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const value = raw.trim();
  return value.length === 0 ? null : value;
}

function refuse(
  kind: ReportKind,
  reason: ReportRefuseReason,
  missing: readonly string[],
  included: readonly string[],
  detail: string,
): ReportExportRefusal {
  return { ok: false, reason, kind, complete: false, missing, included, detail };
}

export const reportExportInputSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  complete: z.boolean().optional(),
  ownerId: z.string().optional(),
  accountId: z.string().optional(),
  legalEntityId: z.string().optional(),
  regulatorId: z.string().optional(),
  reportingPeriod: z.string().optional(),
  lotIds: z.array(z.string()).optional(),
  inventCostBasis: z.boolean().optional(),
  lotsFromHistory: z.boolean().optional(),
  inventFifoFromHistory: z.boolean().optional(),
  costBasis: z.string().nullable().optional(),
});

function presentIds(input: {
  readonly ownerId?: string | null;
  readonly accountId?: string | null;
  readonly legalEntityId?: string | null;
  readonly regulatorId?: string | null;
  readonly reportingPeriod?: string | null;
  readonly lotIds?: readonly string[];
}): string[] {
  const included: string[] = [];
  if (text(input.ownerId)) included.push('ownerId');
  if (text(input.accountId)) included.push('accountId');
  if (text(input.legalEntityId)) included.push('legalEntityId');
  if (text(input.regulatorId)) included.push('regulatorId');
  if (text(input.reportingPeriod)) included.push('reportingPeriod');
  if (input.lotIds && input.lotIds.some((id) => text(id))) included.push('lotIds');
  return included;
}

export function refuseIncompleteReportExport(input: z.infer<typeof reportExportInputSchema>): ReportExportResult {
  const owner = {
    ownerType: 'user' as const,
    ownerId: text(input.ownerId) ?? 'unset',
    reportingAssetId: 'unset',
  };
  const invented = refuseInventedCostBasis(owner, {
    inventFifoFromHistory: input.inventFifoFromHistory === true || input.inventCostBasis === true,
    lotsFromHistory: input.lotsFromHistory === true,
    costBasis: input.costBasis,
  });
  const included = presentIds(input);
  if (invented) {
    return refuse(input.kind, 'cost_basis_invented', [], included, 'export will not invent cost basis from history or a bare number');
  }

  const missing = REQUIRED[input.kind].filter((id) => {
    const value = input[id as keyof typeof input];
    return typeof value !== 'string' || !text(value);
  });

  // A regulator export is a ship. Missing owner, entity, regulator, period, or
  // lot ids refuse even when `complete` is not exactly true — `ok` is permission.
  const idsRequired = input.complete === true || input.kind === 'regulator';
  const claim = input.complete === true ? `complete ${input.kind}` : input.kind;

  if (idsRequired && missing.length > 0) {
    return refuse(input.kind, 'completeness_ids_missing', missing, included, `${claim} export refuses — missing ${missing.join(',')}`);
  }

  if (idsRequired && (!input.lotIds || input.lotIds.every((id) => !text(id)))) {
    return refuse(
      input.kind,
      STATEMENT_LOTS_MISSING,
      ['lotIds'],
      included,
      `${input.complete === true ? 'complete' : input.kind} export refuses — lots are missing, cost basis is not invented`,
    );
  }

  return {
    ok: true,
    kind: input.kind,
    complete: input.complete === true,
    included,
  };
}

export function handleReportExport(body: unknown): ReportExportResult {
  return refuseIncompleteReportExport(reportExportInputSchema.parse(body));
}
