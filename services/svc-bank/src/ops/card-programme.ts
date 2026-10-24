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
