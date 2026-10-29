import { describe, expect, it } from 'vitest';
import { InsufficientFundsError, LedgerError } from '@intafaced/ledger-client';
import { classifyHoldPostError } from './spot/hold-outcome.js';
import {
  FrozenBeforeEngineError,
  POSTING_FROZEN,
  POSTING_FROZEN_MESSAGE,
  SETTLEMENT_PENDING,
  publicLedgerCode,
  refusedBeforeEngine,
} from './ledger-public-code.js';
import { toCcxtError } from './ccxt-errors.js';
import { toTrpcError } from './router.js';

/** One rename of svc-ledger's posting freeze, by where it stopped the order, the same on every surface (DV-errors-02). */
describe('publicLedgerCode', () => {
  const frozen = () => new LedgerError('Ledger posting is frozen: TEST', 'ledger.frozen');

  it('posting_frozen only for a freeze marked as refused before the engine; any other freeze is settlement pending', () => {
    expect(publicLedgerCode(refusedBeforeEngine(frozen()) as LedgerError)).toBe(POSTING_FROZEN);
    expect(publicLedgerCode(frozen())).toBe(SETTLEMENT_PENDING);
    for (const code of ['ledger.insufficient_funds', 'ledger.idempotency_conflict', 'ledger.unbalanced']) {
      expect(publicLedgerCode(new LedgerError('x', code))).toBe(code);
    }
  });

  it('the mark keeps the ledger error: same class, name, code and message, the original as cause', () => {
    const original = frozen();
    const marked = refusedBeforeEngine(original) as FrozenBeforeEngineError;
    expect(marked).toBeInstanceOf(FrozenBeforeEngineError);
    expect(marked).toBeInstanceOf(LedgerError);
    expect(marked).toMatchObject({ name: 'LedgerError', code: 'ledger.frozen', message: original.message });
    expect(marked.cause).toBe(original);
    // Internal decisions read it exactly as before.
    expect(classifyHoldPostError(marked)).toBe('refused');
    // Marking twice is one mark; anything that is not a posting freeze is left alone.
    expect(refusedBeforeEngine(marked)).toBe(marked);
    const funds = new InsufficientFundsError('a', 'USDT', '1', '0');
    expect(refusedBeforeEngine(funds)).toBe(funds);
    const other = new LedgerError('x', 'ledger.unbalanced');
    expect(refusedBeforeEngine(other)).toBe(other);
    const plain = new Error('socket hang up');
    expect(refusedBeforeEngine(plain)).toBe(plain);
  });

  it('the CCXT body and the tRPC cause publish the same code, and the same refusal-or-unknown split', () => {
    const before = refusedBeforeEngine(frozen()) as LedgerError;
    expect(toCcxtError(before)).toMatchObject({ status: 400, body: { intafacedCode: POSTING_FROZEN } });
    const trpcBefore = toTrpcError(before);
    expect(trpcBefore.code).toBe('BAD_REQUEST');
    expect((trpcBefore.cause as LedgerError).code).toBe(POSTING_FROZEN);
    // The ledger's own error stays the cause of the renamed one, with its stack.
    expect((trpcBefore.cause as LedgerError).cause).toBe(before);
    expect((trpcBefore.cause as LedgerError).stack).toBe(before.stack);

    const after = frozen();
    expect(toCcxtError(after)).toMatchObject({ status: 503, body: { intafacedCode: SETTLEMENT_PENDING } });
    const trpcAfter = toTrpcError(after);
    expect(trpcAfter.code).toBe('SERVICE_UNAVAILABLE');
    expect((trpcAfter.cause as LedgerError).code).toBe(SETTLEMENT_PENDING);
    // Neither door publishes the founders' free-text reason the ledger's message carries.
    for (const trpc of [trpcBefore, trpcAfter]) {
      expect(trpc.message).toBe(POSTING_FROZEN_MESSAGE);
      expect((trpc.cause as LedgerError).message).toBe(POSTING_FROZEN_MESSAGE);
    }
  });

  it('the tRPC door keeps any other ledger error as it was thrown', () => {
    const other = new LedgerError('x', 'ledger.idempotency_conflict');
    expect(toTrpcError(other).cause).toBe(other);
    expect(toTrpcError(other).code).toBe('BAD_REQUEST');
    const funds = new InsufficientFundsError('a', 'USDT', '1', '0');
    expect((toTrpcError(funds).cause as LedgerError).code).toBe('ledger.insufficient_funds');
  });
});
