import { describe, expect, it } from 'vitest';
import {
  QUANT_SANDBOX_ESCAPE,
  QUANT_SANDBOX_MAX_OPS_UNSET,
  QUANT_SANDBOX_MAX_SOURCE_UNSET,
  QUANT_SANDBOX_SYNTAX,
  QUANT_SANDBOX_UNWIRED,
} from '../errors.js';
import { createPaperBook } from './book.js';
import { runIsolate } from './isolate.js';

const limits = { maxOps: 5_000, maxSource: 8_000 };

function book() {
  return createPaperBook({ startingCash: '10000', venueVaultSet: false });
}

describe('strategy isolate', () => {
  it('runs five lines of javascript against the internal book', () => {
    const b = book();
    const ran = runIsolate(
      'javascript',
      `const px = market.last("BTC-USD");
oms.buy("BTC-USD", "0.01");
console.log(px);
console.log(book.cash());
console.log(book.pnl());`,
      b,
      limits,
      true,
    );
    expect(ran.logs[0]).toBe('50000');
    expect(ran.cash).toBe('9500');
    expect(ran.pnl).toBe('0');
    expect(typeof ran.pnl).toBe('string');
  });

  it('runs five lines of python against the same book', () => {
    const b = book();
    const ran = runIsolate(
      'python',
      `px = market.last("BTC-USD")
oms.buy("BTC-USD", "0.01")
print(px)
print(book.cash())
print(book.pnl())`,
      b,
      limits,
      true,
    );
    expect(ran.logs[0]).toBe('50000');
    expect(ran.cash).toBe('9500');
    expect(ran.pnl).toBe('0');
  });

  it('does not place a paper order from a false python if, and runs a true body once', () => {
    const missedBuy = runIsolate(
      'python',
      `if 1 == 0:
oms.buy("BTC-USD", "0.01")
print(book.cash())`,
      book(),
      limits,
      true,
    );
    expect(missedBuy.fills).toEqual([]);
    expect(missedBuy.cash).toBe('10000');
    expect(missedBuy.logs).toEqual(['10000']);

    const missedSell = runIsolate(
      'python',
      `if 1 == 0:
oms.sell("BTC-USD", "0.01")`,
      book(),
      limits,
      true,
    );
    expect(missedSell.fills).toEqual([]);
    expect(missedSell.cash).toBe('10000');

    const taken = runIsolate(
      'python',
      `if 1 == 1:
oms.buy("BTC-USD", "0.01")
print(book.cash())`,
      book(),
      limits,
      true,
    );
    expect(taken.fills).toHaveLength(1);
    expect(taken.fills[0]?.side).toBe('buy');
    expect(taken.fills[0]?.symbol).toBe('BTC-USD');
    expect(taken.fills[0]?.qty).toBe('0.01');
    expect(taken.cash).toBe('9500');
    expect(taken.logs).toEqual(['9500']);
  });

  it('does not treat a return inside a brace else as an unconditional exit', () => {
    const taken = runIsolate(
      'javascript',
      `if (true) { console.log("ok") } else { oms.buy("BTC-USD", "0.01"); return }
console.log("after")`,
      book(),
      limits,
      true,
    );
    expect(taken.logs).toEqual(['ok', 'after']);
    expect(taken.fills).toEqual([]);
    expect(taken.cash).toBe('10000');

    const elseReturns = runIsolate(
      'javascript',
      `if (false) { oms.buy("BTC-USD", "0.01") } else { console.log("else"); return }
console.log("after")`,
      book(),
      limits,
      true,
    );
    expect(elseReturns.logs).toEqual(['else']);
    expect(elseReturns.fills).toEqual([]);
    expect(elseReturns.cash).toBe('10000');

    const elseBuys = runIsolate(
      'javascript',
      `if (false) { console.log("no") } else { oms.buy("BTC-USD", "0.01") }
console.log(book.cash())`,
      book(),
      limits,
      true,
    );
    expect(elseBuys.fills).toHaveLength(1);
    expect(elseBuys.fills[0]?.side).toBe('buy');
    expect(elseBuys.cash).toBe('9500');
    expect(elseBuys.logs).toEqual(['9500']);
  });

  it('refuses an unclosed false brace if instead of dropping later orders', () => {
    expect(() =>
      runIsolate(
        'javascript',
        `if (false) { oms.buy("BTC-USD", "0.01")
oms.buy("BTC-USD", "0.01")`,
        book(),
        limits,
        true,
      ),
    ).toThrow(QUANT_SANDBOX_SYNTAX);
  });

  it('refuses when the isolate is unwired rather than inventing pnl', () => {
    expect(() => runIsolate('javascript', 'console.log("x")', book(), limits, false)).toThrow(QUANT_SANDBOX_UNWIRED);
  });
});

describe('sandbox escape', () => {
  it('refuses fetch', () => {
    expect(() => runIsolate('javascript', 'fetch("https://evil.example")', book(), limits, true)).toThrow(QUANT_SANDBOX_ESCAPE);
  });

  it('refuses require', () => {
    expect(() => runIsolate('javascript', 'require("fs")', book(), limits, true)).toThrow(QUANT_SANDBOX_ESCAPE);
  });

  it('refuses python import', () => {
    expect(() => runIsolate('python', 'import os', book(), limits, true)).toThrow(QUANT_SANDBOX_ESCAPE);
  });

  it('refuses constructor walks', () => {
    expect(() => runIsolate('javascript', 'console.constructor', book(), limits, true)).toThrow(QUANT_SANDBOX_ESCAPE);
  });
});

describe('unpublished isolate ceilings', () => {
  it('refuses unset maxOps before interpreting — never unbounded-loop', () => {
    expect(() => runIsolate('javascript', 'console.log("x")', book(), { maxOps: undefined, maxSource: 8_000 }, true)).toThrow(
      QUANT_SANDBOX_MAX_OPS_UNSET,
    );
  });

  it('refuses unset maxSource before interpreting — never invent 8000', () => {
    expect(() => runIsolate('javascript', 'console.log("x")', book(), { maxOps: 5_000, maxSource: undefined }, true)).toThrow(
      QUANT_SANDBOX_MAX_SOURCE_UNSET,
    );
  });
});
