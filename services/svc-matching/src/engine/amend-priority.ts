/**
 * Native amend queue priority (PX-S03 §8.2 / PTX-M03-R03).
 * Reducing remaining qty at the same price retains the original queue sequence.
 * Increasing qty, changing price, or changing any execution-affecting attribute loses priority.
 * Cancel/replace is named CANCEL_REPLACE — never atomic amend, never queue-preserving.
 * Unsupported amend fields refuse by field. Omitted native fields inherit.
 */
import { OrderBook } from './book.js';
import type { AmendPriority, AmendResult, EngineAmend, OrderId, RejectReason } from './types.js';

export const AMEND_FIELD_UNSUPPORTED = 'amend_field_unsupported' as const;

const NATIVE_AMEND_KEYS = new Set(['orderId', 'expectedVersion', 'qty', 'price', 'stopPrice', 'tif', 'expireAt']);
/** Option identity confirm only — not a mutation. Disagreement refuses elsewhere. */
const OPTION_IDENTITY_KEYS = new Set(['strike', 'expiry']);

const FLAG = Symbol.for('intafaced.matching.amend-priority');

export function queuePriority(input: {
  readonly priceUnchanged: boolean;
  readonly qtyReducedOrSame: boolean;
  readonly executionAttributesUnchanged: boolean;
}): AmendPriority {
  if (input.priceUnchanged && input.qtyReducedOrSame && input.executionAttributesUnchanged) return 'retained';
  return 'lost';
}

function fieldCode(): RejectReason['code'] {
  return AMEND_FIELD_UNSUPPORTED as RejectReason['code'];
}

/** Extra keys on an amend command. `replace` is CANCEL_REPLACE, not native amend. */
export function unsupportedAmendField(cmd: EngineAmend | object): RejectReason | null {
  for (const key of Object.keys(cmd)) {
    if (NATIVE_AMEND_KEYS.has(key) || OPTION_IDENTITY_KEYS.has(key)) continue;
    if (key === 'replace') {
      return {
        code: fieldCode(),
        message: 'cancel/replace is named CANCEL_REPLACE; it is never atomic amend and is not queue-preserving',
      };
    }
    return {
      code: fieldCode(),
      message: `amend field ${key} is unsupported; omitted native fields inherit`,
    };
  }
  return null;
}

function refusedAmend(orderId: OrderId, reason: RejectReason): AmendResult {
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: reason,
    cancellations: [],
    triggered: [],
  };
}

export function installAmendPriority(ctor: typeof OrderBook): void {
  if (!ctor) return;
  const proto = ctor.prototype as { amend: (cmd: EngineAmend, now?: Date | null) => AmendResult; [FLAG]?: boolean };
  if (proto[FLAG]) return;
  proto[FLAG] = true;
  const orig = proto.amend;
  proto.amend = function (this: OrderBook, cmd: EngineAmend, now?: Date | null) {
    const field = unsupportedAmendField(cmd);
    if (field) return refusedAmend(cmd.orderId, field);
    return orig.call(this, cmd, now);
  };
}

installAmendPriority(OrderBook);
