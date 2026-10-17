import type { ActivityItem } from './deps';

/** A cell that begins with one of these can be run as a formula by a spreadsheet; text cells get a leading apostrophe. */
const RISKY = /^[=+\-@\t\r]/;

function cell(value: string, text: boolean): string {
  const safe = text && RISKY.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CSV_HEADER = ['Date (UTC)', 'Type', 'Direction', 'Asset', 'Amount', 'Counterparty', 'Account', 'Reference', 'Record'] as const;

/** The signed amount, exactly as the service sent it: a minus for money out, nothing added or rounded. */
export const signedAmount = (item: Pick<ActivityItem, 'direction' | 'amount'>): string =>
  item.direction === 'out' && !/^0(\.0+)?$/.test(item.amount) ? `-${item.amount}` : item.amount;

/**
 * One statement of the customer's own records. Dates are UTC so the file reads the same everywhere. `typeOf` turns a kind
 * into words the customer would use. Newest first, as listed.
 */
export function activityCsv(items: readonly ActivityItem[], typeOf: (item: ActivityItem) => string): string {
  const lines: string[] = [CSV_HEADER.map((name) => cell(name, false)).join(',')];
  for (const item of items) {
    const when = Number.isFinite(Date.parse(item.postedAt)) ? new Date(item.postedAt).toISOString() : '';
    lines.push(
      [
        cell(when, false),
        cell(typeOf(item), true),
        cell(item.direction === 'in' ? 'in' : 'out', false),
        cell(item.asset, true),
        cell(signedAmount(item), false),
        cell(item.counterparty ? `@${item.counterparty.handle}` : '', true),
        cell(item.spaceName ?? '', true),
        cell(item.txId, true),
        cell(item.id, true),
      ].join(','),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function csvFileName(now: Date): string {
  return `intafaced-activity-${now.toISOString().slice(0, 10)}.csv`;
}
