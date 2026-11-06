import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderCoinArt, withoutFullClip } from './generate.js';
import { coinArt } from './coin-art.generated.js';

const dir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8')) as {
  assets: Record<string, { file: string | null; licence: string; source: string; commit?: string; fallback?: string }>;
};

describe('coin manifest', () => {
  it('lists exactly BTC, ETH, USDT, USDC and IFC', () => {
    expect(Object.keys(manifest.assets).sort()).toEqual(['BTC', 'ETH', 'IFC', 'USDC', 'USDT']);
  });

  it('records source and licence for every asset, and a commit for every copied file', () => {
    for (const [asset, a] of Object.entries(manifest.assets)) {
      expect(a.licence, asset).toBeTruthy();
      expect(a.source, asset).toBeTruthy();
      if (a.file) expect(a.commit, asset).toMatch(/^[0-9a-f]{40}$/);
      else expect(a.fallback, asset).toBe('lettered');
    }
  });

  it('only uses MIT or CC0 artwork', () => {
    for (const a of Object.values(manifest.assets).filter((x) => x.file)) expect(['MIT', 'CC0-1.0']).toContain(a.licence);
  });

  it('generated art is in sync with the SVG files', () => {
    expect(readFileSync(`${dir}/coin-art.generated.ts`, 'utf8')).toBe(renderCoinArt(dir));
    expect(Object.keys(coinArt).sort()).toEqual(['BTC', 'ETH', 'USDC', 'USDT']);
  });

  it('SVG files contain no script, event handler or external reference', () => {
    for (const svg of Object.values(coinArt)) {
      expect(svg).toMatch(/^<svg /);
      expect(svg).not.toMatch(/<script|\son[a-z]+=|<foreignObject|xlink:href|href="http/i);
      // Drawn inline once per icon: no id to repeat, and nothing pointing at one.
      expect(svg).not.toMatch(/\sid\s*=|url\(|href\s*=/i);
    }
  });

  it('strips only a clip the size of the whole picture, and refuses any other id', () => {
    const clipped =
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><g clip-path="url(#c)"><path d="M0 0"/></g><defs><clipPath id="c"><rect width="24" height="24" fill="white"/></clipPath></defs></svg>';
    expect(withoutFullClip(clipped, 't.svg')).toBe(
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none">\n<path d="M0 0"/>\n</svg>',
    );
    expect(() =>
      withoutFullClip(clipped.replace('width="24" height="24" fill="white"', 'width="12" height="24" fill="white"'), 't.svg'),
    ).toThrow(/no id/);
    expect(() => withoutFullClip('<svg viewBox="0 0 24 24"><linearGradient id="g"/><path fill="url(#g)"/></svg>', 'g.svg')).toThrow(
      /no id/,
    );
  });
});
