/**
 * Hedge / one-way position mode (CARD F6 / PTX-M10-R07 / PX-S07 §12).
 *
 * Explicit named modes: `one_way` | `hedge`. Unset / blank refuses NEW risk.
 * Unknown names refuse unsupported. Migration with open orders or positions
 * refuses — this mill does not invent a flatten. Order-side: hedge requires
 * `positionSide` long|short (buy/sell stays API order-side). one_way is net:
 * positionSide omitted or matching net side; hedge-only dual positionSide
 * refuses. matching/ is not recut.
 *
 * Hitch: wrap `PositionService.open` and `TradeService.placeOrder` (futures)
 * so the mill runs BEFORE `recipes.futuresMarginLock` / `recipes.orderHold`.
 * Live boot: ledger-client.ts loads this mill next to F5. router.ts /
 * trade-service.ts / position-service.ts / matching not recut.
 */
import { TradeError, type TradeErrorCode } from '../spot/types.js';
import { TradeService, type PlaceOrderInput } from '../spot/trade-service.js';
import { FuturesError, PositionService, type OpenPositionInput } from './position-service.js';
import type { Principal } from '@intafaced/auth';

export const NAMED_POSITION_MODES = ['one_way', 'hedge'] as const;
export type NamedPositionMode = (typeof NAMED_POSITION_MODES)[number];

export const POSITION_MODE_UNSET = 'trade.position_mode_unset' as const;
export const POSITION_MODE_UNSUPPORTED = 'trade.position_mode_unsupported' as const;
export const POSITION_MODE_MIGRATION_BLOCKED = 'trade.position_mode_migration_blocked' as const;
export const POSITION_SIDE_UNSUPPORTED = 'trade.position_side_unsupported' as const;

export type PositionModeRefuseCode =
  typeof POSITION_MODE_UNSET | typeof POSITION_MODE_UNSUPPORTED | typeof POSITION_MODE_MIGRATION_BLOCKED | typeof POSITION_SIDE_UNSUPPORTED;

export type PositionModeCheck =
  | { readonly ok: true; readonly mode: NamedPositionMode }
  | { readonly ok: false; readonly code: PositionModeRefuseCode; readonly reason: string };

const NAMED = new Set<string>(NAMED_POSITION_MODES);

export function parsePositionMode(value: unknown): PositionModeCheck {
  if (value === undefined || value === null) {
    return {
      ok: false,
      code: POSITION_MODE_UNSET,
      reason: 'positionMode is unset — name one_way or hedge; omitting is not a product',
    };
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      ok: false,
      code: POSITION_MODE_UNSET,
      reason: 'positionMode is unset — name one_way or hedge',
    };
  }
  if (!NAMED.has(value)) {
    return {
      ok: false,
      code: POSITION_MODE_UNSUPPORTED,
      reason: `positionMode ${JSON.stringify(value)} is not a named mode — send one_way or hedge`,
    };
  }
  return { ok: true, mode: value as NamedPositionMode };
}

export function checkPositionMode(value: unknown): PositionModeCheck {
  return parsePositionMode(value);
}

export interface PositionModeMigrationInput {
  readonly from: unknown;
  readonly to: unknown;
  readonly openOrderCount: number;
  readonly openPositionCount: number;
}

/**
 * Switch with open orders/positions refuses. Unset destination refuses.
 * This function does not cancel, close, or invent a flatten.
 */
export function checkPositionModeMigration(input: PositionModeMigrationInput): PositionModeCheck {
  const to = parsePositionMode(input.to);
  if (!to.ok) return to;
  const from = parsePositionMode(input.from);
  const fromMode = from.ok ? from.mode : null;
  if (fromMode === to.mode) return to;
  if (input.openOrderCount > 0 || input.openPositionCount > 0) {
    return {
      ok: false,
      code: POSITION_MODE_MIGRATION_BLOCKED,
      reason: 'switching position mode with open orders or positions refuses — will not invent a flatten',
    };
  }
  return to;
}

export interface OrderSideForPositionModeInput {
  readonly mode: unknown;
  readonly side: unknown;
  readonly positionSide?: unknown;
}

function netSideFrom(side: string): 'long' | 'short' {
  if (side === 'buy' || side === 'long') return 'long';
  return 'short';
}

function isHedgeDualPositionSide(value: unknown): boolean {
  if (Array.isArray(value)) {
    const set = new Set(value.map((v) => String(v)));
    return set.has('long') && set.has('short');
  }
  if (typeof value !== 'string') return false;
  const n = value.trim().toLowerCase().replace(/\s+/g, '');
  return n === 'both' || n === 'dual' || n === 'long_short' || n === 'long+short' || n === 'long,short';
}

