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
import { userAvailable, type AccountRef, type Amount } from '@intafaced/ledger-client';
import { mulBps } from '@intafaced/ledger-client/money';
import { parseOwnerIntegerEnv } from '../owner-int-env.js';
import { initialMargin } from './initial-margin.js';
import { FuturesError, PositionService, type OpenPositionInput } from './position-service.js';
import { UNSUPPORTED_COLLATERAL_CLASS, checkCollateralClassForMargin, type MarginModeRefuseCode } from './margin-mode.js';

export const HAIRCUT_UNSET = 'trade.haircut_unset' as const;
export const HAIRCUT_CREDIT_SHORT = 'trade.haircut_credit_short' as const;
export const MARGIN_IS_NOT_A_LOAN = 'trade.margin_is_not_a_loan' as const;

export type HaircutRefuseCode =
  | typeof HAIRCUT_UNSET
  | typeof HAIRCUT_CREDIT_SHORT
  | typeof MARGIN_IS_NOT_A_LOAN
  | MarginModeRefuseCode;

export type HaircutCheck =
  | { readonly ok: true; readonly haircutBps: number }
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
    return {
      ok: false,
      code: HAIRCUT_UNSET,
      reason: 'TRADE_COLLATERAL_HAIRCUT_BPS is unset — refuse rather than invent a haircut',
    };
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

/**
 * How much of the posted cash counts toward initial margin.
 * 1000 bps on 100 credits 90. The cut is ceil so a fractional haircut never
 * invents credit. The initial-margin lock is a different number: this function
 * does not return it.
 */
export function collateralCredit(postedCash: Amount, haircutBps: number): Amount {
  if (postedCash <= 0n) return 0n as Amount;
  if (!Number.isInteger(haircutBps) || haircutBps <= 0) return postedCash;
  if (haircutBps >= 10_000) return 0n as Amount;
  const cut = mulBps(postedCash, haircutBps, 'ceil');
  const credit = postedCash - cut;
  return (credit < 0n ? 0n : credit) as Amount;
}

export type OpenCreditDecision =
  | { readonly ok: true; readonly credit: Amount; readonly lockAmount: Amount }
  | { readonly ok: false; readonly code: typeof HAIRCUT_CREDIT_SHORT; readonly reason: string; readonly lockAmount: 0n };

/**
 * Credit below the required initial margin refuses. The lock, when the open
 * proceeds, stays the full initial margin — the haircut does not shrink it.
 */
export function decideOpenCredit(input: {
  readonly postedCash: Amount;
  readonly initialMargin: Amount;
  readonly haircutBps: number;
}): OpenCreditDecision {
  const credit = collateralCredit(input.postedCash, input.haircutBps);
  if (credit < input.initialMargin) {
    return {
      ok: false,
      code: HAIRCUT_CREDIT_SHORT,
      reason:
        'posted collateral credit is below the initial margin — the haircut does not shrink the lock, so the open is refused and nothing is locked',
      lockAmount: 0n,
    };
  }
  return { ok: true, credit, lockAmount: input.initialMargin };
}

type CreditHost = {
  sql: (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<ReadonlyArray<{ id: string; quote_asset: string; kind: string; status: string }>>;
  ledger: { balance(ref: AccountRef): Promise<{ amount: Amount }> };
  markFor(marketId: string, symbol: string, at: Date, authorisesSize: Amount | null): Promise<{ price: Amount }>;
  now(): Date;
};

function asCreditHost(svc: object): CreditHost | null {
  const host = svc as CreditHost;
  if (typeof host.sql !== 'function' || typeof host.markFor !== 'function' || typeof host.now !== 'function') return null;
  if (!host.ledger || typeof host.ledger.balance !== 'function') return null;
  return host;
}

type CreditFigures = { readonly kind: 'figures'; readonly postedCash: Amount; readonly initialMargin: Amount } | { readonly kind: 'defer' };

async function readOpenCreditFigures(host: CreditHost, input: OpenPositionInput): Promise<CreditFigures> {
  let rows: ReadonlyArray<{ id: string; quote_asset: string; kind: string; status: string }>;
  try {
    rows = await host.sql`
      SELECT id, quote_asset, kind, status
      FROM trade.markets
      WHERE symbol = ${input.symbol}
      LIMIT 1
    `;
  } catch {
    throw new FuturesError(
      'collateral credit could not be read — refusing the open with no margin lock',
      HAIRCUT_UNSET,
      400,
    );
  }
  const market = rows[0];
  if (!market || market.kind !== 'futures' || market.status !== 'active') return { kind: 'defer' };
  let mark: { price: Amount };
  try {
    mark = await host.markFor(market.id, input.symbol, host.now(), input.size);
  } catch {
    return { kind: 'defer' };
  }
  let margin: Amount;
  try {
    margin = initialMargin({ size: input.size, entryPrice: mark.price, leverage: input.leverage });
  } catch {
    return { kind: 'defer' };
  }
  let posted: { amount: Amount };
  try {
    posted = await host.ledger.balance(userAvailable(input.userId, market.quote_asset));
  } catch {
    throw new FuturesError(
      'collateral credit could not be read — refusing the open with no margin lock',
      HAIRCUT_UNSET,
      400,
    );
  }
  return { kind: 'figures', postedCash: posted.amount, initialMargin: margin };
}

type OpenWithCollateral = OpenPositionInput & {
  readonly collateralClass?: unknown;
  readonly haircutBps?: unknown;
  readonly asLoan?: boolean;
};

function refuseOpen(check: { readonly code: HaircutRefuseCode; readonly reason: string }): never {
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
    const host = asCreditHost(this);
    if (host) {
      const figures = await readOpenCreditFigures(host, input);
      if (figures.kind === 'figures') {
        const decision = decideOpenCredit({
          postedCash: figures.postedCash,
          initialMargin: figures.initialMargin,
          haircutBps: check.haircutBps,
        });
        if (!decision.ok) refuseOpen(decision);
        // decision.lockAmount is the full initial margin. origOpen posts that
        // lock. The haircut is not applied to the locked amount.
      }
    }
    return origOpen.call(this, input, principal);
  };
}

export function installCollateralHaircut(): void {
  installCollateralHaircutOpen(PositionService);
}

installCollateralHaircut();

export { UNSUPPORTED_COLLATERAL_CLASS };
