import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { heldStateOf, totalFreshness, type HeldState } from './freshness.js';
import { HeldMark } from './held-mark.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

// TEST timestamps, fixed.
const NOW = Date.UTC(2026, 9, 17, 14, 5, 0);
const FRESH = '2026-10-17T14:04:50Z';
const OLD = '2026-10-17T13:41:07Z';
const LIMIT = 30_000;

describe('heldStateOf', () => {
  it('a fresh figure is known, an old one stale, one with no time not known', () => {
    expect(heldStateOf({ asOf: FRESH, now: NOW, staleAfterMs: LIMIT })).toBe('known');
    expect(heldStateOf({ asOf: OLD, now: NOW, staleAfterMs: LIMIT })).toBe('stale');
    expect(heldStateOf({ asOf: null, now: NOW, staleAfterMs: LIMIT })).toBe('unknown');
    expect(heldStateOf({ asOf: FRESH, now: NOW, staleAfterMs: null })).toBe('unknown');
  });
  it('not known wins over in transit, and in transit over freshness', () => {
    expect(heldStateOf({ asOf: FRESH, now: NOW, staleAfterMs: LIMIT, unknown: true, transit: true })).toBe('unknown');
    expect(heldStateOf({ asOf: OLD, now: NOW, staleAfterMs: LIMIT, transit: true })).toBe('transit');
    expect(heldStateOf({ asOf: null, now: NOW, staleAfterMs: LIMIT, transit: true })).toBe('unknown');
  });
});

describe('totalFreshness', () => {
  it('carries the oldest as-of time among its parts, as that part gave it', () => {
    expect(
      totalFreshness([
        { state: 'known', asOf: FRESH },
        { state: 'transit', asOf: '2026-10-17T14:04:00Z' },
      ]),
    ).toEqual({ state: 'known', asOf: '2026-10-17T14:04:00Z' });
  });
  it('is stale when any part is stale', () => {
    expect(
      totalFreshness([
        { state: 'known', asOf: FRESH },
        { state: 'stale', asOf: OLD },
      ]),
    ).toEqual({ state: 'stale', asOf: OLD });
  });
  it('reads not known when any part is not known, has no time, or there are no parts', () => {
    expect(
      totalFreshness([
        { state: 'known', asOf: FRESH },
        { state: 'unknown', asOf: null },
      ]),
    ).toEqual({ state: 'unknown', asOf: null });
    expect(totalFreshness([{ state: 'known', asOf: 'not a time' }])).toEqual({ state: 'unknown', asOf: null });
    expect(totalFreshness([])).toEqual({ state: 'unknown', asOf: null });
  });
});

const expected: Record<HeldState, { word: string | null; tone: string }> = {
  known: { word: null, tone: 'text-fg-2' },
  stale: { word: 'Stale', tone: 'text-warn' },
  unknown: { word: 'Not known', tone: 'text-fg-2' },
  transit: { word: 'In transit', tone: 'text-accent-text' },
};

describe('HeldMark', () => {
  it.each(Object.keys(expected) as HeldState[])('%s has its own shape, word and tone', (state) => {
    const out = html(<HeldMark state={state} asOf={FRESH} asOfText="As of 14:04:50" />);
    expect(out).toContain(`data-held="${state}"`);
    expect(out).toContain(`data-shape="${state}"`);
    expect(out).toContain(expected[state].tone);
    if (expected[state].word) expect(out).toContain(`>${expected[state].word}<`);
    else expect(out).not.toContain('data-part="word"');
  });
  it('known, stale and in transit keep their time; not known draws none and never a zero', () => {
    for (const state of ['known', 'stale', 'transit'] as const)
      expect(html(<HeldMark state={state} asOf={OLD} asOfText="As of 13:41:07" />)).toContain(`<time dateTime="${OLD}"`);
    const unknown = html(<HeldMark state="unknown" asOf={OLD} />);
    expect(unknown).not.toContain('<time');
    expect(unknown).not.toMatch(/>\s*0(\.0+)?\s*</);
  });
  it('in transit names its route; words and the time element are the screen’s', () => {
    const out = html(
      <HeldMark
        state="transit"
        asOf={FRESH}
        route="From your partner account to your wallet"
        labels={{ transit: 'Unterwegs' }}
        timeProps={{ 'data-testid': 'as-of' } as never}
      />,
    );
    expect(out).toContain('>Unterwegs<');
    expect(out).toContain('From your partner account to your wallet');
    expect(out).toContain('data-testid="as-of"');
  });
});
