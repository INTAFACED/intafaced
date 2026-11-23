import type { FounderCallResult } from '@/lib/desk';

/**
 * A reply the record parsed, held to a check only this desk needs (it is about what was asked, or how the desk shows it).
 * One that fails it reads as invalid, never as data.
 */
export function heldTo<T>(result: FounderCallResult<T>, holds: (data: T) => boolean): FounderCallResult<T> {
  return result.kind === 'ok' && !holds(result.data) ? { kind: 'invalid', requestId: result.requestId } : result;
}
