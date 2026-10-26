import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Freshness } from './freshness.js';
import { StatusChip } from './status-chip.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

// TEST timestamps, fixed.
const NOW = Date.UTC(2026, 9, 17, 14, 5, 0);
const AS_OF = '2026-10-17T14:03:07Z';

const expected: Record<Freshness, { word: string; shape: string; tone: string }> = {
  live: { word: 'Live', shape: 'dot', tone: 'text-accent-text' },
  stale: { word: 'Stale', shape: 'ring', tone: 'text-warn' },
  unknown: { word: 'Unknown', shape: 'dashed', tone: 'text-fg-2' },
  refused: { word: 'Refused', shape: 'slashed', tone: 'text-error-text' },
};

describe('StatusChip kinds', () => {
  it.each(Object.keys(expected) as Freshness[])('%s has its word, its shape and role=status', (kind) => {
    const out = html(<StatusChip kind={kind} />);
    expect(out).toContain('role="status"');
    expect(out).toContain(`data-freshness="${kind}"`);
    expect(out).toContain(`data-shape="${expected[kind].shape}"`);
    expect(out).toContain(expected[kind].tone);
    expect(out).toContain(`>${expected[kind].word}<`);
  });
  it('words are overridable', () => {
    const out = html(<StatusChip kind="stale" labels={{ stale: 'Obsolet' }} />);
    expect(out).toContain('>Obsolet<');
    expect(out).not.toContain('>Stale<');
  });
});

describe('StatusChip derived kind', () => {
  const base = { now: NOW, staleAfterMs: 5 * 60_000 };
  it('live when recent', () => {
    expect(html(<StatusChip {...base} asOf={AS_OF} />)).toContain('data-freshness="live"');
  });
  it('stale when older than staleAfterMs', () => {
    expect(html(<StatusChip {...base} asOf={AS_OF} staleAfterMs={60_000} />)).toContain('data-freshness="stale"');
  });
  it('unknown without asOf, refused wins', () => {
    expect(html(<StatusChip {...base} />)).toContain('data-freshness="unknown"');
    expect(html(<StatusChip {...base} asOf={AS_OF} refused />)).toContain('data-freshness="refused"');
  });
});

describe('StatusChip as-of display', () => {
  it('renders "<Word> · as of 14:03:07" inside a time element with dateTime', () => {
    const out = html(<StatusChip {...{ now: NOW, staleAfterMs: 300_000 }} asOf={AS_OF} showAsOf timeZone="UTC" locale="en-GB" />);
    expect(out).toContain('<time dateTime="2026-10-17T14:03:07.000Z"');
    expect(out).toContain('>14:03:07</time>');
    expect(out.replace(/<[^>]+>/g, '')).toContain('Live · as of 14:03:07');
  });
  it('draws no time element unless asked, or when asOf is unusable', () => {
    expect(html(<StatusChip kind="live" asOf={AS_OF} />)).not.toContain('<time');
    expect(html(<StatusChip kind="unknown" asOf="garbage" showAsOf />)).not.toContain('<time');
  });
  it('the as-of word is overridable', () => {
    const out = html(<StatusChip kind="live" asOf={AS_OF} showAsOf asOfLabel="Stand" timeZone="UTC" />);
    expect(out).toContain('Stand');
    expect(out).not.toContain('as of');
  });
});

describe('StatusChip reason', () => {
  it('is in the title and in an sr-only span', () => {
    const out = html(<StatusChip kind="refused" reason="Venue rejected the quote" />);
    expect(out).toContain('title="Venue rejected the quote"');
    expect(out).toContain('<span class="sr-only">Venue rejected the quote</span>');
  });
  it('adds nothing when there is no reason', () => {
    const out = html(<StatusChip kind="unknown" />);
    expect(out).not.toContain('sr-only');
    expect(out).not.toContain('title=');
  });
});

describe('StatusChip density', () => {
  it('dense is text-2xs, comfortable text-xs', () => {
    expect(html(<StatusChip kind="live" density="dense" />)).toContain('text-2xs');
    expect(html(<StatusChip kind="live" density="dense" />)).toContain('data-density="dense"');
    expect(html(<StatusChip kind="live" />)).toContain('text-xs');
  });
});

describe('StatusChip server markup', () => {
  // renderToStaticMarkup never runs effects: with or without `now` it must render once, not throw and schedule nothing.
  it('renders without now (own clock) and still derives the kind', () => {
    const timers: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      timers.push(args);
      return realSetTimeout(...args);
    }) as typeof setTimeout;
    try {
      const out = html(<StatusChip asOf={Date.now()} staleAfterMs={60_000} />);
      expect(out).toContain('data-freshness="live"');
      expect(out).toContain('>Live<');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(timers).toHaveLength(0);
  });
  it('renders with a pinned now, identical on every render', () => {
    const el = <StatusChip asOf={AS_OF} now={NOW} staleAfterMs={60_000} showAsOf timeZone="UTC" locale="en-GB" />;
    expect(html(el)).toBe(html(el));
    expect(html(el)).toContain('data-freshness="stale"');
  });
});
