/**
 * `studio.list` page size. Blank / non-finite / <1 refuses.
 * Never invent 50. Owner may pass 50 explicitly.
 *
 * Store.list stays the in-process book for save tests. Only the tRPC dump is paged.
 */

import { QUANT_STUDIO_LIST_LIMIT_CAP } from '@intafaced/contracts/quant-studio-procedures';
import { QUANT_STUDIO_LIST_LIMIT_UNSET, QuantError } from '../errors.js';

/** The largest page, published with `studio.list`'s record. */
export const STUDIO_LIST_LIMIT_CAP = QUANT_STUDIO_LIST_LIMIT_CAP;

export { QUANT_STUDIO_LIST_LIMIT_UNSET };

/** Owner-published studio.list page size. Omit is not 50. */
export function assertStudioListLimit(limit: number | null | undefined): number {
  if (limit === undefined || limit === null || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new QuantError(QUANT_STUDIO_LIST_LIMIT_UNSET, 'pass limit (never invent 50)');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new QuantError(QUANT_STUDIO_LIST_LIMIT_UNSET, 'pass limit (never invent 50)');
  }
  return Math.min(STUDIO_LIST_LIMIT_CAP, n);
}
