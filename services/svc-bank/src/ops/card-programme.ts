/**
 * Card programme read and the operator freeze.
 *
 * Counts and daily volume come from `cards` and `card_authorizations`.
 * Volume is an exact decimal string per asset. `simulated` is the wired
 * issuer's own flag. An operator freeze needs treasury, MFA (the scope
 * requires it), a reason, and an identity approval bound to this card and
 * this status, consumed in the same transaction. A replay returns the first result.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import { NOT_KNOWN, partnerTermsView } from '../cards/partner-terms.js';

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SPAN_DAYS = 92;

export interface CardProgrammeDay {
  day: string;
  volume: Array<{ assetId: string; amount: string }>;
  declines: number;
}

export interface CardProgramme {
  simulated: boolean;
  issued: number;
  active: number;
  frozen: number;
  days: CardProgrammeDay[];
}

export function assertProgrammeSpan(from: string | undefined, to: string | undefined): { from: Date; to: Date } {
  const start = from ? new Date(from) : new Date(NaN);
  const end = to ? new Date(to) : new Date(NaN);
  if (!from || !to || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
    throw new BankError(
      'Card programme needs a from and a to, and to must be after from (bank.card_programme_span_unset)',
      'bank.card_programme_span_unset',
    );
  }
  if (end.getTime() - start.getTime() > MAX_SPAN_DAYS * DAY_MS) {
    throw new BankError(
      'Card programme span is longer than 92 days (bank.card_programme_span_too_long)',
      'bank.card_programme_span_too_long',
    );
  }
  return { from: start, to: end };
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export async function readCardProgramme(bank: BankServices, from: Date, to: Date): Promise<CardProgramme> {
  const counts = await bank.cards.countProgramme();
  const rows = await bank.cards.authorisationDays(from, to);
  const byDay = new Map<string, { volume: Map<string, Amount>; declines: number }>();
  for (let cursor = dayStart(utcDay(from)); cursor.getTime() < to.getTime(); cursor = new Date(cursor.getTime() + DAY_MS)) {
    byDay.set(utcDay(cursor), { volume: new Map(), declines: 0 });
  }
  for (const row of rows) {
    const bucket = byDay.get(row.day);
    if (!bucket) continue;
    if (row.decision === 'approved') {
      bucket.volume.set(row.assetId, (bucket.volume.get(row.assetId) ?? 0n) + row.amount);
    } else if (row.decision === 'declined') {
      bucket.declines += row.count;
    }
  }
  return {
    simulated: bank.cards.programme().simulated,
    issued: counts.issued,
    active: counts.active,
    frozen: counts.frozen,
    days: [...byDay.entries()].map(([day, bucket]) => ({
      day,
      volume: [...bucket.volume.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([assetId, amount]) => ({ assetId, amount: formatAmount(amount) })),
      declines: bucket.declines,
    })),
  };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function cardProgrammeProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(z.object({ from: z.string().optional(), to: z.string().optional() }))
    .output(
      z.object({
        simulated: z.boolean(),
        issued: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        frozen: z.number().int().nonnegative(),
        days: z.array(
          z.object({
            day: z.string(),
            volume: z.array(z.object({ assetId: z.string(), amount: amountString })),
            declines: z.number().int().nonnegative(),
          }),
        ),
      }),
    )
    .query(({ input }) =>
      guard(async () => {
        const span = assertProgrammeSpan(input.from, input.to);
        return readCardProgramme(bank, span.from, span.to);
      }),
    );
}

/**
 * THE CARD PARTNER'S TERMS, AS AN OPERATOR READS THEM (J-bank-26 #6, J-bank-27 #4; CUSTODY-DELTA §1.3).
 *
 * Who funds the programme, any reserve the partner requires, who bears a lost chargeback or a fraud loss, and how the
 * partner spends a cardholder's crypto. Each is the partner's own answer, from the issuer adapter, or the words "not known".
 * A reserve never reads 0 for an unknown, and a loss is never assumed to be the partner's. `test` is true on the TEST
 * partner card adapter. Reads only.
 */
export function cardPartnerTermsProcedure(bank: BankServices, guard: Guard) {
  const words = z.string().min(1);
  return scopedProcedure('admin:read')
    .output(
      z.object({
        test: z.boolean(),
        label: z.string(),
        custodyMode: words,
        funder: words,
        reserve: words,
        reserveStatus: z.enum(['reported', 'not_known']),
        lossLiability: words,
        lossLiabilityStatus: z.enum(['reported', 'not_known']),
      }),
    )
    .query(() =>
      guard(async () => {
        const view = partnerTermsView(bank.cards.partnerTerms());
        return { ...view, label: view.test ? 'TEST partner card adapter' : bank.cards.programme().displayName };
      }),
    );
}

const offerState = z.enum(['offered', 'not_offered', 'not_known']);
const fundingKind = z.enum(['fund', 'defund', 'auto_reload']);
const fundingRequestOutput = z.object({
  clientRequestId: z.string(),
  kind: fundingKind,
  assetId: z.string(),
  amount: amountString,
  threshold: amountString.nullable(),
  partnerRef: z.string(),
  createdAt: z.string(),
});

