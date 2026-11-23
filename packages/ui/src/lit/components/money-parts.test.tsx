import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssetIcon, hasAssetArt } from './asset-icon.js';
import { CardStack, CardStackLoading } from './card-stack.js';
import { Fold } from './fold.js';
import { HeroFigure, HIDDEN_MASK } from './hero-figure.js';
import { InfoTip } from './info-tip.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const usd = [
  { type: 'currency', value: '$' },
  { type: 'integer', value: '12,468' },
  { type: 'decimal', value: '.' },
  { type: 'fraction', value: '50' },
] as const;

describe('AssetIcon', () => {
  it("draws the kit's art for a listed asset, decorative by default", () => {
    expect(hasAssetArt('btc')).toBe(true);
    const out = html(<AssetIcon asset="btc" />);
    expect(out).toContain('data-asset="BTC"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('<svg');
    expect(out).not.toContain('data-fallback');
  });

  it('draws an honest lettered disc for an unknown asset, never a borrowed logo', () => {
    expect(hasAssetArt('ZZZ')).toBe(false);
    const out = html(<AssetIcon asset="zzz" size="lg" />);
    expect(out).toContain('data-fallback="lettered"');
    expect(out).toContain('data-size="lg"');
    expect(out).toMatch(/>Z<\/span>$/);
    expect(out).not.toContain('<svg');
    expect(html(<AssetIcon asset="" />)).toMatch(/>\?<\/span>$/);
  });

  it('is a named image when it stands alone', () => {
    const out = html(<AssetIcon asset="ETH" label="Ether" />);
    expect(out).toContain('role="img" aria-label="Ether"');
    expect(out).not.toContain('aria-hidden');
  });
});

describe('InfoTip', () => {
  it('is a named button described by its text, which sits in the page whether the bubble is open or not', () => {
    const out = html(<InfoTip text="Prices are 24 hours old." label="About this number" data-testid="tip" />);
    expect(out).toMatch(
      /<button type="button" class="lit-tip__button" data-testid="tip" aria-label="About this number" aria-describedby="([^"]+)-text" aria-expanded="false">/,
    );
    const id = /aria-describedby="([^"]+)"/.exec(out)![1];
    expect(out).toContain(`<span id="${id}" class="lit-sr">Prices are 24 hours old.</span>`);
    // Closed, the bubble is not drawn; the icon is decorative.
    expect(out).not.toContain('lit-tip__bubble');
    expect(out).toContain('<svg viewBox="0 0 24 24" width="16" height="16"');
  });

  it('takes its side as a logical side', () => {
    expect(html(<InfoTip text="t" label="l" side="end" />)).toContain('data-side="end"');
    expect(html(<InfoTip text="t" label="l" />)).toContain('data-side="below"');
  });
});

describe('HeroFigure', () => {
  it('draws the figure at the hero size from its parts', () => {
    const out = html(<HeroFigure parts={usd} hiddenLabel="Balance hidden" unknownLabel="Not available" test data-testid="total" />);
    expect(out).toContain('data-slot="hero-figure" data-testid="total"');
    expect(out).toContain('data-size="hero"');
    expect(out).toContain('<span class="lit-sr" dir="ltr" data-ltr="">$12,468.50</span>');
    expect(out).toContain('>TEST<');
  });

  it('masks the figure when balances are hidden, and never leaks it', () => {
    const out = html(<HeroFigure parts={usd} hidden hiddenLabel="Balance hidden" unknownLabel="Not available" />);
    expect(out).toContain('role="img" aria-label="Balance hidden"');
    expect(out).toContain(HIDDEN_MASK);
    expect(out).not.toContain('12,468');
  });

  it('says there is no figure with a dash, never a zero', () => {
    const out = html(<HeroFigure parts={null} hiddenLabel="Balance hidden" unknownLabel="Not available" />);
    expect(out).toContain('data-unknown="true"');
    expect(out).toContain('aria-label="Not available"');
    expect(out).toContain('>—<');
    expect(out).not.toMatch(/>0</);
  });
});

describe('Fold', () => {
  it('is the native disclosure, closed by default, its words and count in the summary', () => {
    const out = html(
      <Fold title="Small balances" count={3} data-testid="small">
        <p>rows</p>
      </Fold>,
    );
    expect(out).toMatch(/^<details data-testid="small" class="lit-fold">/);
    expect(out).toContain('<summary><span data-part="title">Small balances</span><span data-part="count">3</span>');
    expect(out).toContain('<div data-part="body"><p>rows</p></div>');
    expect(
      html(
        <Fold title="t" open>
          x
        </Fold>,
      ),
    ).toContain('<details open="" class="lit-fold">');
    expect(html(<Fold title="t">x</Fold>)).not.toContain('data-part="count"');
  });
});

describe('CardStack', () => {
  it('draws two named links, the back card first so the front one sits on top', () => {
    const out = html(
      <CardStack
        label="Your holdings"
        data-testid="stack"
        back={{ label: 'Crypto', value: '$3,250.00', href: '/money#crypto' }}
        front={{ label: 'Cash', value: '$9,218.50', href: '/money#cash', mark: <svg /> }}
      />,
    );
    expect(out).toContain('<section data-testid="stack" class="lit-stack" aria-label="Your holdings">');
    expect(out.indexOf('data-card="back"')).toBeLessThan(out.indexOf('data-card="front"'));
    expect(out).toContain(
      '<a class="lit-stack__card" data-card="back" href="/money#crypto"><span data-part="label">Crypto</span><span data-part="peek">$3,250.00</span></a>',
    );
    expect(out).toContain('href="/money#cash"');
    expect(out).toContain('<span data-part="mark"><svg></svg></span>');
  });

  it('keeps its shape while loading, with no words or links, hidden from assistive tech', () => {
    const out = html(<CardStackLoading />);
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain('<a ');
    expect(out).toContain('data-part="skeleton"');
  });
});
