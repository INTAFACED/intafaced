import { z } from 'zod';
import {
  router,
  protectedProcedure,
  TRPCError,
  accountControlInputSchema,
  accountControlResultSchema,
  accountControlLookupInputSchema,
  accountControlHistoryInputSchema,
  accountControlStateSchema,
} from '@intafaced/contracts';
import { TradingControlError, type TradingControls } from './trading-controls.js';

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
    getState: protectedProcedure
      .input(accountControlLookupInputSchema)
      .output(accountControlStateSchema.nullable())
      .query(({ ctx, input }) => call(() => requireControls().getState(ctx, input))),
    history: protectedProcedure
      .input(accountControlHistoryInputSchema)
      .output(z.array(accountControlResultSchema))
      .query(({ ctx, input }) => call(() => requireControls().history(ctx, input))),
    change: protectedProcedure
      .input(accountControlInputSchema)
      .output(accountControlResultSchema)
      .mutation(({ ctx, input }) => call(() => requireControls().change(ctx, input))),
  });
}
