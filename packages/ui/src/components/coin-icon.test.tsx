import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoinIcon } from './coin-icon.js';
import { coinArt } from './coins/coin-art.generated.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('CoinIcon artwork', () => {
  it('draws the art inline and loads nothing: no img and no data: URL (#7216)', () => {
    for (const asset of Object.keys(coinArt)) {
      const out = html(<CoinIcon asset={asset} />);
      expect(out, asset).toContain(`data-asset="${asset}"`);
      expect(out, asset).toContain('<svg ');
      expect(out, asset).not.toContain('<img');
      expect(out, asset).not.toContain('data:');
    }
  });

  it('holds no id, so many copies on one page never share one', () => {
    const out = html(
      <>
        <CoinIcon asset="BTC" />
        <CoinIcon asset="BTC" />
      </>,
    );
    expect(out.match(/<svg /g)).toHaveLength(2);
    expect(out).not.toMatch(/\sid=/);
  });

  it('keeps the lettered circle for an asset without art', () => {
    const out = html(<CoinIcon asset="ifc" />);
    expect(out).toContain('data-fallback="lettered"');
    expect(out).toContain('>I<');
    expect(out).not.toContain('<svg');
  });
});
