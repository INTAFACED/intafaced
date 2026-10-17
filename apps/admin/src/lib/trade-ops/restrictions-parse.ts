/**
 * Reads the identity service's answers with the real contract schemas. Server code only: the contracts root pulls in
 * Node modules, so the browser-facing restrictions.ts keeps to types and this file stays out of client components.
 */
import {
  accountControlResultSchema,
  accountControlStateSchema,
  type AccountControlResult,
  type AccountControlState,
} from '@intafaced/contracts';

/** Account state, or null when the service has no such trading account. Anything else odd is a parse failure (undefined). */
export function parseState(raw: unknown): AccountControlState | null | undefined {
  if (raw === null) return null;
  const r = accountControlStateSchema.safeParse(raw);
  return r.success ? r.data : undefined;
}

export function parseHistory(raw: unknown): AccountControlResult[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: AccountControlResult[] = [];
  for (const item of raw) {
    const r = accountControlResultSchema.safeParse(item);
    if (!r.success) return null;
    rows.push(r.data);
  }
  return rows;
}

export function parseResult(raw: unknown): AccountControlResult | null {
  const r = accountControlResultSchema.safeParse(raw);
  return r.success ? r.data : null;
}
