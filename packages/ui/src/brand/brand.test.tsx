import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandIris, BrandLockup, BrandMark, BrandWordmark, brandDrawing } from './brand.js';
import { BRAND_GEOMETRY } from './geometry.generated.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const script = fileURLToPath(new URL('../../scripts/brand-sync.mjs', import.meta.url));
const kit = (name: string) => readFileSync(fileURLToPath(new URL(`../../brand/${name}`, import.meta.url)), 'utf8');

describe('brand', () => {
  it('generated geometry and every app copy match the kit files in packages/ui/brand', () => {
    expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('draws the kit paths as they are', () => {
    expect(kit('mark.svg')).toContain(BRAND_GEOMETRY.mark.master);
    expect(kit('mark-small.svg')).toContain(BRAND_GEOMETRY.mark.small);
    expect(kit('mark-micro.svg')).toContain(BRAND_GEOMETRY.mark.micro);
    expect(kit('wordmark.svg')).toContain(BRAND_GEOMETRY.wordmark.d);
  });

  it('picks the optical drawing for the size: master from 64, small from 24, micro below', () => {
    expect([brandDrawing(16), brandDrawing(23), brandDrawing(24), brandDrawing(63), brandDrawing(64)]).toEqual([
      'micro',
      'micro',
      'small',
      'small',
      'master',
    ]);
    expect(html(<BrandMark size={20} />)).toContain(`d="${BRAND_GEOMETRY.mark.micro}"`);
    expect(html(<BrandMark size={32} />)).toContain(`d="${BRAND_GEOMETRY.mark.small}"`);
    expect(html(<BrandMark size={96} />)).toContain(`d="${BRAND_GEOMETRY.mark.master}"`);
  });

  it('never draws below the kit minimums', () => {
    expect(html(<BrandMark size={8} />)).toContain('width="16"');
    expect(html(<BrandLockup size={12} />)).toContain('height="24"');
    expect(html(<BrandWordmark width={60} />)).toContain('width="150"');
  });

  it('takes its colour from the text around it, never a raw value', () => {
    for (const el of [<BrandMark />, <BrandWordmark />, <BrandLockup />, <BrandLockup layout="stacked" size={64} />, <BrandIris />]) {
      const out = html(el);
      expect(out).toContain('fill="currentColor"');
      expect(out).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it('a lockup is named once; a bare mark is hidden unless it is given a name', () => {
    expect(html(<BrandLockup />)).toContain('aria-label="INTAFACED"');
    expect(html(<BrandMark />)).toContain('aria-hidden="true"');
    expect(html(<BrandMark title="INTAFACED" />)).toContain('role="img"');
  });

  it('the horizontal lockup uses the top-bar drawing under 64 pixels and the master from 64', () => {
    expect(html(<BrandLockup size={24} />)).toContain(`d="${BRAND_GEOMETRY.mark.small}"`);
    expect(html(<BrandLockup size={64} />)).toContain(`d="${BRAND_GEOMETRY.mark.master}"`);
  });

  it('the iris turns eight copies of one blade, and never in the micro drawing', () => {
    const out = html(<BrandIris size={12} />);
    expect(out.match(/class="brand-iris__blade"/g)).toHaveLength(8);
    expect(out).toContain('width="24"');
    expect(out).toContain(`d="${BRAND_GEOMETRY.blade.small.d}"`);
  });

  it('the iris respects reduced motion and never loops faster than a second', () => {
    const css = readFileSync(fileURLToPath(new URL('./brand.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
    for (const m of css.matchAll(/animation: brand-iris-\w+ (\d+)ms[^;]*infinite/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(1000);
  });
});
