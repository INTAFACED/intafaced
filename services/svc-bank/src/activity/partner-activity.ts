import { formatAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { PartnerAccountRef, PartnerBank, PartnerMove } from '../partner/partner-bank.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import type { ActivityItem, ActivityPage, ActivityQuery } from './activity-service.js';
import { ActivityNotFoundError, ActivityRangeError } from './activity-service.js';
import { ActivityCursorInvalidError } from './activity-cursor.js';

/**
 * HISTORY WHEN THE PARTNER BANK HOLDS THE MONEY (OWNER 226).
 *
 * The ledger holds no line for a partner-held person's bank money, so their history is the partner's own record of
 * the moves it made, as it reports them, each labelled with whose record it is (TEST on the TEST partner). One move is
 * a line on each of the person's accounts it touched: a move between their own spaces is a line out of one and a line
 * into the other, as the ledger's feed shows a space move.
 *
 * Only the filters the partner's record can answer are taken: asset, kind, direction, dates and account. Any other
 * filter or an oldest-first order refuses `bank.partner_history_filter_unsupported`, rather than answer a list that
 * silently ignored it.
 */

/** How many partner moves one page may read before it stops and hands back a cursor. */
const SCAN_WINDOW = 100;
const SCAN_MAX = 2_000;
const CURSOR = /^[A-Za-z0-9_-]{1,128}$/;

function unsupported(name: string): BankError {
  return new BankError(
    `The partner bank's history cannot be filtered by ${name} here. Remove that filter to see it.`,
    'bank.partner_history_filter_unsupported',
  );
}

function assertSupported(input: ActivityQuery): void {
  if (input.sort === 'asc') throw unsupported('oldest first');
  const names: Array<[keyof ActivityQuery, string]> = [
    ['q', 'search'],
    ['minAmount', 'amount'],
    ['maxAmount', 'amount'],
    ['address', 'address'],
    ['hasNote', 'note'],
    ['year', 'year'],
    ['taxYear', 'tax year'],
  ];
  for (const [key, name] of names) if (input[key] !== undefined && input[key] !== false) throw unsupported(name);
}

function lineId(move: PartnerMove, side: 'out' | 'in'): string {
  return `${move.id}.${side}`;
}

function sameUser(a: PartnerAccountRef, b: PartnerAccountRef): boolean {
  return a.userId === b.userId;
}

/** The person's lines for one move: out of the account it left, into the account it reached, theirs only. */
export function partnerLines(userId: string, move: PartnerMove, names: ReadonlyMap<string, string>): ActivityItem[] {
  const own = sameUser(move.from, move.to);
  const lines: ActivityItem[] = [];
  const line = (side: 'out' | 'in', account: PartnerAccountRef): ActivityItem => ({
    id: lineId(move, side),
    kind: own ? 'space_move' : side === 'out' ? 'transfer_out' : 'transfer_in',
    direction: side,
    asset: account.assetId,
    amount: formatAmount(move.amount),
    postedAt: move.movedAt.toISOString(),
    txId: move.id,
    counterparty: null,
    spaceName: account.spaceId === null ? null : (names.get(account.spaceId) ?? null),
    heldAt: { label: move.label },
  });
  if (move.from.userId === userId) lines.push(line('out', move.from));
  if (move.to.userId === userId) lines.push(line('in', move.to));
  return lines;
}

function keeps(item: ActivityItem, account: PartnerAccountRef, input: ActivityQuery): boolean {
  if (input.kind && !input.kind.includes(item.kind)) return false;
  if (input.direction && item.direction !== input.direction) return false;
  if (input.from && item.postedAt < new Date(input.from).toISOString()) return false;
  if (input.to && item.postedAt > new Date(input.to).toISOString()) return false;
  if (input.accountId !== undefined) {
    if (input.accountId === 'main' ? account.spaceId !== null : account.spaceId !== input.accountId) return false;
  }
  return true;
}

export async function partnerActivityPage(
  userId: string,
  partner: PartnerBank,
  spaces: { allNamedSpaces(userId: string, assetId?: string): Promise<SpaceRecord[]> },
  input: ActivityQuery,
  limit: number,
): Promise<ActivityPage> {
  assertSupported(input);
  if (input.from && input.to && new Date(input.to) < new Date(input.from)) throw new ActivityRangeError();
  if (input.cursor !== undefined && !CURSOR.test(input.cursor)) throw new ActivityCursorInvalidError();
  const names = new Map((await spaces.allNamedSpaces(userId)).map((s) => [s.id, s.name]));
  const items: ActivityItem[] = [];
  let before = input.cursor;
  let scanned = 0;
  let lastTaken: string | undefined;
  while (scanned < SCAN_MAX) {
    const window = await partner.moves(userId, {
      limit: SCAN_WINDOW,
      ...(before ? { before } : {}),
      ...(input.assetId ? { assetId: input.assetId } : {}),
    });
    for (const move of window) {
      const lines = partnerLines(userId, move, names).filter((line) => keeps(line, line.direction === 'out' ? move.from : move.to, input));
      // A page ends on a whole move, so a cursor never splits one move's two lines.
      if (items.length > 0 && items.length + lines.length > limit) return { items, nextCursor: lastTaken ?? null };
      items.push(...lines);
      lastTaken = move.id;
      scanned += 1;
      if (items.length >= limit) return { items, nextCursor: move.id };
    }
    if (window.length < SCAN_WINDOW) return { items, nextCursor: null };
    before = window[window.length - 1]!.id;
  }
  return { items, nextCursor: lastTaken ?? null };
}

/** One line of a partner move, and the person's other line of the same move. */
export async function partnerActivityItem(
  userId: string,
  partner: PartnerBank,
  spaces: { allNamedSpaces(userId: string, assetId?: string): Promise<SpaceRecord[]> },
  id: string,
): Promise<{ item: ActivityItem; lines: ActivityItem[]; complete: boolean }> {
  const names = new Map((await spaces.allNamedSpaces(userId)).map((s) => [s.id, s.name]));
  let before: string | undefined;
  for (let scanned = 0; scanned < SCAN_MAX; scanned += SCAN_WINDOW) {
    const window = await partner.moves(userId, { limit: SCAN_WINDOW, ...(before ? { before } : {}) });
    for (const move of window) {
      const lines = partnerLines(userId, move, names);
      const item = lines.find((line) => line.id === id);
      if (item) return { item, lines, complete: true };
    }
    if (window.length < SCAN_WINDOW) throw new ActivityNotFoundError();
    before = window[window.length - 1]!.id;
  }
  throw new ActivityNotFoundError();
}