/**
 * PROGRAMME FUNDING, AS AN OPERATOR READS IT (J-bank-26 #6; BK-cops-05). The settlement reconciliation per funding asset:
 * the app's open holds and captures beside the partner's own figure, the signed difference and "matches", a break, or "not
 * known" when the partner has not reported; the stablecoin conversion of each into the funding asset the partner reports;
 * and fund, defund and auto reload, each offered, not offered by the partner, or not known. Reads only.
 */
export function cardProgrammeFundingProcedure(bank: BankServices, guard: Guard) {
  // Each unknown is the words "not known" on the wire, as `cardPartnerTerms` sends them, so no surface can print a dash,
  // a blank or a 0 in its place.
  const known = z.union([amountString, z.literal(NOT_KNOWN)]);
  const signed = z.union([z.string().regex(/^-?\d+(\.\d{1,18})?$/), z.literal(NOT_KNOWN)]);
  return scopedProcedure('admin:read')
    .output(
      z.object({
        test: z.boolean(),
        fundingAssetId: z.string().min(1),
        offers: z.object({ fund: offerState, defund: offerState, auto_reload: offerState }),
        rows: z.array(
          z.object({
            assetId: z.string(),
            appHeld: amountString,
            appCaptured: amountString,
            appFigure: amountString,
            partnerFigure: known,
            difference: signed,
            status: z.enum(['matches', 'break', 'not_known']),
            fundingRate: known,
            fundingRateAsOf: z.string().min(1),
            appFigureInFunding: known,
          }),
        ),
        requests: z.array(fundingRequestOutput),
      }),
    )
    .query(() =>
      guard(async () => {
        const v = await bank.cards.programmeFunding();
        return {
          ...v,
          fundingAssetId: v.fundingAssetId ?? NOT_KNOWN,
          rows: v.rows.map((r) => ({
            ...r,
            partnerFigure: r.partnerFigure ?? NOT_KNOWN,
            difference: r.difference ?? NOT_KNOWN,
            fundingRate: r.fundingRate ?? NOT_KNOWN,
            fundingRateAsOf: r.fundingRateAsOf ?? NOT_KNOWN,
            appFigureInFunding: r.appFigureInFunding ?? NOT_KNOWN,
          })),
        };
      }),
    );
}

/**
 * One programme funding instruction to the card partner (J-bank-26 #6): fund, defund, or set auto reload, where the
 * partner offers it. Treasury, MFA, a reason, and a second founder's approval bound to the kind, amount and threshold,
 * consumed only after the partner's offer is checked. A replay of the same client request id returns the first answer.
 */
export function requestCardProgrammeFundingProcedure(
  bank: BankServices,
  consumeOpsApproval: (
    input: { approvalId?: string | null; operationId?: string | null },
    actionType: string,
    fields: Record<string, string>,
  ) => Promise<string>,
  guard: Guard,
) {
  return scopedProcedure('admin:treasury')
    .input(
      z.object({
        kind: fundingKind,
        amount: z.string(),
        threshold: z.string().nullable(),
        reason: z.string(),
        approvalId: z.string().max(128).nullish(),
        operationId: z.string().max(128).nullish(),
        clientRequestId: z.string().min(1),
      }),
    )
    .output(fundingRequestOutput)
    .mutation(({ input }) =>
      guard(() =>
        bank.cards.requestProgrammeFunding({
          kind: input.kind,
          amount: input.amount,
          threshold: input.threshold,
          reason: input.reason,
          clientRequestId: input.clientRequestId,
          consume: () =>
            consumeOpsApproval(input, 'bank.ops.requestCardProgrammeFunding', {
              kind: input.kind,
              amount: input.amount,
              threshold: input.threshold ?? '',
            }).then(() => undefined),
        }),
      ),
    );
}

export function setCardStatusProcedure(
  bank: BankServices,
  consumeOpsApproval: (
    input: { approvalId?: string | null; operationId?: string | null },
    actionType: string,
    fields: Record<string, string>,
  ) => Promise<string>,
  guard: Guard,
) {
  return scopedProcedure('admin:treasury')
    .input(
      z.object({
        cardId: z.string().guid(),
        status: z.enum(['frozen', 'active']),
        reason: z.string(),
        approvalId: z.string().max(128).nullish(),
        operationId: z.string().max(128).nullish(),
        clientRequestId: z.string().min(1),
      }),
    )
    .output(z.object({ cardId: z.string().guid(), status: z.enum(['frozen', 'active']), frozenBy: z.enum(['operator']).nullable() }))
    .mutation(({ input }) =>
      guard(() =>
        bank.cards.setOperatorStatus({
          cardId: input.cardId,
          status: input.status,
          reason: input.reason,
          clientRequestId: input.clientRequestId,
          consume: () =>
            consumeOpsApproval(input, 'bank.ops.setCardStatus', { cardId: input.cardId, status: input.status }).then(() => undefined),
        }),
      ),
    );
}
