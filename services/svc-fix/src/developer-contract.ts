/**
 * G-developer remaining (PTX-M19-R02, PTX-M19-R04, PTX-M19-R05, PTX-M05-R08).
 * IN svc-fix. Changelog/deprecation is contractual — do not break silently.
 * Decimal handling explicit. packages/contracts OpenAPI mill (#3753) is not recut.
 * matching-port, command, and QFJ are not recut.
 */

import { z } from 'zod';
import { decimalString } from './command.js';

export const DEVELOPER_KINDS = ['changelog', 'decimal'] as const;
export type DeveloperKind = (typeof DEVELOPER_KINDS)[number];

export const DEPRECATION_UNSET = 'fix.developer.deprecation_unset' as const;
export const SILENT_BREAK = 'fix.developer.silent_break' as const;
export const IEEE_MONEY = 'fix.developer.ieee_money' as const;
export const DECIMAL_UNSET = 'fix.developer.decimal_unset' as const;

export type DeveloperRefuseReason = typeof DEPRECATION_UNSET | typeof SILENT_BREAK | typeof IEEE_MONEY | typeof DECIMAL_UNSET;

export type DeveloperRefusal = {
  readonly ok: false;
  readonly reason: DeveloperRefuseReason;
  readonly kind: DeveloperKind;
  readonly posted: false;
  readonly detail: string;
};

export type DeveloperOk = {
  readonly ok: true;
  readonly kind: DeveloperKind;
  readonly posted: false;
  readonly changelog: string | null;
  readonly deprecated: readonly string[];
  readonly qty: string | null;
  readonly price: string | null;
};

export type DeveloperResult = DeveloperOk | DeveloperRefusal;

export const developerInputSchema = z.object({
  kind: z.enum(DEVELOPER_KINDS),
  previousTags: z.array(z.string()).optional(),
  nextTags: z.array(z.string()).optional(),
  deprecated: z.array(z.string()).optional(),
  changelog: z.string().optional(),
  qty: z.string().optional(),
  price: z.string().nullable().optional(),
  ieee: z.boolean().optional(),
});

function text(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const value = raw.trim();
  return value.length === 0 ? null : value;
}

function namedSet(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter((v) => v.length > 0))];
}

function refuse(kind: DeveloperKind, reason: DeveloperRefuseReason, detail: string): DeveloperRefusal {
  return { ok: false, reason, kind, posted: false, detail };
}

function refuseIeeeOrUnset(kind: DeveloperKind, input: z.infer<typeof developerInputSchema>): DeveloperRefusal | null {
  if (input.ieee === true) {
    return refuse(kind, IEEE_MONEY, 'FIX money is a decimal string — IEEE / JS number refuses');
  }
  if (input.qty !== undefined && !decimalString.safeParse(input.qty).success) {
    return refuse(kind, DECIMAL_UNSET, 'FIX qty must be an explicit decimal string');
  }
  if (input.price !== undefined && input.price !== null && !decimalString.safeParse(input.price).success) {
    return refuse(kind, DECIMAL_UNSET, 'FIX price must be an explicit decimal string');
  }
  return null;
}

function refuseSilentTagBreak(kind: DeveloperKind, input: z.infer<typeof developerInputSchema>): DeveloperRefusal | null {
  const previous = namedSet(input.previousTags);
  const next = new Set(namedSet(input.nextTags));
  const removed = previous.filter((tag) => !next.has(tag));
  if (removed.length === 0) return null;
  const deprecated = new Set(namedSet(input.deprecated));
  const undeclared = removed.filter((tag) => !deprecated.has(tag));
  if (undeclared.length > 0) {
    return refuse(kind, DEPRECATION_UNSET, `removed FIX tag ${undeclared.join(',')} without deprecation — refusing a silent break`);
  }
  if (!text(input.changelog)) {
    return refuse(kind, SILENT_BREAK, 'deprecated FIX removal without changelog — refusing a silent break');
  }
  return null;
}

export function handleFixDeveloper(body: unknown): DeveloperResult {
  const input = developerInputSchema.parse(body);
  const ieee = refuseIeeeOrUnset(input.kind, input);
  if (ieee) return ieee;
  const silent = refuseSilentTagBreak(input.kind, input);
  if (silent) return silent;
  return {
    ok: true,
    kind: input.kind,
    posted: false,
    changelog: text(input.changelog),
    deprecated: namedSet(input.deprecated),
    qty: text(input.qty),
    price: input.price === null ? null : text(input.price),
  };
}
