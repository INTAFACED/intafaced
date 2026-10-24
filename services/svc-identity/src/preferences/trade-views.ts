/**
 * Saved trade views. One namespace, the caller's own row, strict shape.
 * Unknown keys and anything over 16 KiB are refused. No other user's id.
 */
import { z } from 'zod';

export const TRADE_VIEWS_NAMESPACE = 'trade.views' as const;
export const PREFERENCES_VALUE_MAX_BYTES = 16 * 1024;
export const PREFERENCES_NAMESPACE_UNKNOWN = 'identity.preferences_namespace_unknown' as const;
export const PREFERENCES_VALUE_INVALID = 'identity.preferences_value_invalid' as const;
export const PREFERENCES_VALUE_TOO_LARGE = 'identity.preferences_value_too_large' as const;
export const PREFERENCES_VERSION_CONFLICT = 'preferences.version_conflict' as const;
export const PREFERENCES_VERSION_UNSET = 'preferences.version_unset' as const;
export const PREFERENCES_CLIENT_ID_UNSET = 'identity.client_request_id_unset' as const;
export const PREFERENCES_IDEMPOTENCY_CONFLICT = 'identity.preferences_idempotency_conflict' as const;

const filterValue = z.string().max(200);
const tradeViewSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(60),
    sort: z.string().trim().min(1).max(64),
    filters: z.record(z.string(), filterValue).superRefine((filters, ctx) => {
      const keys = Object.keys(filters);
      if (keys.length > 20) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'too many filters' });
      for (const key of keys) {
        if (key.trim().length < 1 || key.length > 64) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filter key' });
      }
    }),
    columns: z.array(z.string().trim().min(1).max(64)).max(32),
  })
  .strict();

export const tradeViewsValueSchema = z.array(tradeViewSchema).max(50);
export type TradeViewsValue = z.infer<typeof tradeViewsValueSchema>;

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as object).sort(([a], [b]) => a.localeCompare(b, 'en')))
      : item,
  );
}

export function parseTradeViews(value: unknown): TradeViewsValue {
  const parsed = tradeViewsValueSchema.safeParse(value);
  if (!parsed.success) {
    const unknown = parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys');
    const error = new Error(unknown ? PREFERENCES_VALUE_INVALID : PREFERENCES_VALUE_INVALID);
    (error as Error & { code: string }).code = PREFERENCES_VALUE_INVALID;
    throw error;
  }
  const bytes = Buffer.byteLength(stableJson(parsed.data), 'utf8');
  if (bytes > PREFERENCES_VALUE_MAX_BYTES) {
    const error = new Error(PREFERENCES_VALUE_TOO_LARGE);
    (error as Error & { code: string }).code = PREFERENCES_VALUE_TOO_LARGE;
    throw error;
  }
  return parsed.data;
}
