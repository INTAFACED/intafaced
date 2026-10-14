import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, ToolApi } from '../buy/deps';
import { convertRefusal, fetchQuote, OVER_COST_CODE, refusesQuoteQty, type Quote, type QuoteRequest } from './convert-flow';
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
  const convertQuote = vi.fn(async (input: { qty?: string }): Promise<ApiResult<Quote>> => {
    asked.push(input.qty!);
    return { ok: true, data: quoteFor(input.qty!) };
  });
  return { asked, tools: { convertQuote } as unknown as ToolApi };
};
const request = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  symbol: 'ETH/USDT',
  side: 'buy',
  qty: '0.0038',
  typed: '10',
  cap: '10',
  spend: null,
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

type Asked = { qty?: string; quoteQty?: string; side: string };
/** A service that knows `quoteQty`: the biggest whole number of lots whose cost, spread included, fits the spend. */
const spendTools = (answer?: (input: Asked) => ApiResult<Quote> | null) => {
  const asked: Asked[] = [];
  const convertQuote = vi.fn(async (input: Asked): Promise<ApiResult<Quote>> => {
    asked.push(input);
    const custom = answer?.(input);
    if (custom) return custom;
    if (input.quoteQty === undefined) return { ok: true, data: quoteFor(input.qty!) };
    let lots = 0n;
    const lot = dec('0.0001')!;
    while (dec(quoteFor(str((lots + 1n) * lot)).inAmount)! <= dec(input.quoteQty)!) lots += 1n;
    return { ok: true, data: quoteFor(str(lots * lot)) };
  });
  return { asked, tools: { convertQuote } as unknown as ToolApi };
};
const oldServer = {
  ok: false as const,
  reason: 'error' as const,
  message: 'Invalid input: expected string, received undefined',
  code: 'BAD_REQUEST',
  status: 400,
};

describe('typing the spend asks for quoteQty, exactly what was typed', () => {
  it('sends the typed decimal as quoteQty with no qty, and gets a quote that costs at most that', async () => {
    const t = spendTools();
    const result = await fetchQuote(t.tools, request({ spend: '10', cap: '10' }));
    expect(t.asked).toEqual([{ symbol: 'ETH/USDT', side: 'buy', quoteQty: '10' }]);
    expect(result.ok && dec(result.data.inAmount)! <= dec('10')!).toBe(true);
  });

  it('sends the balance when it is lower than what was typed (never quote what the customer cannot pay)', async () => {
    const t = spendTools();
    await fetchQuote(t.tools, request({ spend: '50', cap: '9.5' }));
    expect(t.asked).toEqual([{ symbol: 'ETH/USDT', side: 'buy', quoteQty: '9.5' }]);
  });

  it('keeps qty for a sell', async () => {
    const t = spendTools();
    await fetchQuote(t.tools, request({ side: 'sell', qty: '0.01', typed: '0.01', cap: '0.01', spend: null }));
    expect(t.asked).toEqual([{ symbol: 'ETH/USDT', side: 'sell', qty: '0.01' }]);
  });

  it('never offers a quote that costs more than the spend, even if the service sent one', async () => {
    const t = spendTools((input) => (input.quoteQty ? { ok: true, data: quoteFor('0.0039') } : null));
    const result = await fetchQuote(t.tools, request({ spend: '10', cap: '10' }));
    expect(result).toMatchObject({ ok: false, code: OVER_COST_CODE });
  });

  it('passes a depth or minimum refusal straight through, with no second try by coin amount', async () => {
    const depth = {
      ok: false as const,
      reason: 'error' as const,
      message: 'insufficient book depth to spend 99999',
      code: 'trade.convert_insufficient_depth',
    };
    const t = spendTools(() => depth);
    expect(await fetchQuote(t.tools, request({ spend: '99999', cap: '99999' }))).toEqual(depth);
    expect(t.asked).toHaveLength(1);
    const min = { ok: false as const, reason: 'error' as const, message: 'below the minimum', code: 'trade.below_min_notional' };
    const m = spendTools(() => min);
    expect(await fetchQuote(m.tools, request({ spend: '0.2', cap: '0.2' }))).toEqual(min);
    expect(m.asked).toHaveLength(1);
  });
});

describe('an older trade service that refuses quoteQty', () => {
  it('falls back to the coin-amount search and still never costs more than typed', async () => {
    const t = spendTools((input) => (input.quoteQty !== undefined ? oldServer : null));
    const result = await fetchQuote(t.tools, request({ spend: '9.9', cap: '9.9', typed: '9.9' }));
    expect(t.asked[0]).toEqual({ symbol: 'ETH/USDT', side: 'buy', quoteQty: '9.9' });
    expect(t.asked.slice(1).every((input) => input.qty !== undefined && input.quoteQty === undefined)).toBe(true);
    expect(result.ok && dec(result.data.inAmount)! <= dec('9.9')!).toBe(true);
    expect(result.ok && result.data.requestedQty).toBe('0.0037');
  });

  it('also falls back on trade.convert_invalid_qty, and stops trying quoteQty once a service was seen to refuse it', async () => {
    const invalid = {
      ok: false as const,
      reason: 'error' as const,
      message: 'convert takes one of qty',
      code: 'trade.convert_invalid_qty',
    };
    const t = spendTools((input) => (input.quoteQty !== undefined ? invalid : null));
    const first = await fetchQuote(t.tools, request({ spend: '10', cap: '10' }));
    expect(first.ok).toBe(true);
    const same = spendTools((input) => (input.quoteQty !== undefined ? oldServer : null));
    await fetchQuote(same.tools, request({ spend: '10', cap: '10' }));
    const before = same.asked.length;
    await fetchQuote(same.tools, request({ spend: '10', cap: '10' }));
    expect(same.asked.slice(before).every((input) => input.quoteQty === undefined)).toBe(true);
  });

  it('reads only those refusals as "old server"', () => {
    expect(refusesQuoteQty(oldServer)).toBe(true);
    expect(refusesQuoteQty({ ...oldServer, code: 'trade.convert_insufficient_depth' })).toBe(false);
    expect(refusesQuoteQty({ ...oldServer, message: 'insufficient book depth to convert' })).toBe(false);
    expect(refusesQuoteQty({ ...oldServer, code: 'tier.insufficient' })).toBe(false);
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
