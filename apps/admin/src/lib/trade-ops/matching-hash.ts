import { createHash } from 'node:crypto';
import type { MatchingActionSpec } from './matching-controls';

/** The hash svc-matching recomputes at consume time (`matchingActionPayloadHash`): sha256 of { actionType, ...fields }. */
export function matchingPayloadHash(a: MatchingActionSpec, marketId: string | null): string {
  const payload = JSON.stringify(a.perMarket ? { actionType: a.actionType, marketId } : { actionType: a.actionType });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
