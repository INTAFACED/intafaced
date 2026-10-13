/**
 * Options RFQ (CARD E4 / PTX-M11-R06 PTX-M12-R02 / PX-S06).
 *
 * Until the principal/agency owner socket is set, RFQ refuses.
 * Last look without disclosure refuses. Off-book leverage cap blank does
 * NOT inherit the book's cap. matching/ is not folded.
 *
 * Hitch: `quoteOptionsRfq` is the live door. It does not post on refuse.
 * router.ts / matching / trade-service.ts / position-service.ts not recut.
 */
import { parseOwnerIntegerEnv } from '../owner-int-env.js';

export const RFQ_CAPACITIES = ['principal', 'agency'] as const;
export type RfqCapacity = (typeof RFQ_CAPACITIES)[number];

export const RFQ_CAPACITY_UNSET = 'trade.rfq_capacity_unset' as const;
export const RFQ_CAPACITY_UNSUPPORTED = 'trade.rfq_capacity_unsupported' as const;
export const RFQ_LAST_LOOK_UNDISCLOSED = 'trade.rfq_last_look_undisclosed' as const;
export const RFQ_OFFBOOK_LEVERAGE_UNSET = 'trade.rfq_offbook_leverage_unset' as const;

export type OptionsRfqRefuseCode =
  typeof RFQ_CAPACITY_UNSET | typeof RFQ_CAPACITY_UNSUPPORTED | typeof RFQ_LAST_LOOK_UNDISCLOSED | typeof RFQ_OFFBOOK_LEVERAGE_UNSET;

export class OptionsRfqError extends Error {
  readonly code: OptionsRfqRefuseCode;
  readonly status = 400;
  constructor(code: OptionsRfqRefuseCode, message: string) {
    super(message);
    this.name = 'OptionsRfqError';
    this.code = code;
  }
}

export type OptionsRfqCheck =
  | {
      readonly ok: true;
      readonly capacity: RfqCapacity;
      readonly lastLook: false | { readonly disclosed: true };
      readonly offBookLeverageCap: number;
    }
  | { readonly ok: false; readonly code: OptionsRfqRefuseCode; readonly reason: string };

export function readOwnerRfqCapacity(env: NodeJS.ProcessEnv = process.env): unknown {
  return env.TRADE_OPTIONS_RFQ_CAPACITY;
}

export function readOwnerOffBookLeverageCap(env: NodeJS.ProcessEnv = process.env): unknown {
  return env.TRADE_OPTIONS_RFQ_OFFBOOK_LEVERAGE_CAP;
}

function parseCapacity(raw: unknown): OptionsRfqCheck {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return {
      ok: false,
      code: RFQ_CAPACITY_UNSET,
      reason: 'TRADE_OPTIONS_RFQ_CAPACITY is unset — refuse RFQ rather than invent principal or agency',
    };
  }
  if (typeof raw !== 'string' || (raw !== 'principal' && raw !== 'agency')) {
    return {
      ok: false,
      code: RFQ_CAPACITY_UNSUPPORTED,
      reason: `RFQ capacity ${JSON.stringify(raw)} is not a named socket — send principal or agency`,
    };
  }
  return {
    ok: true,
    capacity: raw,
    lastLook: false,
    offBookLeverageCap: 0,
  };
}

export interface OptionsRfqInput {
  readonly capacity?: unknown;
  readonly lastLook?: boolean;
  readonly lastLookDisclosed?: boolean;
  readonly offBookLeverageCap?: unknown;
  /** Book cap is accepted only to prove we never copy it. */
  readonly bookLeverageCap?: unknown;
}

/**
 * Options RFQ admission. Does not invent capacity, last-look disclosure,
 * or an off-book leverage cap from the book.
 */
export function checkOptionsRfq(input: OptionsRfqInput = {}): OptionsRfqCheck {
  const capacityRaw = input.capacity !== undefined ? input.capacity : readOwnerRfqCapacity();
  const parsed = parseCapacity(capacityRaw);
  if (!parsed.ok) return parsed;

  if (input.lastLook === true && input.lastLookDisclosed !== true) {
    return {
      ok: false,
      code: RFQ_LAST_LOOK_UNDISCLOSED,
      reason: 'RFQ last look without disclosure refuses — no undisclosed last look',
    };
  }

  const capRaw = input.offBookLeverageCap !== undefined ? input.offBookLeverageCap : readOwnerOffBookLeverageCap();
  const cap = parseOwnerIntegerEnv(
    typeof capRaw === 'number' || typeof capRaw === 'string' ? capRaw : capRaw == null ? capRaw : String(capRaw),
  );
  if (cap == null || cap <= 0) {
    void input.bookLeverageCap;
    return {
      ok: false,
      code: RFQ_OFFBOOK_LEVERAGE_UNSET,
      reason: "TRADE_OPTIONS_RFQ_OFFBOOK_LEVERAGE_CAP is unset — refuse rather than inherit the book's leverage cap",
    };
  }

  return {
    ok: true,
    capacity: parsed.capacity,
    lastLook: input.lastLook === true ? { disclosed: true } : false,
    offBookLeverageCap: cap,
  };
}

export interface QuoteOptionsRfqInput extends OptionsRfqInput {
  readonly post?: (recipe: unknown) => Promise<unknown>;
}

/**
 * Live RFQ door. Refuses before any ledger post. Never calls `post` on refuse.
 * Does not fold matching. Does not inherit book leverage.
 */
export async function quoteOptionsRfq(input: QuoteOptionsRfqInput = {}): Promise<OptionsRfqCheck> {
  const check = checkOptionsRfq(input);
  if (!check.ok) return check;
  void input.post;
  return check;
}
