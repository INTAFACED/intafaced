import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ButtonLink, Display, FeaturedMarket, LiveDot, SectionTitle, Stat, TrustStrip, WarnBadge } from '../index.js';

const html = (n: React.ReactElement) => renderToStaticMarkup(n);

describe('front-page parts', () => {
  it('draws a link as the kit button, never a button element', () => {
    const out = html(
      <ButtonLink tone="primary" size="lg" href="/signup">
        Create account
      </ButtonLink>,
    );
    expect(out).toMatch(
      /^<a href="\/signup" class="lit-button" data-slot="button" data-variant="primary" data-tone="primary" data-size="lg">/,
    );
  });

  it('draws the display headline as one h1 with a dimmed second line', () => {
    const out = html(<Display second="One account.">Every market.</Display>);
    expect(out).toContain('<h1 class="lt-display">');
    expect(out).toContain('lt-display-second">One account.</span>');
    expect(html(<SectionTitle>What&apos;s moving</SectionTitle>)).toContain('<h2 class="lt-section-title">');
  });

  it('greys the live dot when the data is not live', () => {
    expect(html(<LiveDot off>Prices paused</LiveDot>)).toContain('data-off="true"');
  });

  it('draws each trust cell with its title, badge and body', () => {
    const out = html(
      <TrustStrip label="Trust" cells={[{ key: 'r', title: 'Reserves', badge: <WarnBadge>Placeholder</WarnBadge>, body: 'Not yet.' }]} />,
    );
    expect(out).toContain('aria-label="Trust"');
    expect(out).toContain('lt-warn-badge">Placeholder</span>');
    expect(out).toContain('Not yet.');
  });

  it('draws the featured market as a link with its chart in ink filling the tile, and no chart from one point', () => {
    const points = [
      { at: '2026-11-01', value: '1' },
      { at: '2026-11-02', value: '2' },
    ];
    const out = html(
      <FeaturedMarket symbol="BTC" price="$97,240.12" change="+1.84%" points={points} chartLabel="BTC" asset="USD" href="/m/BTC" />,
    );
    expect(out).toContain('<a class="lt-featured" href="/m/BTC">');
    expect(out).toContain('data-fit="true"');
    // The chart is drawn in ink whatever the move (the kit owner's rule, 25 Nov): the colour stays in the change figure.
    expect(out).toContain('data-tone="ink"');
    expect(out).not.toContain('data-tone="up"');
    expect(
      html(<FeaturedMarket symbol="BTC" price={null} change={null} points={points.slice(0, 1)} chartLabel="BTC" asset="USD" />),
    ).not.toContain('lt-chart');
  });

  it('puts a stat label under its figure when asked', () => {
    expect(html(<Stat labelBelow label="markets, TEST" value="412" />)).toContain('data-label-below="true"');
  });
});
