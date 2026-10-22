/**
 * Purpose, source of funds and the reference of a global send (BK-xfer-01).
 *
 * The three ride in the send's `compliance` map as `purpose`, `sourceOfFunds` and `reference`, so they are bound by the same
 * fresh approval and compared by the same idempotency check as every other compliance field. What each one needs is the
 * owner's table (`BANK_SEND_FIELD_RULES_JSON`): the longest reference a rail and country allow, the currencies that need a
 * purpose, and the amount above which a source of funds is needed. Nothing here has a default: all three keys must be present
 * (an explicit empty list means none), or the table is unreadable. A blank or unreadable table
 * refuses `bank.send_field_rules_unset`; a reference with no rule for its rail refuses `bank.reference_rules_unset`.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { z } from 'zod';

const rulesShape = z
  .object({
    reference: z.array(
      z.object({
        deliveryMethod: z.string().trim().min(1).max(64),
        country: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/)
          .optional(),
        maxLength: z.number().int().min(1).max(200),
      }),
    ),
    purposeRequired: z.array(z.string().trim().min(2).max(8)),
    sourceOfFunds: z.array(z.object({ asset: z.string().trim().min(2).max(16), threshold: z.string().regex(/^\d+(\.\d{1,18})?$/) })),
  })
  .strict();

export interface SendFieldRules {
  readonly reference: readonly { deliveryMethod: string; country: string | null; maxLength: number }[];
  readonly purposeRequired: readonly string[];
  readonly sourceOfFunds: readonly { asset: string; threshold: string }[];
}

/** The owner's table, or null when it is blank, not JSON or not in shape. */
export function parseSendFieldRules(json: string | undefined): SendFieldRules | null {
  if (!json?.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = rulesShape.safeParse(raw);
  if (!parsed.success) return null;
  // A threshold the ledger cannot hold is an unreadable table, not a crash on the first send.
  try {
    for (const rule of parsed.data.sourceOfFunds) parseAmount(rule.threshold);
  } catch {
    return null;
  }
  return {
    reference: parsed.data.reference.map((rule) => ({
      deliveryMethod: rule.deliveryMethod,
      country: rule.country ? rule.country.toUpperCase() : null,
      maxLength: rule.maxLength,
    })),
    purposeRequired: parsed.data.purposeRequired.map((code) => code.toUpperCase()),
    sourceOfFunds: parsed.data.sourceOfFunds.map((rule) => ({ asset: rule.asset.toUpperCase(), threshold: rule.threshold })),
  };
}

export type SendFieldRefusal =
  | { code: 'bank.send_field_rules_unset' }
  | { code: 'bank.reference_rules_unset' }
  | { code: 'bank.reference_too_long'; maxLength: number }
  | { code: 'bank.send_purpose_required' }
  | { code: 'bank.source_of_funds_required' };

export interface SendFieldContext {
  readonly assetId: string;
  readonly amount: string;
  readonly toCurrency: string;
  readonly country: string;
  readonly deliveryMethod: string;
  readonly compliance: Readonly<Record<string, string>>;
}

/** The first thing wrong with the three fields, or null when they meet the owner's table. */
export function checkSendFields(rules: SendFieldRules | null, ctx: SendFieldContext): SendFieldRefusal | null {
  if (!rules) return { code: 'bank.send_field_rules_unset' };

  const reference = ctx.compliance.reference?.trim() ?? '';
  if (reference) {
    const rule =
      rules.reference.find((item) => item.deliveryMethod === ctx.deliveryMethod && item.country === ctx.country) ??
      rules.reference.find((item) => item.deliveryMethod === ctx.deliveryMethod && item.country === null);
    if (!rule) return { code: 'bank.reference_rules_unset' };
    if (reference.length > rule.maxLength) return { code: 'bank.reference_too_long', maxLength: rule.maxLength };
  }

  if (rules.purposeRequired.includes(ctx.toCurrency) && !ctx.compliance.purpose?.trim()) return { code: 'bank.send_purpose_required' };

  const limit = rules.sourceOfFunds.find((item) => item.asset === ctx.assetId.toUpperCase());
  if (limit && !ctx.compliance.sourceOfFunds?.trim() && parseAmount(ctx.amount) > parseAmount(limit.threshold)) {
    return { code: 'bank.source_of_funds_required' };
  }
  return null;
}
