import { describe, expect, it } from 'vitest';
import { TRPCError } from '@intafaced/contracts';
import { ConvertHistoryError, convertHistoryTrpcError, TRADE_CONVERT_LIST_CURSOR_INVALID } from './convert/convert-history.js';
import { tradeRefusal } from './record-refusal.js';

describe('tradeRefusal: the one refusal reader the call-records codemod mounts svc-trade with', () => {
  it("names a mapped refusal by its cause's code and sends the very error thrown, so the wire does not move", () => {
    const thrown = convertHistoryTrpcError(new ConvertHistoryError('the cursor does not decode', TRADE_CONVERT_LIST_CURSOR_INVALID));
    expect(thrown).toBeInstanceOf(TRPCError);
    const read = tradeRefusal(thrown);
    expect(read?.code).toBe(TRADE_CONVERT_LIST_CURSOR_INVALID);
    expect(read?.error).toBe(thrown);
  });

  it('leaves anything else unnamed: an unmapped domain error, a TRPCError with no coded cause, a non-error', () => {
    expect(tradeRefusal(new ConvertHistoryError('x', TRADE_CONVERT_LIST_CURSOR_INVALID))).toBeUndefined();
    expect(tradeRefusal(new TRPCError({ code: 'FORBIDDEN', message: 'callable only by svc-bank' }))).toBeUndefined();
    expect(tradeRefusal('trade.copy_unavailable')).toBeUndefined();
  });
});
