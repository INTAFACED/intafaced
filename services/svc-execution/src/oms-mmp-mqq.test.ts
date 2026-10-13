import { describe, expect, it } from 'vitest';
import { cancelBothSidesOnMqqBreach, type OmsMmpMqqLiveQuote } from './oms-mmp-mqq.js';

function quote(over: Partial<OmsMmpMqqLiveQuote> = {}): OmsMmpMqqLiveQuote {
  return {
    quoteId: 'q-1',
    symbol: 'BTC/USDT',
    bidQuoteId: 'bid-1',
    askQuoteId: 'ask-1',
    bidRemaining: '10',
    askRemaining: '10',
    ...over,
  };
}

describe('cancelBothSidesOnMqqBreach', () => {
  it('refuses null MQQ with reason mqq_blank', () => {
    const result = cancelBothSidesOnMqqBreach({ mqq: null, quotes: [quote()] });
    expect(result).toMatchObject({ ok: false, reason: 'mqq_blank' });
  });

  it('refuses undefined MQQ with reason mqq_blank', () => {
    const result = cancelBothSidesOnMqqBreach({ mqq: undefined, quotes: [quote()] });
    expect(result).toMatchObject({ ok: false, reason: 'mqq_blank' });
  });

  it('refuses whitespace MQQ with reason mqq_blank', () => {
    const result = cancelBothSidesOnMqqBreach({ mqq: '   ', quotes: [quote()] });
    expect(result).toMatchObject({ ok: false, reason: 'mqq_blank' });
  });

  it('refuses invalid MQQ with reason mqq_invalid', () => {
    const result = cancelBothSidesOnMqqBreach({ mqq: 'nope', quotes: [quote()] });
    expect(result).toMatchObject({ ok: false, reason: 'mqq_invalid' });
  });

  it('refuses blank bidRemaining with reason remaining_blank', () => {
    const result = cancelBothSidesOnMqqBreach({
      mqq: '1',
      quotes: [quote({ bidRemaining: '' })],
    });
    expect(result).toMatchObject({ ok: false, reason: 'remaining_blank' });
  });

  it('refuses blank askRemaining with reason remaining_blank', () => {
    const result = cancelBothSidesOnMqqBreach({
      mqq: '1',
      quotes: [quote({ askRemaining: '  ' })],
    });
    expect(result).toMatchObject({ ok: false, reason: 'remaining_blank' });
  });

  it('refuses invalid remaining with reason remaining_invalid — does not invent size', () => {
    const result = cancelBothSidesOnMqqBreach({
      mqq: '1',
      quotes: [quote({ bidRemaining: 'nope' })],
    });
    expect(result).toMatchObject({ ok: false, reason: 'remaining_invalid' });
  });

  it('refuses a negative remaining with reason remaining_invalid', () => {
    const result = cancelBothSidesOnMqqBreach({
      mqq: '1',
      quotes: [quote({ askRemaining: '-1' })],
    });
    expect(result).toMatchObject({ ok: false, reason: 'remaining_invalid' });
  });

  it('refuses null, omitted, or non-string bidRemaining without throwing', () => {
    const nullBid = cancelBothSidesOnMqqBreach({
      mqq: '1',
      quotes: [quote({ bidRemaining: null as unknown as string })],
    });
    expect(nullBid).toMatchObject({ ok: false, reason: 'remaining_blank' });

    const { bidRemaining: _omitted, ...omittedBid } = quote();
    const omitted = cancelBothSidesOnMqqBreach({
      mqq: '1',
      quotes: [omittedBid as OmsMmpMqqLiveQuote],
    });
    expect(omitted).toMatchObject({ ok: false, reason: 'remaining_blank' });

    const numeric = cancelBothSidesOnMqqBreach({
      mqq: '1',
      quotes: [quote({ bidRemaining: 10 as unknown as string })],
    });
    expect(numeric).toMatchObject({ ok: false, reason: 'remaining_invalid' });
  });

  it('refuses null, omitted, or non-string askRemaining without throwing', () => {
    const nullAsk = cancelBothSidesOnMqqBreach({
      mqq: '1',
      quotes: [quote({ askRemaining: null as unknown as string })],
    });
    expect(nullAsk).toMatchObject({ ok: false, reason: 'remaining_blank' });

    const { askRemaining: _omitted, ...omittedAsk } = quote();
    const omitted = cancelBothSidesOnMqqBreach({
      mqq: '1',
      quotes: [omittedAsk as OmsMmpMqqLiveQuote],
    });
    expect(omitted).toMatchObject({ ok: false, reason: 'remaining_blank' });

    const numeric = cancelBothSidesOnMqqBreach({
      mqq: '1',
      quotes: [quote({ askRemaining: 4 as unknown as string })],
    });
    expect(numeric).toMatchObject({ ok: false, reason: 'remaining_invalid' });
  });

  it('refuses a null quote in the list without throwing', () => {
    const result = cancelBothSidesOnMqqBreach({
      mqq: '1',
      quotes: [null as unknown as OmsMmpMqqLiveQuote],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('remaining_blank');
  });

  it('cancels BOTH sides when bid remaining is below MQQ and ask is healthy', () => {
    const live = quote({ bidRemaining: '0.5', askRemaining: '10' });
    const result = cancelBothSidesOnMqqBreach({ mqq: '1', quotes: [live] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cancelled).toHaveLength(1);
    expect(result.cancelled[0]).toMatchObject({
      quoteId: 'q-1',
      symbol: 'BTC/USDT',
      bidQuoteId: 'bid-1',
      askQuoteId: 'ask-1',
      sides: ['bid', 'ask'],
      bidRemaining: '0.5',
      askRemaining: '10',
    });
    expect(result.leftStanding).toEqual([]);
  });

  it('cancels BOTH sides when ask remaining is below MQQ and bid is healthy', () => {
    const live = quote({ bidRemaining: '10', askRemaining: '0.4' });
    const result = cancelBothSidesOnMqqBreach({ mqq: '1', quotes: [live] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cancelled[0]?.sides).toEqual(['bid', 'ask']);
    expect(result.cancelled[0]?.quoteId).toBe('q-1');
    expect(result.leftStanding).toEqual([]);
  });

  it('leaves standing when both remaining are at or above MQQ — equality is not a breach', () => {
    const live = quote({ bidRemaining: '1', askRemaining: '2' });
    const result = cancelBothSidesOnMqqBreach({ mqq: '1', quotes: [live] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cancelled).toEqual([]);
    expect(result.leftStanding).toEqual([live]);
    expect(result.mqq).toBe('1');
  });

  it('mixed book: only the breached two-sided quote is cancelled', () => {
    const breached = quote({
      quoteId: 'q-breach',
      bidQuoteId: 'bid-b',
      askQuoteId: 'ask-b',
      bidRemaining: '0.1',
      askRemaining: '5',
    });
    const healthy = quote({
      quoteId: 'q-ok',
      bidQuoteId: 'bid-ok',
      askQuoteId: 'ask-ok',
      bidRemaining: '3',
      askRemaining: '3',
    });
    const result = cancelBothSidesOnMqqBreach({ mqq: '1', quotes: [breached, healthy] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cancelled.map((c) => c.quoteId)).toEqual(['q-breach']);
    expect(result.cancelled[0]?.sides).toEqual(['bid', 'ask']);
    expect(result.leftStanding).toEqual([healthy]);
  });

  it('cancelled.sides is always both bid and ask — never one-sided', () => {
    const result = cancelBothSidesOnMqqBreach({
      mqq: '5',
      quotes: [
        quote({ quoteId: 'q-bid-low', bidRemaining: '1', askRemaining: '9' }),
        quote({ quoteId: 'q-ask-low', bidRemaining: '9', askRemaining: '1' }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cancelled).toHaveLength(2);
    for (const row of result.cancelled) {
      expect(row.sides).toEqual(['bid', 'ask']);
    }
  });

  it('does not invent size: cancelled remaining strings equal the caller input', () => {
    const live = quote({ bidRemaining: '0.25000000', askRemaining: '7.5' });
    const result = cancelBothSidesOnMqqBreach({ mqq: '1', quotes: [live] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cancelled[0]?.bidRemaining).toBe('0.25000000');
    expect(result.cancelled[0]?.askRemaining).toBe('7.5');
  });

  it('result has no flatten or positions field', () => {
    const result = cancelBothSidesOnMqqBreach({ mqq: '1', quotes: [quote()] });
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('flatten');
    expect(result).not.toHaveProperty('positions');
  });
});
