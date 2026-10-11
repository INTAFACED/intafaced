import type { Principal } from '@intafaced/auth';
/**
 * Collateral haircuts (CARD F8 / PTX-M08-R03 PTX-M08-R11 / PX-S06).
 *
 * Haircuts are OWNER. This mill does not invent a bps number (not 0, not 10).
 * Yield-bearing / staked / lending-idle posted as IM refuses — that is a
 * separate product. Posted margin is not a loan.
 *
 * Hitch: wrap `PositionService.open` so the mill runs BEFORE
 * `recipes.futuresMarginLock`. Live boot: ledger-client.ts loads this mill.
 * router.ts / position-service.ts / margin-mode.ts / matching not recut.
 */
import { parseOwnerIntegerEnv } from '../owner-int-env.js';
import { FuturesError, PositionService, type OpenPositionInput } from './position-service.js';
import { UNSUPPORTED_COLLATERAL_CLASS, checkCollateralClassForMargin, type MarginModeRefuseCode } from './margin-mode.js';

export const HAIRCUT_UNSET = 'trade.haircut_unset' as const;
export const MARGIN_IS_NOT_A_LOAN = 'trade.margin_is_not_a_loan' as const;

export type HaircutRefuseCode = typeof HAIRCUT_UNSET | typeof MARGIN_IS_NOT_A_LOAN | MarginModeRefuseCode;

export type HaircutCheck =
  | { readonly ok: true; readonly haircutBps: number | null }
  | { readonly ok: false; readonly code: HaircutRefuseCode; readonly reason: string };

export function readOwnerHaircutBps(env: NodeJS.ProcessEnv = process.env): unknown {
  return env.TRADE_COLLATERAL_HAIRCUT_BPS;
}

function present(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  return true;
}

/** Owner integer bps. Blank / non-integer / negative refuses — never invent 0 or 10. */
export function requireOwnerHaircutBps(raw: unknown): number {
  const n = parseOwnerIntegerEnv(typeof raw === 'number' || typeof raw === 'string' ? raw : String(raw));
  if (n == null || n < 0) {
    throw Object.assign(new Error('TRADE_COLLATERAL_HAIRCUT_BPS is unset — refuse rather than invent a haircut'), {
      code: HAIRCUT_UNSET,
    });
  }
  return n;
}

export interface PostedMarginCollateralInput {
  readonly collateralClass?: unknown;
  readonly haircutBps?: unknown;
  /** True if the caller is treating posted IM as borrowable principal. */
  readonly asLoan?: boolean;
}

/**
 * Cash (or omitted class) may post as IM. Yield/staked/lending-idle refuse.
 * A supplied haircut must be an owner integer — unset is not 0.
 * Posted margin is never a loan.
 */
export function checkPostedMarginCollateral(input: PostedMarginCollateralInput): HaircutCheck {
  if (input.asLoan === true) {
    return {
      ok: false,
      code: MARGIN_IS_NOT_A_LOAN,
      reason: 'posted margin is not a loan — refuse rather than lend against IM',
    };
  }
  const cls = checkCollateralClassForMargin(input.collateralClass);
  if (!cls.ok) return cls;

  const supplied = present(input.haircutBps) ? input.haircutBps : readOwnerHaircutBps();
  if (!present(supplied)) {
    return { ok: true, haircutBps: null };
  }
  try {
    return { ok: true, haircutBps: requireOwnerHaircutBps(supplied) };
  } catch {
    return {
      ok: false,
      code: HAIRCUT_UNSET,
      reason: 'TRADE_COLLATERAL_HAIRCUT_BPS is unset or not an owner integer — refuse rather than invent a haircut',
    };
  }
}

type OpenWithCollateral = OpenPositionInput & {
  readonly collateralClass?: unknown;
  readonly haircutBps?: unknown;
  readonly asLoan?: boolean;
};

function refuseOpen(check: Extract<HaircutCheck, { ok: false }>): never {
  throw new FuturesError(check.reason, check.code, 400);
}

const OPEN_FLAG = Symbol.for('intafaced.trade.collateralHaircutOpen');

export function installCollateralHaircutOpen(ctor: typeof PositionService): void {
  const proto = ctor.prototype as unknown as {
    open: (input: OpenPositionInput, principal?: Principal) => Promise<unknown>;
    [OPEN_FLAG]?: true;
  };
  if (proto[OPEN_FLAG]) return;
  proto[OPEN_FLAG] = true;
  const origOpen = proto.open;
  proto.open = async function (this: PositionService, input: OpenPositionInput, principal?: Principal) {
    const tagged = input as OpenWithCollateral;
    const check = checkPostedMarginCollateral({
      collateralClass: tagged.collateralClass,
      haircutBps: tagged.haircutBps,
      asLoan: tagged.asLoan,
    });
    if (!check.ok) refuseOpen(check);
    return origOpen.call(this, input, principal);
  };
}

export function installCollateralHaircut(): void {
  installCollateralHaircutOpen(PositionService);
}

installCollateralHaircut();

export { UNSUPPORTED_COLLATERAL_CLASS };
