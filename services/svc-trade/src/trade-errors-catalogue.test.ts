import { describe, expect, it } from 'vitest';
import { TRADE_ERROR_CATALOGUE, type TradeErrorCause } from '@intafaced/contracts/trade-errors';
import { LedgerError } from '@intafaced/ledger-client';
import { toCcxtError } from './ccxt-errors.js';
import { createBodyRefusal } from './create-body-refusal.js';
import { refusedBeforeEngine } from './ledger-public-code.js';

/**
 * The order error catalogue published at /developers/errors (DV-errors-01, DV-errors-02) holds exactly what this
 * service sends, in both directions: each body below is one entry, with the same class and status, and its `docs`
 * link names that entry's anchor; and every entry is one of these bodies.
 */
const issue = (field: string) => ({ path: [field], message: `${field} is invalid` });

function sent(): Array<{ cause: TradeErrorCause; status: number; code: string; intafacedCode: string; docs?: string }> {
  const body = (status: number, b: { code: string; intafacedCode?: string; docs?: string }) => ({
    status,
    code: b.code,
    intafacedCode: b.intafacedCode ?? '',
    ...(b.docs ? { docs: b.docs } : {}),
  });
  const frozen = new LedgerError('Ledger posting is frozen: TEST', 'ledger.frozen');
  const before = toCcxtError(refusedBeforeEngine(frozen))!;
  const after = toCcxtError(frozen)!;
  return [
    { cause: 'fields', ...body(400, createBodyRefusal({ issues: [issue('side'), issue('amount')] }, 'bad')) },
    { cause: 'fields', ...body(400, createBodyRefusal({ issues: [issue('side')] }, 'bad')) },
    { cause: 'fields', ...body(400, createBodyRefusal({ issues: [] }, 'bad')) },
    { cause: 'tag', ...body(400, createBodyRefusal({ issues: [issue('tag')] }, 'bad')) },
    { cause: 'posting_frozen', ...body(before.status, before.body) },
    { cause: 'settlement_pending', ...body(after.status, after.body) },
  ];
}

describe('the order error catalogue', () => {
  it('names every body this service links or sends for a bad order body or the posting freeze, with its class and status', () => {
    for (const reply of sent()) {
      const entries = TRADE_ERROR_CATALOGUE.filter((e) => e.intafacedCode === reply.intafacedCode);
      expect(entries, reply.intafacedCode).toHaveLength(1);
      expect({ cause: entries[0]!.cause, code: entries[0]!.code, status: entries[0]!.status }).toEqual({
        cause: reply.cause,
        code: reply.code,
        status: reply.status,
      });
    }
  });

  it('lists only codes this service sends', () => {
    const codes = new Set(sent().map((reply) => reply.intafacedCode));
    expect(TRADE_ERROR_CATALOGUE.map((e) => e.intafacedCode).filter((code) => !codes.has(code))).toEqual([]);
    expect(new Set(TRADE_ERROR_CATALOGUE.map((e) => e.anchor)).size).toBe(TRADE_ERROR_CATALOGUE.length);
  });

  it("every create-body refusal's docs link opens its own entry", () => {
    const refusals = sent().filter((r) => r.cause === 'fields' || r.cause === 'tag');
    expect(refusals).toHaveLength(4);
    for (const reply of refusals) {
      const anchor = TRADE_ERROR_CATALOGUE.find((e) => e.intafacedCode === reply.intafacedCode)?.anchor;
      expect(reply.docs, reply.intafacedCode).toBe(`/developers/errors#${anchor}`);
    }
  });
});
