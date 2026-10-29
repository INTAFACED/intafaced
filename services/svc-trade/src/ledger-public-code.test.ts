import { describe, expect, it } from 'vitest';
import { InsufficientFundsError, LedgerError } from '@intafaced/ledger-client';
import { POSTING_FROZEN, publicLedgerCode } from './ledger-public-code.js';
import { toCcxtError } from './ccxt-errors.js';
import { toTrpcError } from './router.js';

/** One rename of svc-ledger's posting freeze, the same on every surface that publishes a ledger code (DV-errors-02). */
describe('publicLedgerCode', () => {
  it('names the platform posting freeze posting_frozen and passes every other code through', () => {
    expect(publicLedgerCode('ledger.frozen')).toBe(POSTING_FROZEN);
    expect(POSTING_FROZEN).toBe('posting_frozen');
    for (const code of ['ledger.insufficient_funds', 'ledger.idempotency_conflict', 'trade.order_not_open', 'posting_frozen']) {
      expect(publicLedgerCode(code)).toBe(code);
    }
    expect(publicLedgerCode(null)).toBeNull();
  });

  it('the CCXT body and the tRPC error cause publish the same code for the freeze', () => {
    const frozen = new LedgerError('Ledger posting is frozen: TEST', 'ledger.frozen');
    expect(toCcxtError(frozen)?.body.intafacedCode).toBe(POSTING_FROZEN);
    const trpc = toTrpcError(frozen);
    expect(trpc.code).toBe('BAD_REQUEST');
    expect(trpc.cause).toBeInstanceOf(LedgerError);
    expect((trpc.cause as LedgerError).code).toBe(POSTING_FROZEN);
    expect(trpc.message).toBe(frozen.message);
  });

  it('the tRPC door keeps any other ledger error as it was thrown', () => {
    const other = new LedgerError('x', 'ledger.idempotency_conflict');
    expect(toTrpcError(other).cause).toBe(other);
    const funds = new InsufficientFundsError('a', 'USDT', '1', '0');
    expect((toTrpcError(funds).cause as LedgerError).code).toBe('ledger.insufficient_funds');
  });
});
