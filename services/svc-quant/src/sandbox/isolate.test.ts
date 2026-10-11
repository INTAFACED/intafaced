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
  return createPaperBook({
    startingCash: '10000',
    venueVaultSet: false,
    marks: { 'BTC-USD': '50000' },
  });
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

  it('does not evaluate expressions in inactive else-if or python if bodies', () => {
    const elseIf = runIsolate(
      'javascript',
      `if (true) { console.log("ok") } else if (market.last("BTC-USD") > 0) { oms.buy("BTC-USD", "0.01") }
console.log("after")`,
      book(),
      limits,
      true,
    );
    expect(elseIf.logs).toEqual(['ok', 'after']);
    expect(elseIf.fills).toEqual([]);
    expect(elseIf.cash).toBe('10000');

    const python = runIsolate(
      'python',
      `if 0:
oms.buy("BTC-USD", market.last("BTC-USD") / 5000000)
print("after")`,
      book(),
      limits,
      true,
    );
    expect(python.logs).toEqual(['after']);
    expect(python.fills).toEqual([]);
    expect(python.cash).toBe('10000');
  });

  it('requires a closing brace before an else branch', () => {
    for (const condition of ['true', 'false']) {
      expect(() =>
        runIsolate(
          'javascript',
          `if (${condition}) { console.log("ok") else { oms.buy("BTC-USD", "0.01") }
console.log("after")`,
          book(),
          limits,
          true,
        ),
      ).toThrow(QUANT_SANDBOX_SYNTAX);
    }
  });

  it('parses nested else branches inside an inactive brace body without running them', () => {
    const innerTrue = runIsolate(
      'javascript',
      `if (false) { if (true) { const x = market.last("BTC-USD"); if (x > 0) { console.log("inner"); oms.buy("BTC-USD", "0.01") } } else { console.log("inner-else"); oms.sell("BTC-USD", "0.01") } }
console.log("after")`,
      book(),
      limits,
      true,
    );
    expect(innerTrue.logs).toEqual(['after']);
    expect(innerTrue.fills).toEqual([]);
    expect(innerTrue.cash).toBe('10000');

    const innerFalseWithOuterElse = runIsolate(
      'javascript',
      `if (false) { if (false) { console.log("inner"); oms.buy("BTC-USD", "0.01") } else { console.log("inner-else"); oms.sell("BTC-USD", "0.01") } } else { console.log("outer-else") }
console.log("after")`,
      book(),
      limits,
      true,
    );
    expect(innerFalseWithOuterElse.logs).toEqual(['outer-else', 'after']);
    expect(innerFalseWithOuterElse.fills).toEqual([]);
    expect(innerFalseWithOuterElse.cash).toBe('10000');
  });

  it('compares amount strings by scaled value and keeps stringify for other text', () => {
    const ran = runIsolate(
      'javascript',
      `console.log(50000 == 50000.0);
console.log(50000 != 50000.0);
console.log(50000 === 50000.0);
console.log(50000 !== 50000.0);
console.log(50000 < 50000.0);
console.log(50000 <= 50000.0);
console.log(50000 > 50000.0);
console.log(50000 >= 50000.0);
console.log(50000 == 50000.1);
console.log(50000 != 50000.1);
console.log("abc" == "abc");
console.log("abc" != "abc");
console.log("abc" == "abd");
console.log("50000" == "abc");`,
      book(),
      limits,
      true,
    );
    expect(ran.logs).toEqual([
      'true',
      'false',
      'true',
      'false',
      'false',
      'true',
      'false',
      'true',
      'false',
      'true',
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(ran.fills).toEqual([]);
    expect(ran.cash).toBe('10000');
  });

  it('does not buy when last price differs from 50000.0 only by trailing zeros', () => {
    const missed = runIsolate('javascript', `if (market.last("BTC-USD") != 50000.0) { oms.buy("BTC-USD", "0.01") }`, book(), limits, true);
    expect(missed.fills).toEqual([]);
    expect(missed.cash).toBe('10000');

    const taken = runIsolate('javascript', `if (market.last("BTC-USD") == 50000.0) { oms.buy("BTC-USD", "0.01") }`, book(), limits, true);
    expect(taken.fills).toHaveLength(1);
    expect(taken.fills[0]?.side).toBe('buy');
    expect(taken.fills[0]?.symbol).toBe('BTC-USD');
    expect(taken.fills[0]?.qty).toBe('0.01');
    expect(taken.fills[0]?.price).toBe('50000');
    expect(taken.fills[0]?.venue).toBe('internal');
    expect(taken.cash).toBe('9500');
  });

  it('treats a zero amount as falsy in if and unary not, and a flat position as empty', () => {
    const zero = runIsolate(
      'javascript',
      `if (0) { oms.buy("BTC-USD", "0.01") }
if (0.0) { oms.buy("BTC-USD", "0.01") }
if (0.00) { oms.buy("BTC-USD", "0.01") }
if ("0") { oms.buy("BTC-USD", "0.01") }
if ("0.0") { oms.buy("BTC-USD", "0.01") }
if ("0.00") { oms.buy("BTC-USD", "0.01") }`,
      book(),
      limits,
      true,
    );
    expect(zero.fills).toEqual([]);
    expect(zero.cash).toBe('10000');

    const tick = runIsolate('javascript', `if (0.01) { oms.buy("BTC-USD", "0.01") }`, book(), limits, true);
    expect(tick.fills).toHaveLength(1);
    expect(tick.fills[0]?.side).toBe('buy');
    expect(tick.fills[0]?.symbol).toBe('BTC-USD');
    expect(tick.fills[0]?.qty).toBe('0.01');
    expect(tick.fills[0]?.price).toBe('50000');
    expect(tick.fills[0]?.venue).toBe('internal');
    expect(tick.cash).toBe('9500');

    const one = runIsolate('javascript', `if (1) { oms.buy("BTC-USD", "0.01") }`, book(), limits, true);
    expect(one.fills).toHaveLength(1);
    expect(one.fills[0]?.side).toBe('buy');
    expect(one.fills[0]?.qty).toBe('0.01');
    expect(one.fills[0]?.price).toBe('50000');
    expect(one.cash).toBe('9500');

    const flags = runIsolate(
      'javascript',
      `if ("") { console.log("empty") }
if ("btc") { console.log("word") }
if (false) { console.log("bool-false") }
if (true) { console.log("bool-true") }
if (!0) { console.log("not-zero") }
if (!0.0) { console.log("not-zero-dot") }
if (!0.00) { console.log("not-zero-cents") }
if (!"0") { console.log("not-str-zero") }
if (!0.01) { console.log("not-tick") }
if (!1) { console.log("not-one") }
if (!"") { console.log("not-empty") }
if (!"btc") { console.log("not-word") }
if (!false) { console.log("not-false") }
if (!true) { console.log("not-true") }
if (0) { console.log("zero") } else { console.log("else-zero") }`,
      book(),
      limits,
      true,
    );
    expect(flags.logs).toEqual([
      'word',
      'bool-true',
      'not-zero',
      'not-zero-dot',
      'not-zero-cents',
      'not-str-zero',
      'not-empty',
      'not-false',
      'else-zero',
    ]);
    expect(flags.fills).toEqual([]);
    expect(flags.cash).toBe('10000');

    const flat = runIsolate(
      'javascript',
      `if (!book.position("BTC-USD")) { console.log("flat"); oms.buy("BTC-USD", "0.01") }
if (!book.position("BTC-USD")) { console.log("again"); oms.buy("BTC-USD", "0.01") }`,
      book(),
      limits,
      true,
    );
    expect(flat.logs).toEqual(['flat']);
    expect(flat.fills).toHaveLength(1);
    expect(flat.fills[0]?.side).toBe('buy');
    expect(flat.fills[0]?.symbol).toBe('BTC-USD');
    expect(flat.fills[0]?.qty).toBe('0.01');
    expect(flat.fills[0]?.price).toBe('50000');
    expect(flat.fills[0]?.venue).toBe('internal');
    expect(flat.cash).toBe('9500');

    const pyMiss = runIsolate(
      'python',
      `if 0:
oms.buy("BTC-USD", "0.01")
if 0.0:
oms.buy("BTC-USD", "0.01")
if 0.00:
oms.buy("BTC-USD", "0.01")
if "0":
oms.buy("BTC-USD", "0.01")
if "":
print("empty")
if "btc":
print("word")
print(book.cash())`,
      book(),
      limits,
      true,
    );
    expect(pyMiss.fills).toEqual([]);
    expect(pyMiss.cash).toBe('10000');
    expect(pyMiss.logs).toEqual(['word', '10000']);

    const pyHit = runIsolate(
      'python',
      `if 0.01:
oms.buy("BTC-USD", "0.01")
print(book.cash())`,
      book(),
      limits,
      true,
    );
    expect(pyHit.fills).toHaveLength(1);
    expect(pyHit.fills[0]?.side).toBe('buy');
    expect(pyHit.fills[0]?.symbol).toBe('BTC-USD');
    expect(pyHit.fills[0]?.qty).toBe('0.01');
    expect(pyHit.fills[0]?.price).toBe('50000');
    expect(pyHit.fills[0]?.venue).toBe('internal');
    expect(pyHit.cash).toBe('9500');
    expect(pyHit.logs).toEqual(['9500']);

    const pyOne = runIsolate(
      'python',
      `if 1:
oms.buy("BTC-USD", "0.01")`,
      book(),
      limits,
      true,
    );
    expect(pyOne.fills).toHaveLength(1);
    expect(pyOne.fills[0]?.qty).toBe('0.01');
    expect(pyOne.fills[0]?.price).toBe('50000');
    expect(pyOne.cash).toBe('9500');
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
