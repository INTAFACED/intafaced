/**
 * Direct debit mandates for the finance desk, as the partner reports them (J-bank-28 #4, BK-xfer-11).
 *
 * When the partner bank holds people's money (OWNER 226) it is the bank the scheme collects from, so the desk reads the
 * partner's own report: each mandate it knows with its state and block, each refund it made, and each collection it
 * refused, counted by its reason code. svc-bank adds only what the scheme told it of each mandate (whose it is, the
 * creditor, the reference and the asset); a mandate svc-bank never heard of shows those as null. With no partner
 * answering the answer is `{ partner: null }`, "no data". Read only, `admin:read`; no PAN, CVC, PIN or address is
 * returned. Every read writes one structured log line with the operator before anything is read, and refuses if it can't.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import { BankError } from '../errors.js';
import type { PartnerDirectDebitReport } from '../partner/partner-direct-debits.js';

type Details = Map<string, { userId: string; creditorName: string; reference: string; assetId: string }>;

export function writeMandatesReadAudit(actorUserId: string): void {
  try {
    console.info(JSON.stringify({ level: 'info', service: 'svc-bank', event: 'bank.ops.dd_mandates_read', actorUserId }));
  } catch {
    throw new BankError('The read could not be recorded, so nothing was read', 'bank.ops_audit_unavailable');
  }
}

const refundLine = z.object({
  collectionId: z.string(),
  assetId: z.string(),
  amount: z.string(),
  moveId: z.string(),
  refundedAt: z.string(),
});
const failureLine = z.object({ collectionId: z.string(), code: z.string(), at: z.string() });

export const directDebitMandatesOutput = z.object({
  partner: z
    .object({
      label: z.string(),
      asOf: z.string(),
      mandates: z.array(
        z.object({
          mandateId: z.string(),
          userId: z.string(),
          state: z.enum(['active', 'blocked']),
          blockedAt: z.string().nullable(),
          knownAt: z.string(),
          creditorName: z.string().nullable(),
          reference: z.string().nullable(),
          assetId: z.string().nullable(),
          refunds: z.array(refundLine),
          failures: z.array(failureLine),
        }),
      ),
      failuresByReason: z.array(z.object({ code: z.string(), count: z.number().int().positive() })),
      refundCount: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type DirectDebitMandatesView = z.infer<typeof directDebitMandatesOutput>;

export function directDebitMandatesView(report: PartnerDirectDebitReport | null, details: Details): DirectDebitMandatesView {
  if (!report) return { partner: null };
  const mine = <T extends { userId: string; mandateId: string }>(list: readonly T[], userId: string, mandateId: string) =>
    list.filter((x) => x.userId === userId && x.mandateId === mandateId);
  const byReason = new Map<string, number>();
  for (const f of report.failures) byReason.set(f.code, (byReason.get(f.code) ?? 0) + 1);
  return {
    partner: {
      label: report.label,
      asOf: report.asOf.toISOString(),
      mandates: report.mandates.map((m) => {
        const known = details.get(m.mandateId);
        const ours = known && known.userId === m.userId ? known : null;
        return {
          mandateId: m.mandateId,
          userId: m.userId,
          state: m.state,
          blockedAt: m.blockedAt ? m.blockedAt.toISOString() : null,
          knownAt: m.knownAt.toISOString(),
          creditorName: ours?.creditorName ?? null,
          reference: ours?.reference ?? null,
          assetId: ours?.assetId ?? null,
          refunds: mine(report.refunds, m.userId, m.mandateId).map((r) => ({
            collectionId: r.collectionId,
            assetId: r.assetId,
            amount: formatAmount(r.amount),
            moveId: r.moveId,
            refundedAt: r.refundedAt.toISOString(),
          })),
          failures: mine(report.failures, m.userId, m.mandateId).map((f) => ({
            collectionId: f.collectionId,
            code: f.code,
            at: f.at.toISOString(),
          })),
        };
      }),
      failuresByReason: [...byReason]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
      refundCount: report.refunds.length,
    },
  };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function directDebitMandatesProcedure(
  deps: () => { report: (() => PartnerDirectDebitReport) | null; details: (ids: readonly string[]) => Promise<Details> },
  guard: Guard,
) {
  return scopedProcedure('admin:read')
    .input(z.object({}).strict().optional())
    .output(directDebitMandatesOutput)
    .query(({ ctx }) =>
      guard(async () => {
        writeMandatesReadAudit(ctx.principal.userId);
        const { report, details } = deps();
        if (!report) return { partner: null };
        const read = report();
        return directDebitMandatesView(read, await details([...new Set(read.mandates.map((m) => m.mandateId))]));
      }),
    );
}
