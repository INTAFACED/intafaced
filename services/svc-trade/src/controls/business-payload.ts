import { formatAmount } from '@intafaced/ledger-client';

/** Money leaves domain memory as decimal strings; never numeric JSON. */
export function businessPayload(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? formatAmount(v) : v))) as Record<string, unknown>;
}
