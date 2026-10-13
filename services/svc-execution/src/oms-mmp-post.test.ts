import { describe, expect, it } from 'vitest';
import { postBothSidesMmpQuote, type OmsMmpPostInput } from './oms-mmp-post.js';

function input(over: Partial<OmsMmpPostInput> = {}): OmsMmpPostInput {
  return {
    parentClientOrderId: 'mmp-1',
    quoteId: 'q-1',
    symbol: 'BTC/USDT',
    bidQuoteId: 'bid-1',
    askQuoteId: 'ask-1',
    mqq: '1',
    bidSize: '5',
    askSize: '5',
    ...over,
  };
}

describe('postBothSidesMmpQuote', () => {
  it('refuses null MQQ with reason mqq_blank; not posted', () => {
    const result = postBothSidesMmpQuote(input({ mqq: null }));
    expect(result).toMatchObject({ ok: false, reason: 'mqq_blank' });
    expect(result).not.toHaveProperty('posted', true);
  });

  it('refuses undefined MQQ with reason mqq_blank; not posted', () => {
    const result = postBothSidesMmpQuote(input({ mqq: undefined }));
    expect(result).toMatchObject({ ok: false, reason: 'mqq_blank' });
    expect(result).not.toHaveProperty('posted', true);
  });

  it('refuses whitespace MQQ with reason mqq_blank; not posted', () => {
    const result = postBothSidesMmpQuote(input({ mqq: '   ' }));
    expect(result).toMatchObject({ ok: false, reason: 'mqq_blank' });
    expect(result).not.toHaveProperty('posted', true);
  });

  it("refuses invalid MQQ 'nope' with reason mqq_invalid", () => {
    const result = postBothSidesMmpQuote(input({ mqq: 'nope' }));
    expect(result).toMatchObject({ ok: false, reason: 'mqq_invalid' });
  });

  it('refuses blank/null bidSize with reason size_blank', () => {
    expect(postBothSidesMmpQuote(input({ bidSize: null }))).toMatchObject({
      ok: false,
      reason: 'size_blank',
    });
    expect(postBothSidesMmpQuote(input({ bidSize: undefined }))).toMatchObject({
      ok: false,
      reason: 'size_blank',
    });
    expect(postBothSidesMmpQuote(input({ bidSize: '' }))).toMatchObject({
      ok: false,
      reason: 'size_blank',
    });
    expect(postBothSidesMmpQuote(input({ bidSize: '  ' }))).toMatchObject({
      ok: false,
      reason: 'size_blank',
    });
  });

  it('refuses blank/null askSize with reason size_blank', () => {
    expect(postBothSidesMmpQuote(input({ askSize: null }))).toMatchObject({
      ok: false,
      reason: 'size_blank',
    });
    expect(postBothSidesMmpQuote(input({ askSize: undefined }))).toMatchObject({
      ok: false,
      reason: 'size_blank',
    });
    expect(postBothSidesMmpQuote(input({ askSize: '' }))).toMatchObject({
      ok: false,
      reason: 'size_blank',
    });
  });

  it("refuses '0' bidSize with reason size_invalid", () => {
    const result = postBothSidesMmpQuote(input({ bidSize: '0' }));
    expect(result).toMatchObject({ ok: false, reason: 'size_invalid' });
    expect(result).not.toHaveProperty('posted', true);
  });

  it("refuses bidSize '0.5' with mqq '1' (ask healthy) with one_sided — never posts ask alone", () => {
    const result = postBothSidesMmpQuote(input({ mqq: '1', bidSize: '0.5', askSize: '5' }));
    expect(result).toMatchObject({ ok: false, reason: 'one_sided' });
    expect(result).not.toHaveProperty('posted', true);
    expect(result).not.toHaveProperty('sides');
  });

  it('refuses askSize below MQQ with one_sided — never posts bid alone', () => {
    const result = postBothSidesMmpQuote(input({ mqq: '1', bidSize: '5', askSize: '0.4' }));
    expect(result).toMatchObject({ ok: false, reason: 'one_sided' });
    expect(result).not.toHaveProperty('posted', true);
    expect(result).not.toHaveProperty('sides');
  });

  it('both sizes equal to MQQ posts both sides — equality is not a breach', () => {
    const result = postBothSidesMmpQuote(input({ mqq: '1', bidSize: '1', askSize: '1' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.posted).toBe(true);
    expect(result.sides).toEqual(['bid', 'ask']);
    expect(result.mqq).toBe('1');
    expect(result.bidSize).toBe('1');
    expect(result.askSize).toBe('1');
    expect(result.parent.parentClientOrderId).toBe('mmp-1');
  });

  it('both sizes above MQQ posts both sides as one live parent — no invented size', () => {
    const result = postBothSidesMmpQuote(input({ mqq: '1', bidSize: '5.25000000', askSize: '7.5' }));
    expect(result).toMatchObject({
      ok: true,
      posted: true,
      parent: { parentClientOrderId: 'mmp-1' },
      quoteId: 'q-1',
      symbol: 'BTC/USDT',
      bidQuoteId: 'bid-1',
      askQuoteId: 'ask-1',
      sides: ['bid', 'ask'],
      mqq: '1',
      bidSize: '5.25000000',
      askSize: '7.5',
    });
    if (!result.ok) return;
    expect(result.sides).toEqual(['bid', 'ask']);
    expect(result.bidSize).toBe('5.25000000');
    expect(result.askSize).toBe('7.5');
  });

  it('refuses missing parentClientOrderId', () => {
    expect(postBothSidesMmpQuote(input({ parentClientOrderId: undefined }))).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(postBothSidesMmpQuote(input({ parentClientOrderId: '' }))).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(postBothSidesMmpQuote(input({ parentClientOrderId: '   ' }))).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
  });

  it('refuses blank quoteId / bidQuoteId / askQuoteId — ids are not invented', () => {
    expect(postBothSidesMmpQuote(input({ quoteId: '' }))).toMatchObject({
      ok: false,
      reason: 'missing_quote_id',
    });
    expect(postBothSidesMmpQuote(input({ quoteId: '   ' }))).toMatchObject({
      ok: false,
      reason: 'missing_quote_id',
    });
    expect(postBothSidesMmpQuote(input({ bidQuoteId: '' }))).toMatchObject({
      ok: false,
      reason: 'missing_quote_id',
    });
    expect(postBothSidesMmpQuote(input({ askQuoteId: undefined }))).toMatchObject({
      ok: false,
      reason: 'missing_quote_id',
    });
  });

  it('does not invent symbol — empty caller symbol stays empty', () => {
    const result = postBothSidesMmpQuote(input({ symbol: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.symbol).toBe('');
  });

  it('result has no flatten or matching field', () => {
    const result = postBothSidesMmpQuote(input());
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('flatten');
    expect(result).not.toHaveProperty('matching');
    expect(result).not.toHaveProperty('positions');
  });
});
