import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { BankServices } from '../bank-service.js';
import { amountString } from '../router/shared.js';
import { WEEKDAYS, type PayYourselfMove, type PayYourselfRule, type PayYourselfSummary } from './pay-yourself-service.js';
import { payInCreditView } from './test-pay-in.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * `bank.payYourself.*` (J-bank-31): pay yourself from your trading. A move is one venue withdrawal the person signs once
 * in their own wallet (through svc-trade's venue door), to their own partner account; these procedures read what their
 * trading realised as the venue reports it and the partner's pay-in, record a move once the venue took it, and keep the
 * weekly rule. Nothing here posts to the ledger or moves money: only the person's signature sends a withdrawal.
 */

const moveView = z.object({
  id: z.string(),
  moveKey: z.string(),
  source: z.enum(['manual', 'rule']),
  assetId: z.string(),
  amount: z.string(),
  status: z.enum(['prepared', 'sent']),
  owner: z.string().nullable(),
  venueNonce: z.string().nullable(),
  windowFrom: z.string().nullable(),
  windowTo: z.string().nullable(),
  preparedAt: z.string(),
  sentAt: z.string().nullable(),
});
const ruleView = z.object({
  id: z.string(),
  weekday: z.enum(WEEKDAYS),
  assetId: z.string(),
  cap: z.string(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string(),
});
const creditView = z.object({
  key: z.string(),
  txHash: z.string(),
  amount: z.string(),
  status: z.enum(['pending', 'available']),
  held: z.boolean(),
  confirmations: z.number().int(),
  required: z.number().int(),
  seenAt: z.string(),
  availableAt: z.string().nullable(),
});
export const payYourselfSummaryView = z.object({
  payIn: z.union([
    z.object({
      label: z.literal('TEST'),
      chainId: z.number().int(),
      token: z.string(),
      tokenDecimals: z.number().int(),
      address: z.string(),
      asset: z.string(),
      confirmations: z.number().int(),
    }),
    z.object({ unset: z.string() }),
  ]),
  partnerFee: z.string().nullable(),
  realised: z.union([
    z.object({ since: z.string(), asOf: z.string(), amount: z.string(), owner: z.string().nullable() }),
    z.object({ unread: z.string() }),
  ]),
  moves: z.array(moveView),
  credits: z.array(creditView),
  rule: ruleView.nullable(),
});

function moveOut(m: PayYourselfMove): z.infer<typeof moveView> {
  return {
    id: m.id,
    moveKey: m.moveKey,
    source: m.source,
    assetId: m.assetId,
    amount: formatAmount(m.amount),
    status: m.status,
    owner: m.owner,
    venueNonce: m.venueNonce,
    windowFrom: m.windowFrom?.toISOString() ?? null,
    windowTo: m.windowTo?.toISOString() ?? null,
    preparedAt: m.preparedAt.toISOString(),
    sentAt: m.sentAt?.toISOString() ?? null,
  };
}

function ruleOut(r: PayYourselfRule): z.infer<typeof ruleView> {
  return {
    id: r.id,
    weekday: r.weekday,
    assetId: r.assetId,
    cap: formatAmount(r.cap),
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    nextRunAt: r.nextRunAt.toISOString(),
  };
}

export function summaryOut(s: PayYourselfSummary): z.infer<typeof payYourselfSummaryView> {
  return {
    payIn: s.payIn,
    partnerFee: s.partnerFee === null ? null : formatAmount(s.partnerFee),
    realised:
      'unread' in s.realised
        ? { unread: s.realised.unread }
        : {
            since: s.realised.since.toISOString(),
            asOf: s.realised.asOf.toISOString(),
            amount: formatAmount(s.realised.amount),
            owner: s.realised.owner,
          },
    moves: s.moves.map(moveOut),
    credits: s.credits.map(payInCreditView),
    rule: s.rule ? ruleOut(s.rule) : null,
  };
}

export function createPayYourselfRouter(bank: Pick<BankServices, 'payYourself'>, guard: Guard) {
  return router({
    summary: scopedProcedure('bank:read', { module: 'bank' })
      .output(payYourselfSummaryView)
      .query(({ ctx }) => guard(async () => summaryOut(await bank.payYourself.summary(ctx.principal.userId)))),
    /** A move the person signed and the venue took, recorded once by its key and the venue's nonce. */
    record: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            moveKey: z.string().min(8).max(160),
            owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            nonce: z.string().min(1).max(80),
            amount: amountString,
          })
          .strict(),
      )
      .output(moveView)
      .mutation(({ ctx, input }) =>
        guard(async () =>
          moveOut(
            await bank.payYourself.record(ctx.principal.userId, {
              moveKey: input.moveKey,
              owner: input.owner,
              nonce: input.nonce,
              amount: parseAmount(input.amount),
            }),
          ),
        ),
      ),
    /** The person's weekly rule: on `weekday`, the week's realised profit, up to `cap`, prepared for one signature. */
    setRule: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ weekday: z.enum(WEEKDAYS), cap: amountString }).strict())
      .output(ruleView)
      .mutation(({ ctx, input }) =>
        guard(async () =>
          ruleOut(await bank.payYourself.setRule(ctx.principal.userId, { weekday: input.weekday, cap: parseAmount(input.cap) })),
        ),
      ),
  });
}
