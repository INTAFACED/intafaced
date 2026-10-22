import { describe, expect, it } from 'vitest';
import { toCcxtError } from './ccxt-errors.js';
import { TradeError } from './spot/types.js';

/** CB-bots-10: the error map entries for the verification refusals. TEST values. */
describe('verification refusals in the error map', () => {
  it.each(['trade.bots_verification_level_not_set', 'trade.bots_verification_insufficient'] as const)(
    '%s is PermissionDenied 403',
    (code) => {
      const mapped = toCcxtError(new TradeError('TEST refusal', code));
      expect(mapped).toMatchObject({ status: 403, body: { code: 'PermissionDenied', intafacedCode: code } });
    },
  );
});
