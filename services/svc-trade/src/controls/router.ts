import { accountControlResultSchema } from '@intafaced/contracts/account-controls';
import { router, protectedProcedure, TRPCError } from '@intafaced/contracts/trpc';
import { TradingControlError, type TradingControls } from './trading-controls.js';
import { tradeRestrictInputSchema } from '../admin/trading-restrict.js';
import { TRADE_ACCOUNT_CONTROLS_HISTORY, TRADE_ACCOUNT_CONTROLS_GET_STATE } from '@intafaced/contracts/trade-account-controls-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { tradeRefusal } from '../record-refusal.js';

export function tradingControlsRouter(controls?: TradingControls) {
  const requireControls = (): TradingControls => {
    if (!controls)
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Trading controls unavailable',
        cause: new TradingControlError('authority.unavailable'),
      });
    return controls;
  };
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      let code: 'FORBIDDEN' | 'BAD_REQUEST' | 'SERVICE_UNAVAILABLE' = 'SERVICE_UNAVAILABLE';
      if (error instanceof TradingControlError) {
        if (error.code === 'operator.denied') code = 'FORBIDDEN';
        else if (error.code === 'operation.conflict') code = 'BAD_REQUEST';
      }
      throw new TRPCError({
        code,
        message: error instanceof TradingControlError ? error.message : 'Trading controls unavailable',
        cause: error,
      });
    }
  }
  return router({
    getState: mountRecord(
      TRADE_ACCOUNT_CONTROLS_GET_STATE,
      ({ ctx, input }) => call(() => requireControls().getState(ctx, input)),
      tradeRefusal,
    ),
    history: mountRecord(
      TRADE_ACCOUNT_CONTROLS_HISTORY,
      ({ ctx, input }) => call(() => requireControls().history(ctx, input)),
      tradeRefusal,
    ),
    change: protectedProcedure
      .input(tradeRestrictInputSchema())
      .output(accountControlResultSchema)
      .mutation(({ ctx, input }) => {
        const approvalId = 'approvalId' in input && typeof input.approvalId === 'string' ? input.approvalId : undefined;
        return call(() =>
          approvalId === undefined ? requireControls().change(ctx, input) : requireControls().change(ctx, input, approvalId),
        );
      }),
  });
}
