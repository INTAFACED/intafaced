import { formatAmount, parseAmount } from '@intafaced/ledger-client';

/** Postgres numeric text -> the canonical decimal string used on the wire. Never a JS number. */
export function money(value: string | null | undefined): string {
  return formatAmount(parseAmount(String(value ?? '0')));
}

/** A microsecond ISO timestamp from Postgres, shortened to the ISO the rest of svc-pay speaks. */
export function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
