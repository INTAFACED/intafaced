import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, ToolApi } from '../buy/deps';
import { convertRefusal, fetchQuote, OVER_COST_CODE, type Quote, type QuoteRequest } from './convert-flow';
import { spendCap, steppedDownQty } from './convert-model';
import { dec, divDown, mulDown, str } from '../buy/trade-math';

const ASK = '2602.84';
/** A firm quote the way the service prices it: the book price PLUS the spread, so it costs more than qty x ask. */
const quoteFor = (qty: string, spreadBps = 20): Quote => {
  const book = mulDown(dec(qty)!, dec(ASK)!);
  const user = book + (book * BigInt(spreadBps)) / 10_000n;
  const now = Date.now();
  return {
    quoteId: `q-${qty}`,
    symbol: 'ETH/USDT',
    side: 'buy',
    requestedQty: qty,
    filledQty: qty,
    bookNotional: str(book),
    userNotional: str(user),
    avgPrice: str(divDown(user, dec(qty)!)!),
    fullyFilled: true,
    convertSpreadBps: spreadBps,
    expiresAt: new Date(now + 15_000).toISOString(),
    source: { kind: 'book', symbol: 'ETH/USDT', asOf: new Date(now).toISOString() },
    inAsset: 'USDT',
    outAsset: 'ETH',
    inAmount: str(user),
    outAmount: qty,
  } as Quote;
};
const tools = () => {
  const asked: string[] = [];
  const convertQuote = vi.fn(async (input: { qty: string }): Promise<ApiResult<Quote>> => {
    asked.push(input.qty);
    return { ok: true, data: quoteFor(input.qty) };
  });
  return { asked, tools: { convertQuote } as unknown as ToolApi };
};
const request = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  symbol: 'ETH/USDT',
  side: 'buy',
  qty: '0.0038',
  typed: '10',
  cap: '10',
  lot: '0.0001',
  pair: 'ETH/USDT',
  ...over,
});

describe('a quote never costs more than the budget (our spread is added on top)', () => {
  it('steps DOWN when the spread pushes the first quote over what was typed', async () => {
    // 10 USDT / 2602.84 = 0.003841 -> 0.0038 lots; 0.0039 would cost 10.17 with spread. Max-style: typed = cap = 9.9.
    const t = tools();
    const result = await fetchQuote(t.tools, request({ typed: '9.9', cap: '9.9' }));
    expect(t.asked[0]).toBe('0.0038'); // 0.0038 x 2602.84 x 1.002 = 9.9106 > 9.9
    expect(result.ok && dec(result.data.inAmount)! <= dec('9.9')!).toBe(true);
    expect(result.ok && result.data.requestedQty).toBe('0.0037');
  });

  it('gives up with "over cost" rather than return a dearer quote when no whole lot fits', async () => {
    const t = tools();
    const result = await fetchQuote(t.tools, request({ qty: '0.0001', typed: '0.2', cap: '0.2' }));
    expect(result).toMatchObject({ ok: false, code: OVER_COST_CODE });
  });

  it('is capped by the available balance, not only by what was typed', async () => {
    const t = tools();
    const result = await fetchQuote(t.tools, request({ typed: '50', cap: '9.9', qty: '0.0191' }));
    expect(result.ok && dec(result.data.inAmount)! <= dec('9.9')!).toBe(true);
  });

  it('tightens UP once when the first quote falls well short, and keeps it only if it still fits', async () => {
    const t = tools();
    const result = await fetchQuote(t.tools, request({ qty: '0.003', typed: '10', cap: '10' }));
    expect(t.asked).toEqual(['0.003', '0.0038']);
    expect(result.ok && result.data.requestedQty).toBe('0.0038');
  });

  it('never asks more than twice for a step down, and sell quotes are untouched', async () => {
    const t = tools();
    await fetchQuote(t.tools, request({ typed: '9.9', cap: '9.9' }));
    expect(t.asked.length).toBeLessThanOrEqual(3);
    const s = tools();
    await fetchQuote(s.tools, request({ side: 'sell', qty: '0.01', typed: '0.01', cap: '0.01' }));
    expect(s.asked).toEqual(['0.01']);
  });
});

describe('step-down and cap helpers', () => {
  it('steps strictly smaller, in lots, proportional to the overshoot', () => {
    expect(steppedDownQty({ qty: '0.0038', spent: '9.9106', cap: '9.9', lot: '0.0001' })).toBe('0.0037');
    expect(steppedDownQty({ qty: '0.0001', spent: '0.26', cap: '0.2', lot: '0.0001' })).toBeNull();
    expect(steppedDownQty({ qty: '0.0038', spent: '9', cap: '10', lot: '0.0001' })).toBeNull();
  });
  it('caps at the smaller of typed and available', () => {
    expect(spendCap('10', '9.5')).toBe('9.5');
    expect(spendCap('10', '50')).toBe('10');
    expect(spendCap('10', null)).toBe('10');
    expect(spendCap('x', '5')).toBeNull();
  });
});

describe('convertRefusal tells the customer’s shortage from ours', () => {
  const insufficient = { ok: false as const, reason: 'error' as const, message: 'x', code: 'ledger.insufficient_funds' };
  it('says "Not enough <asset>" when the quote costs more than the customer holds', () => {
    const copy = convertRefusal(insufficient, { asset: 'USDT', available: '9.5' }, true);
    expect(copy.title).toBe('Not enough USDT');
    expect(copy.body).toBe('You have 9.5 USDT available.');
  });
  it('keeps the plain generic copy, with Help, when the shortage is ours', () => {
    const copy = convertRefusal(insufficient, { asset: 'USDT', available: '9993' }, false);
    expect(copy.title).toBe("This can't be done right now");
    expect(copy.title).not.toMatch(/Not enough/);
  });
  it('leaves every other refusal to the shared words', () => {
    expect(convertRefusal({ ok: false, reason: 'forbidden', message: 'x', code: 'tier.insufficient' }, {}, true).title).toBe(
      'Verify your identity first',
    );
  });
});
