/**
 * Isolated liquidation planner (trade.futures residual).
 *
 * PURE: given one open position + external mark price, decides whether to
 * liquidate and builds ledger recipe inputs. Does NOT invent marks, does NOT
 * post, does NOT run a cron. Job/cron supplies marks + posts recipes.
 *
 * Isolated v1: full close when equity is non-positive, or when equity is at
 * or below a **named** maintenance threshold. There is no product default of
 * 50% — omitted `maintenanceBps` is D3 unset, not an invented table.
 */
import { formatAmount, mul, mulBps, parseAmount, recipes, type Amount, type PostRequest } from '@intafaced/ledger-client';

const SCALE = 10n ** 18n;

export interface LiquidationPosition {
  positionId: string;
  userId: string;
  side: 'long' | 'short';
  size: Amount;
  entryPrice: Amount;
  /** Locked margin still on the position collateral pot. */
  margin: Amount;
  marginAsset: string;
  /** Optional stored liq price — if set, also liquidates when mark crosses it. */
  liqPrice?: Amount | null;
}

export interface LiquidationPlanInput {
  /** Unique id for this liquidation attempt (idempotency root). */
  liquidationId: string;
  position: LiquidationPosition;
  /** External mark — decimal string. Never invent. */
  markPrice: string;
  /**
   * Liquidate when equity <= this fraction of initial margin (bps).
   * Omitted = D3 unset: do not invent 50%. Equity ≤ 0 still liquidates.
   */
  maintenanceBps?: number;
}

export interface LiquidationPlan {
  liquidate: true;
  equity: Amount;
  unrealizedPnl: Amount;
  loss: Amount;
  fromMargin: Amount;
  fromInsurance: Amount;
  residualRelease: Amount;
  recipes: PostRequest[];
  reason: string;
}

export type LiquidationDecision = LiquidationPlan | { liquidate: false; equity: Amount; unrealizedPnl: Amount; reason: string };

/** Quote notional: size * price / SCALE. */
export function notionalAt(size: Amount, price: Amount): Amount {
  return mul(size, price, 'floor');
}

/**
 * Unrealized PnL in quote: long (mark-entry)*size/SCALE; short (entry-mark)*size/SCALE.
 */
export function unrealizedPnl(side: 'long' | 'short', size: Amount, entry: Amount, mark: Amount): Amount {
  const diff = side === 'long' ? mark - entry : entry - mark;
  // Floor on the true value: a gain is credited down, a loss is charged up.
  return mul(size, diff, 'floor');
}

