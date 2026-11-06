import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoinIcon, inlineCoinArt } from './coin-icon.js';
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

  it('gives every copy its own ids, and each url(#id) points at its own copy', () => {
    const out = html(
      <>
        <CoinIcon asset="BTC" />
        <CoinIcon asset="BTC" />
      </>,
    );
    const ids = [...out.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(out).toContain(`url(#${id})`);
  });

  it('rewrites only the ids the art declares', () => {
    const svg = '<svg><g clip-path="url(#a)"/><defs><clipPath id="a"/></defs><path fill="url(#other)"/></svg>';
    expect(inlineCoinArt(svg, 'u1')).toBe(
      '<svg><g clip-path="url(#a-u1)"/><defs><clipPath id="a-u1"/></defs><path fill="url(#other)"/></svg>',
    );
  });

  it('keeps the lettered circle for an asset without art', () => {
    const out = html(<CoinIcon asset="ifc" />);
    expect(out).toContain('data-fallback="lettered"');
    expect(out).toContain('>I<');
    expect(out).not.toContain('<svg');
  });
});
