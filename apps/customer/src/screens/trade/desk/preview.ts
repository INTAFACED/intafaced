/**
 * Reading the server's order preview, and sorting a failed call into words.
 * The server decides whether an order can go; the desk only reads its answer. Refusal words always come from
 * `data/refusals.ts` (`refusalCopy`), never from the service's own text or raw codes.
 */
import type { ApiResult } from '../../../shared/api';
import type { Preview } from '../../../features/trade/trade-api';
import { parseAmount } from '../../../shared/money';
import { classifyRefusal, fmtPrice, refusalCopy } from '../../../data';
import type { RefusalContext } from '../../../data';
import type { RefusalCopy } from '../../../data/types';

/** What the person is told when a call failed. `network` means we do not know the outcome of what was sent. */
export type Failure = { kind: 'refusal'; copy: RefusalCopy } | { kind: 'network' };

/** Refusals that count new resting orders. The order check judges a new order, but a replacement takes the slot its
 * original frees (the service never caps it), so an edit reads the check without them. */
const OPEN_ORDER_CAPS = new Set(['trade.operator_throttle', 'trade.limit_max_open_orders', 'trade.open_orders_cap_unset']);

/** The order check for an edit: the same answer without the open-order cap refusals. */
export function asReplacement(preview: Preview): Preview {
  const refusals = preview.refusals.filter((refusal) => !OPEN_ORDER_CAPS.has(refusal.code));
  return refusals.length === preview.refusals.length ? preview : { ...preview, refusals, orderable: refusals.length === 0 };
}

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

/**
 * The preview's first refusal as words, with the numbers it names (a price band's edges, an open-order cap and count)
 * filled in. Prices read on the market's tick.
 */
export function previewFailure(preview: Preview, context: RefusalContext, tickSize?: string): Failure {
  const first = preview.refusals[0];
  const data = first?.data ?? {};
  const price = (value: string | undefined) => (value === undefined ? undefined : tickSize ? fmtPrice(value, tickSize) : value);
  const named: RefusalContext = {
    ...context,
    ...(data.low !== undefined ? { low: price(data.low) } : {}),
    ...(data.high !== undefined ? { high: price(data.high) } : {}),
    ...(data.cap !== undefined ? { cap: data.cap } : {}),
    ...(data.open !== undefined ? { open: data.open } : {}),
  };
  return refusalFailure(first?.code ?? null, named);
}

export function refusalFailure(code: string | null | undefined, context: RefusalContext): Failure {
  return { kind: 'refusal', copy: refusalCopy(code ?? 'unknown', context) };
}

/**
 * A failed API call as words. A typed refusal (4xx with a code, or 401) gets its copy; a call that never reached
 * the service, timed out or came back unreadable is `network`: for a read that means "nothing was changed".
 */
/**
 * The service's answer to the platform posting freeze before the engine (`posting_frozen`, a 400 refusal) or the
 * desk's own paused-orders code: the codes the refusal catalogue sorts as orders paused. Read from the code only;
 * a freeze after the engine (`trade.settlement_pending`) is an unknown outcome and never reads as paused.
 */
export const isLedgerFrozen = (result: { code?: string }): boolean => classifyRefusal(result.code) === 'ordersPaused';

export function failureOf(result: Extract<ApiResult<unknown>, { ok: false }>, context: RefusalContext): Failure {
  // The platform posting freeze: orders are paused for everyone, not this account.
  if (isLedgerFrozen(result)) return refusalFailure('trade.orders_paused', context);
  if (result.reason === 'unauthorized') return refusalFailure('auth.required', context);
  if (result.code) return refusalFailure(result.code, context);
  if (result.reason === 'forbidden') return refusalFailure('scope.denied', context);
  return { kind: 'network' };
}
