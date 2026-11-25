import { router, TRPCError } from '@intafaced/contracts/trpc';
import { TradingControlError, type TradingControls } from './trading-controls.js';
import { tradingRestrictRequiresApproval } from '../admin/trading-restrict.js';
import {
  TRADE_ACCOUNT_CONTROLS_CHANGE,
  TRADE_ACCOUNT_CONTROLS_HISTORY,
  TRADE_ACCOUNT_CONTROLS_GET_STATE,
} from '@intafaced/contracts/trade-account-controls-procedures';
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
    change: mountRecord(
      TRADE_ACCOUNT_CONTROLS_CHANGE,
      async ({ ctx, input }) => {
        // The record takes an optional approval id; the four-eyes setting decides whether one is refused or required.
        const { approvalId, ...command } = input;
        const requires = tradingRestrictRequiresApproval();
        if (approvalId !== undefined && !requires)
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'An approval id is not taken while four-eyes approval is off' });
        if (approvalId === undefined && requires)
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'An approval id is required while four-eyes approval is on' });
        return call(() =>
          approvalId === undefined ? requireControls().change(ctx, command) : requireControls().change(ctx, command, approvalId),
        );
      },
      tradeRefusal,
    ),
  });
}