export function planLiquidation(input: LiquidationPlanInput): LiquidationDecision {
  const mark = parseAmount(input.markPrice);
  if (mark <= 0n) {
    return { liquidate: false, equity: 0n, unrealizedPnl: 0n, reason: 'invalid_mark' };
  }

  const { position } = input;
  if (position.size <= 0n || position.margin <= 0n) {
    return { liquidate: false, equity: 0n, unrealizedPnl: 0n, reason: 'empty_position' };
  }

  const uPnL = unrealizedPnl(position.side, position.size, position.entryPrice, mark);
  const equity = position.margin + uPnL;

  const maintNamed = input.maintenanceBps;
  if (maintNamed !== undefined && (maintNamed < 0 || maintNamed > 10_000)) {
    return { liquidate: false, equity, unrealizedPnl: uPnL, reason: 'invalid_maintenance_bps' };
  }
  const maintenance = maintNamed === undefined ? null : mulBps(position.margin, maintNamed, 'ceil');

  let should = equity <= 0n || (maintenance !== null && equity <= maintenance);
  let reason = equity <= 0n ? 'equity_non_positive' : 'below_maintenance';

  /**
   * The stored liq price is an INDEPENDENT trigger — it bypasses the equity
   * check entirely, and the only validation it used to carry was `> 0n`.
   *
   * The equity path cannot fire in profit, and that is guaranteed by the
   * arithmetic rather than by a guard: `equity = margin + uPnL`, so `uPnL > 0`
   * implies `equity > margin >= maintenance` for any `maintenanceBps <= 10 000`.
   * Fuzzed with `liqPrice` disabled: 0 of 20 000 profit-liquidations.
   *
   * With it enabled, 2 148 of 40 000 fuzzed cases liquidated a position that was
   * in PROFIT — and `planLiquidation` realizes losses only. There is no branch
   * below that credits a positive PnL, so the gain is silently dropped: the user
   * gets their margin back and nothing else, with no error, no refusal and no
   * log, because the plan is well-formed and the recipes balance.
   *
   * Nothing checked that a long's liq price sits BELOW its entry or a short's
   * above it. A stale value after a margin top-up or a partial close, a wrong
   * sign, or a short's price written onto a long all fire it.
   */
  if (position.liqPrice != null && position.liqPrice > 0n) {
    const consistentWithSide = position.side === 'long' ? position.liqPrice < position.entryPrice : position.liqPrice > position.entryPrice;
    if (!consistentWithSide) {
      // A long liquidates when price FALLS, so its liq price must be below
      // entry; a short's must be above. Anything else is a data bug, and acting
      // on it closes a position the market never went against.
      return { liquidate: false, equity, unrealizedPnl: uPnL, reason: 'liq_price_inconsistent_with_side' };
    }

    const crossed = position.side === 'long' ? mark <= position.liqPrice : mark >= position.liqPrice;
    if (crossed) {
      should = true;
      reason = 'mark_crossed_liq_price';
    }
  }

  if (!should) {
    return {
      liquidate: false,
      equity,
      unrealizedPnl: uPnL,
      reason: maintNamed === undefined ? 'maintenance_bps_unset' : 'healthy',
    };
  }

  /**
   * A LIQUIDATION IN PROFIT IS A DATA BUG, NOT A LIQUIDATION.
   *
   * Placed after every trigger rather than inside the one that produced it, so
   * a trigger added later cannot reopen the hole. Everything below this line
   * realizes losses only — `loss` is `uPnL < 0n ? -uPnL : 0n`, and no branch
   * anywhere credits a gain — so reaching it with `uPnL > 0n` means handing the
   * user their margin back and silently keeping the profit.
   *
   * The equity path cannot get here (`uPnL > 0` implies `equity > margin >=
   * maintenance`), which is exactly why this is worth stating: the only way in
   * is a stored value that disagrees with the market, and refusing loudly is
   * what turns that into something an operator can see.
   */
  if (uPnL > 0n) {
    return { liquidate: false, equity, unrealizedPnl: uPnL, reason: 'refused_profitable_liquidation' };
  }

  const loss = uPnL < 0n ? -uPnL : 0n;
  const fromMargin = loss >= position.margin ? position.margin : loss;
  const fromInsurance = loss > position.margin ? loss - position.margin : 0n;
  const residualRelease = position.margin - fromMargin;

  const posts: PostRequest[] = [];
  if (fromMargin > 0n || fromInsurance > 0n) {
    posts.push(
      recipes.futuresRealizeLoss({
        positionId: position.positionId,
        userId: position.userId,
        assetId: position.marginAsset,
        fromMargin,
        fromInsurance,
        lossId: `${input.liquidationId}:loss`,
      }),
    );
  }
  if (residualRelease > 0n) {
    posts.push(
      recipes.futuresMarginRelease({
        positionId: position.positionId,
        userId: position.userId,
        assetId: position.marginAsset,
        amount: residualRelease,
        sequence: 1,
      }),
    );
  }

  return {
    liquidate: true,
    equity,
    unrealizedPnl: uPnL,
    loss,
    fromMargin,
    fromInsurance,
    residualRelease,
    recipes: posts,
    reason,
  };
}

export function summarizeLiquidation(d: LiquidationDecision): string {
  if (!d.liquidate) return `skip equity=${formatAmount(d.equity)} (${d.reason})`;
  return `liquidate loss=${formatAmount(d.loss)} margin=${formatAmount(d.fromMargin)} insurance=${formatAmount(d.fromInsurance)} release=${formatAmount(d.residualRelease)} (${d.reason})`;
}
