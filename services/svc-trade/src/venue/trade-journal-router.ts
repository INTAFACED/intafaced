/**
 * `journal.closedTrades` and `journal.replay`: the perps trade journal of the person's own venue account (venue/trade-journal.ts; record
 * `@intafaced/contracts/trade-journal-procedures`). With the user-venue door off there is no venue account, and the door
 * answers 503 `trade.journal_unavailable`.
 */
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { TRADE_JOURNAL_CLOSED_TRADES, TRADE_JOURNAL_REPLAY } from '@intafaced/contracts/trade-journal-procedures';
import { journalRefusal, readTradeJournal, TradeJournalError, type TradeJournalDeps } from './trade-journal.js';
import { readTradeReplay, TradeReplayError } from './trade-replay.js';
import { UserVenueDoorError } from './user-venue-door.js';

const STATUS: Record<TradeJournalError['code'], TRPCError['code']> = {
  'trade.journal_unavailable': 'SERVICE_UNAVAILABLE',
  'trade.journal_request_invalid': 'BAD_REQUEST',
};

const refusalOf: RefusalOf = (err) => {
  if (err instanceof TradeReplayError)
    return { code: err.code, error: new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err }) };
  if (err instanceof UserVenueDoorError && err.code === 'trade.venue_sub_account_not_own')
    return { code: err.code, error: new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err }) };
  const e =
    err instanceof UserVenueDoorError && err.status < 500
      ? new TradeJournalError(err.message, 'trade.journal_request_invalid')
      : journalRefusal(err);
  return e ? { code: e.code, error: new TRPCError({ code: STATUS[e.code], message: e.message, cause: e }) } : undefined;
};

export function tradeJournalRouter(deps: TradeJournalDeps | null | undefined) {
  return router({
    closedTrades: mountRecord(
      TRADE_JOURNAL_CLOSED_TRADES,
      ({ ctx, input }) => {
        if (!deps)
          throw new TradeJournalError(
            'The trade journal reads your own venue account, and no venue is connected',
            'trade.journal_unavailable',
          );
        return readTradeJournal(deps, input, ctx.principal.userId);
      },
      refusalOf,
    ),
    // J-charts-desk-20: one journal trade, its stops over time and its market's bars, for its replay.
    replay: mountRecord(
      TRADE_JOURNAL_REPLAY,
      ({ ctx, input }) => {
        if (!deps)
          throw new TradeJournalError(
            'The trade journal reads your own venue account, and no venue is connected',
            'trade.journal_unavailable',
          );
        return readTradeReplay(deps, input, ctx.principal.userId);
      },
      refusalOf,
    ),
  });
}
