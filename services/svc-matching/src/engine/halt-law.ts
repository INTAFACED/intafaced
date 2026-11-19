/**
 * Halt law (PX-S03 / PTX-M02-R03 / PTX-M00-R04).
 * Halt ≡ cancel-only. Restart cannot reset a halted market to OPEN.
 * Reduce-only and post-only are distinct doors. Do not invent a flatten.
 * Hitch: imported from index.ts so MatchingEngine is wrapped without recutting engine.ts.
 */
import { MatchingEngine } from './engine.js';
import type { MarketHaltResult, MarketId, RejectReason } from './types.js';

export const HALT_RESTART_OPEN = 'halt_restart_open' as const;
export const HALT_RESTART_OPEN_MESSAGE = 'restart cannot reset a halted market to OPEN';

const FLAG = Symbol.for('intafaced.matching.halt-law');

export function restartRefuse(marketId: MarketId): RejectReason {
  return {
    code: HALT_RESTART_OPEN,
    message: `${HALT_RESTART_OPEN_MESSAGE} (${marketId})`,
  };
}

export function haltedRestartResult(marketId: MarketId): MarketHaltResult {
  return {
    accepted: false,
    marketId,
    halted: true,
    operatorId: null,
    rejected: restartRefuse(marketId),
  };
}

/** Halt does not set reduce-only. Missing isReduceOnly is not reduce-only. */
export function haltIsNotReduceOnly(
  engine: { isHalted(marketId: MarketId): boolean; isReduceOnly?(marketId: MarketId): boolean },
  marketId: MarketId,
): boolean {
  return engine.isHalted(marketId) && engine.isReduceOnly?.(marketId) !== true;
}

/** Halt does not set post-only. Missing isPostOnly is not post-only. */
export function haltIsNotPostOnly(
  engine: { isHalted(marketId: MarketId): boolean; isPostOnly?(marketId: MarketId): boolean },
  marketId: MarketId,
): boolean {
  return engine.isHalted(marketId) && engine.isPostOnly?.(marketId) !== true;
}

export function installHaltLaw(ctor: typeof MatchingEngine = MatchingEngine): void {
  const proto = ctor.prototype as {
    restart?: (marketId: MarketId) => Promise<MarketHaltResult>;
    recover: MatchingEngine['recover'];
    isHalted: MatchingEngine['isHalted'];
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origRestart = proto.restart;

  proto.restart = async function (this: MatchingEngine, marketId: MarketId) {
    if (this.isHalted(marketId)) {
      return haltedRestartResult(marketId);
    }
    if (typeof origRestart === 'function') {
      return origRestart.call(this, marketId);
    }
    await this.recover();
    return {
      accepted: true,
      marketId,
      halted: this.isHalted(marketId),
      operatorId: null,
    };
  };
}

try {
  installHaltLaw();
} catch {
  queueMicrotask(() => installHaltLaw());
}