/**
 * Order-side semantics. Hedge requires explicit positionSide long|short;
 * buy/sell stays API order-side. one_way: omitted or matching net side;
 * hedge-only dual positionSide (both long+short as extra) refuses.
 */
export function checkOrderSideForPositionMode(input: OrderSideForPositionModeInput): PositionModeCheck {
  const mode = parsePositionMode(input.mode);
  if (!mode.ok) return mode;
  const side = typeof input.side === 'string' ? input.side.trim() : '';
  if (side === '') {
    return {
      ok: false,
      code: POSITION_SIDE_UNSUPPORTED,
      reason: 'order side is unset — send buy or sell (API order-side semantics)',
    };
  }
  if (side !== 'buy' && side !== 'sell' && side !== 'long' && side !== 'short') {
    return {
      ok: false,
      code: POSITION_SIDE_UNSUPPORTED,
      reason: `order side ${JSON.stringify(input.side)} is unsupported — send buy or sell`,
    };
  }
  const rawSide = input.positionSide;
  const positionSide = typeof rawSide === 'string' ? rawSide.trim() : rawSide;
  if (mode.mode === 'hedge') {
    if (positionSide === undefined || positionSide === null || positionSide === '') {
      return {
        ok: false,
        code: POSITION_SIDE_UNSUPPORTED,
        reason: 'hedge mode requires positionSide long or short — refusing an invented net',
      };
    }
    if (positionSide !== 'long' && positionSide !== 'short') {
      return {
        ok: false,
        code: POSITION_SIDE_UNSUPPORTED,
        reason: `positionSide ${JSON.stringify(rawSide)} is unsupported — send long or short`,
      };
    }
    return mode;
  }
  if (isHedgeDualPositionSide(rawSide)) {
    return {
      ok: false,
      code: POSITION_SIDE_UNSUPPORTED,
      reason: 'one_way mode is net — hedge dual positionSide (long+short) is unsupported',
    };
  }
  if (positionSide === undefined || positionSide === null || positionSide === '') {
    return mode;
  }
  const net = netSideFrom(side);
  if (positionSide === net) return mode;
  return {
    ok: false,
    code: POSITION_SIDE_UNSUPPORTED,
    reason: `one_way positionSide ${JSON.stringify(rawSide)} does not match net side ${net}`,
  };
}

type OpenWithMode = OpenPositionInput & {
  readonly positionMode?: unknown;
  readonly positionSide?: unknown;
};

type PlaceWithMode = PlaceOrderInput & {
  readonly positionMode?: unknown;
  readonly positionSide?: unknown;
};

function refuseOpen(check: Extract<PositionModeCheck, { ok: false }>): never {
  throw new FuturesError(check.reason, check.code, 400);
}

function refusePlace(check: Extract<PositionModeCheck, { ok: false }>): never {
  throw new TradeError(check.reason, check.code as TradeErrorCode);
}

const OPEN_FLAG = Symbol.for('intafaced.trade.positionModeOpen');
const PLACE_FLAG = Symbol.for('intafaced.trade.positionModePlace');

export function installPositionModeOpen(ctor: typeof PositionService): void {
  const proto = ctor.prototype as unknown as {
    open: (input: OpenPositionInput, principal?: Principal) => Promise<unknown>;
    [OPEN_FLAG]?: true;
  };
  if (proto[OPEN_FLAG]) return;
  proto[OPEN_FLAG] = true;
  const origOpen = proto.open;
  proto.open = async function (this: PositionService, input: OpenPositionInput, principal?: Principal) {
    const tagged = input as OpenWithMode;
    const mode = parsePositionMode(tagged.positionMode);
    if (!mode.ok) refuseOpen(mode);
    const side = checkOrderSideForPositionMode({
      mode: mode.mode,
      side: tagged.side,
      positionSide: tagged.positionSide,
    });
    if (!side.ok) refuseOpen(side);
    return origOpen.call(this, input, principal);
  };
}

export function installPositionModePlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<unknown>;
    [PLACE_FLAG]?: true;
  };
  if (proto[PLACE_FLAG]) return;
  proto[PLACE_FLAG] = true;
  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const tagged = input as PlaceWithMode;
    if (tagged.positionMode === undefined && tagged.positionSide === undefined) {
      return origPlace.call(this, principal, input);
    }
    const mode = parsePositionMode(tagged.positionMode);
    if (!mode.ok) refusePlace(mode);
    const side = checkOrderSideForPositionMode({
      mode: mode.mode,
      side: tagged.side,
      positionSide: tagged.positionSide,
    });
    if (!side.ok) refusePlace(side);
    return origPlace.call(this, principal, input);
  };
}

export function installPositionMode(): void {
  installPositionModeOpen(PositionService);
  installPositionModePlace(TradeService);
}

installPositionMode();
