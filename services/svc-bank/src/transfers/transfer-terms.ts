/**
 * Publishing personal transfer terms (PP-send-request-07, governed writer).
 *
 * `bank.personal_transfer_terms` had no writer, and a send with no row for its
 * asset went through uncapped. Sends now refuse `bank.personal_transfer_terms_unset`
 * while the row is blank, and this is the one way a row is written: compliance
 * with a second person, an identity approval bound to every figure, consumed only
 * after the figures pass the checks, so a wrong form never spends the second
 * person. Nothing is defaulted. Publishing again replaces the row for that asset;
 * a posted transfer is never edited, and the daily window counts what was already
 * sent today against the new figure.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { BankError } from '../errors.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');

export const PUBLISH_TRANSFER_TERMS_ACTION = 'bank.ops.publishTransferTerms';

const termsInput = z.object({
  assetId: z.string().trim().min(1).max(16),
  perTransferLimit: amountString,
  dailyLimit: amountString,
  fee: amountString,
});

export type PublishTransferTermsInput = z.infer<typeof termsInput>;

export interface PublishedTransferTerms {
  readonly assetId: string;
  readonly perTransferLimit: string;
  readonly dailyLimit: string;
  readonly fee: string;
  readonly publishedAt: string;
}

/** The fields the approval is bound to, in canonical decimal form. The client hashes the same strings. */
export function publishTransferTermsFields(input: PublishTransferTermsInput): Record<string, string> {
  return {
    assetId: input.assetId.trim(),
    perTransferLimit: formatAmount(parseAmount(input.perTransferLimit)),
    dailyLimit: formatAmount(parseAmount(input.dailyLimit)),
    fee: formatAmount(parseAmount(input.fee)),
  };
}

/** Refuses figures the send path could not honour, before any approval is spent. */
export function assertTransferTerms(per: Amount, daily: Amount): void {
  if (per <= 0n || daily <= 0n) {
    throw new BankError(
      'Per-transfer and daily limits must be above zero (bank.personal_transfer_terms_invalid)',
      'bank.personal_transfer_terms_invalid',
    );
  }
  if (daily < per) {
    throw new BankError(
      `The daily limit ${formatAmount(daily)} is below the per-transfer limit ${formatAmount(per)} (bank.personal_transfer_terms_invalid)`,
      'bank.personal_transfer_terms_invalid',
    );
  }
}

export async function publishTransferTerms(
  sql: Sql,
  assetId: string,
  terms: { per: Amount; daily: Amount; fee: Amount },
): Promise<PublishedTransferTerms> {
  const rows = await sql<Array<{ asset_id: string; per_transfer_limit: string; daily_limit: string; fee: string; published_at: Date }>>`
    INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee, published_at)
    VALUES (${assetId}, ${formatAmount(terms.per)}::numeric, ${formatAmount(terms.daily)}::numeric, ${formatAmount(terms.fee)}::numeric, now())
    ON CONFLICT (asset_id) DO UPDATE
      SET per_transfer_limit = EXCLUDED.per_transfer_limit,
          daily_limit = EXCLUDED.daily_limit,
          fee = EXCLUDED.fee,
          published_at = EXCLUDED.published_at
    RETURNING asset_id, per_transfer_limit::text, daily_limit::text, fee::text, published_at
  `;
  const row = rows[0];
  if (!row) throw new BankError(`Terms for ${assetId} were not written`, 'bank.personal_transfer_terms_unset');
  return {
    assetId: row.asset_id,
    perTransferLimit: formatAmount(parseAmount(row.per_transfer_limit)),
    dailyLimit: formatAmount(parseAmount(row.daily_limit)),
    fee: formatAmount(parseAmount(row.fee)),
    publishedAt: row.published_at.toISOString(),
  };
}

export function publishTransferTermsProcedure(
  sql: () => Sql,
  consumeOpsApproval: (
    input: { approvalId?: string | null; operationId?: string | null },
    actionType: string,
    fields: Record<string, string>,
  ) => Promise<string>,
  guard: Guard,
) {
  return scopedProcedure('admin:compliance')
    .input(
      termsInput.extend({
        approvalId: z.string().max(128).nullish(),
        operationId: z.string().max(128).nullish(),
      }),
    )
    .output(
      z.object({
        assetId: z.string(),
        perTransferLimit: amountString,
        dailyLimit: amountString,
        fee: amountString,
        publishedAt: z.string(),
        approvedBy: z.string(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => {
        const per = parseAmount(input.perTransferLimit);
        const daily = parseAmount(input.dailyLimit);
        const fee = parseAmount(input.fee);
        // Checked before the approval is consumed, so a wrong form does not spend the second person.
        assertTransferTerms(per, daily);
        const approvedBy = await consumeOpsApproval(input, PUBLISH_TRANSFER_TERMS_ACTION, publishTransferTermsFields(input));
        const published = await publishTransferTerms(sql(), input.assetId.trim(), { per, daily, fee });
        return { ...published, approvedBy };
      }),
    );
}
