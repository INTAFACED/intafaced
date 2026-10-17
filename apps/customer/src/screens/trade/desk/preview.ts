/**
 * Reading the server's order preview, and sorting a failed call into words.
 * The server decides whether an order can go; the desk only reads its answer. Refusal words always come from
 * `data/refusals.ts` (`refusalCopy`), never from the service's own text or raw codes.
 */
import type { ApiResult } from '../../../shared/api';
import type { Preview } from '../../../features/trade/trade-api';
import { parseAmount } from '../../../shared/money';
import { refusalCopy } from '../../../data';
import type { RefusalContext } from '../../../data';
import type { RefusalCopy } from '../../../data/types';

/** What the person is told when a call failed. `network` means we do not know the outcome of what was sent. */
export type Failure = { kind: 'refusal'; copy: RefusalCopy } | { kind: 'network' };

/** Can this preview be reviewed and sent? Orderable, no refusals, and the hold, fee and fee asset are all known. */
export function previewIsOrderable(preview: Preview): boolean {
  if (!preview.orderable || preview.refusals.length > 0) return false;
  if (preview.holdAsset === null || preview.holdAmount === null || preview.estimatedFee === null || preview.feeAsset === null) return false;
  try {
    return parseAmount(preview.holdAmount) > 0n;
  } catch {
    return false;
  }
}

/** The first refusal code the preview carries, or null when it has none. */
export function previewRefusalCode(preview: Preview): string | null {
  return preview.refusals[0]?.code ?? null;
}

export function refusalFailure(code: string | null | undefined, context: RefusalContext): Failure {
  return { kind: 'refusal', copy: refusalCopy(code ?? 'unknown', context) };
}

/**
 * A failed API call as words. A typed refusal (4xx with a code, or 401) gets its copy; a call that never reached
 * the service, timed out or came back unreadable is `network`: for a read that means "nothing was changed".
 */
export function failureOf(result: Extract<ApiResult<unknown>, { ok: false }>, context: RefusalContext): Failure {
  // The trade service reports a frozen ledger as a generic exchange error (`ExchangeError`, intafacedCode `LedgerError`) and
  // keeps the useful code only in its message, so that one message is read as a code. It is never shown.
  if (result.message === 'ledger.frozen') return refusalFailure('trade.orders_paused', context);
  if (result.reason === 'unauthorized') return refusalFailure('auth.required', context);
  if (result.code) return refusalFailure(result.code, context);
  if (result.reason === 'forbidden') return refusalFailure('scope.denied', context);
  return { kind: 'network' };
}
