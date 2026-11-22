import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardStack, CoinMark, InfoTip } from './b2-overview.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('CardStack', () => {
  it('draws the back card then the front card, each a link to its part, named as one region', () => {
    const out = html(
      <CardStack
        label="Your holdings"
        testId="stack"
        back={{ label: 'Crypto', href: '/money#crypto', value: '$1.00' }}
        front={{ label: 'Cash', href: '/money#cash', value: '$2.00' }}
      />,
    );
    expect(out).toContain('<section class="lt-card-stack" aria-label="Your holdings" data-testid="stack">');
    expect(out.indexOf('href="/money#crypto"')).toBeLessThan(out.indexOf('href="/money#cash"'));
    expect(out).toContain('<span class="lt-card-stack-figure">$2.00</span>');
  });

  it('keeps its shape while loading, hidden from assistive tech, with no figure and no link', () => {
    const out = html(<CardStack label="Your holdings" loading />);
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('lt-ghost');
    expect(out).not.toContain('href=');
  });
});

describe('InfoTip', () => {
  it('is a named key whose description is the rule, in the page whether or not the bubble is open', () => {
    const out = html(<InfoTip text="How it is worked out" label="About the total" testId="tip" />);
    expect(out).toMatch(
      /<button type="button" class="lt-tip-key" data-testid="tip" aria-label="About the total" aria-describedby="([^"]+)"/,
    );
    const id = /aria-describedby="([^"]+)"/.exec(out)![1];
    expect(out).toContain(`<span id="${id}" class="lt-sr">How it is worked out</span>`);
    expect(out).not.toContain('lt-tip-bubble');
  });
});

describe('CoinMark', () => {
  it('draws the kit artwork for a listed coin and a letter for any other, both decorative', () => {
    expect(html(<CoinMark asset="btc" />)).toContain('data-asset="BTC" data-size="row"><span class="lt-coin-art" aria-hidden="true">');
    const other = html(<CoinMark asset="zzz" size="card" />);
    expect(other).toContain('data-fallback="lettered" aria-hidden="true">Z</span>');
  });
});
