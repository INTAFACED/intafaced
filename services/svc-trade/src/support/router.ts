/**
 * tRPC door for the support trade summary (D-ops-06). A query, never a mutation; there is no write door beside it.
 *
 * `serviceProcedureFor(SUPPORT_TRADE_SUMMARY_CALLERS)` proves the caller (svc-support only) before the input is parsed. It
 * does not check the support case: svc-support does that before it calls, and the contract carries the case and agent ids
 * only for the audit row.
 */
import {
  router,
  serviceProcedureFor,
  supportTradeSummaryInputSchema,
  supportTradeSummarySchema,
  SUPPORT_TRADE_SUMMARY_CALLERS,
  TRPCError,
} from '@intafaced/contracts';
import { SupportTradeSummaryError, type SupportTradeSummaryReader } from './trade-summary.js';

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof SupportTradeSummaryError) {
    // The code rides in the message, the way the other typed refusals on this service do, and on `cause`.
    return new TRPCError({
      code: err.code === 'trade.support_summary_limit_unset' ? 'BAD_REQUEST' : 'SERVICE_UNAVAILABLE',
      message: `${err.message} [${err.code}]`,
      cause: err,
    });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: err });
}

/** Mounted as `support` on the root router. Unwired (no reader), it refuses closed with the named unavailable code. */
export function supportTradeSummaryRouter(reader?: SupportTradeSummaryReader) {
  return router({
    tradeSummary: serviceProcedureFor(SUPPORT_TRADE_SUMMARY_CALLERS)
      .input(supportTradeSummaryInputSchema)
      .output(supportTradeSummarySchema)
      .query(async ({ ctx, input }) => {
        if (!reader) {
          throw toTrpcError(
            new SupportTradeSummaryError('trade.support_summary_unavailable', 'the support trade summary is not wired on this service'),
          );
        }
        try {
          return await reader.read(ctx.service as string, input);
        } catch (err) {
          throw toTrpcError(err);
        }
      }),
  });
}
