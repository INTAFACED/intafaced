import { BankError } from '../errors.js';
import type { PartnerBank, PartnerMove } from './partner-bank.js';

const WINDOW = 200;
const MAX_MOVES = 10_000;

/**
 * Every line of the partner's record for one person in one currency between two times, pay-ins included, newest first.
 * `to` is exclusive, as every ledger history range is. Past the cap it refuses rather than add up part of the range.
 */
export async function partnerMovesBetween(
  partner: PartnerBank,
  userId: string,
  range: { assetId: string; from: Date; to: Date },
): Promise<PartnerMove[]> {
  const out: PartnerMove[] = [];
  let before: string | undefined;
  for (let scanned = 0; scanned < MAX_MOVES; scanned += WINDOW) {
    const window = await partner.moves(userId, { limit: WINDOW, assetId: range.assetId, payIns: true, ...(before ? { before } : {}) });
    for (const move of window) {
      if (move.movedAt < range.from) return out;
      if (move.movedAt < range.to) out.push(move);
    }
    if (window.length < WINDOW) return out;
    before = window[window.length - 1]!.id;
  }
  throw new BankError(`More than ${MAX_MOVES} lines are in this range. Narrow the dates.`, 'bank.statement_too_large');
}
