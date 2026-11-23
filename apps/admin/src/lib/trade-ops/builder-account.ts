import 'server-only';
import { TRADE_BUILDER_ACCOUNT_MODE } from '@intafaced/contracts/trade-builder-mode-procedures';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import type { Outcome } from './outcome';
import type { BuilderAccountView } from './builder-account-model';

/**
 * Our builder address's account mode at each venue (J-ops-console-28) through svc-edge: svc-trade
 * `admin.builderFees.accountMode`, read with its record's own reply schema. Each read is also a check: svc-trade opens or
 * clears the alert from what it reads. Nothing moves.
 */
export function readBuilderAccount(ctx: TradeCtx): Promise<Outcome<BuilderAccountView>> {
  return edgeCall(
    ctx,
    trpcSpec('trade', TRADE_BUILDER_ACCOUNT_MODE.path, 'query', undefined, (raw) => {
      const parsed = TRADE_BUILDER_ACCOUNT_MODE.output.safeParse(raw);
      return parsed.success ? parsed.data : null;
    }),
  );
}
