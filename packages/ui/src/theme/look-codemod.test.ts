import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scales, transform } from '../../../../tooling/scripts/look-codemod.mjs';
import { renderTokensCss } from './tokens.js';

const s = scales(renderTokensCss());
const run = (css: string) => transform(css, s).css;

describe('look codemod (tooling/scripts/look-codemod.mjs): px onto tokens of the same value', () => {
  it('reads the scales from the generated tokens, with fixed tie-breaks', () => {
    expect(s.space.get('12px')).toBe('--if-space-3');
    expect(s.space.get('6px')).toBe('--if-space-1-5');
    expect(s.text.get('12px')).toBe('--if-text-xs');
    expect(s.leading.get('28px')).toBe('--if-leading-lg');
    expect(s.radius.get('999px')).toBe('--if-r-pill');
  });

  it('moves spacing, type sizes and radii, and leaves geometry alone', () => {
    const css = [
      '.a {',
      '  padding: 12px 16px;',
      '  margin: 0 auto 24px;',
      '  gap: 8px 6px;',
      '  font: 600 14px/20px var(--if-font-ui);',
      '  font-size: 13px;',
      '  line-height: 18px;',
      '  border-radius: 8px;',
      '  width: 24px;',
      '  border: 1px solid var(--if-line);',
      '  grid-template-columns: 44px 1fr;',
      '}',
    ].join('\n');
    expect(run(css)).toBe(
      [
        '.a {',
        '  padding: var(--if-space-3) var(--if-space-4);',
        '  margin: 0 auto var(--if-space-6);',
        '  gap: var(--if-space-2) var(--if-space-1-5);',
        '  font: 600 var(--if-text-base)/var(--if-leading-base) var(--if-font-ui);',
        '  font-size: var(--if-text-sm);',
        '  line-height: var(--if-leading-sm);',
        '  border-radius: var(--if-r-sm);',
        '  width: 24px;',
        '  border: 1px solid var(--if-line);',
        '  grid-template-columns: 44px 1fr;',
        '}',
      ].join('\n'),
    );
  });

  it('leaves off-scale and negative values, selectors and @media as written', () => {
    const css = '@media (max-width: 760px) {\n  .b:hover {\n    padding: 7px;\n    margin-top: -8px;\n    font-size: 15px;\n  }\n}';
    expect(run(css)).toBe(css);
  });

  it('moves the older customer names whose kit token has the same value', () => {
    expect(
      run('.c {\n  padding: var(--spacing-12) var(--spacing-44);\n  font-size: var(--text-14);\n  border-color: var(--color-accent);\n}'),
    ).toBe('.c {\n  padding: var(--if-space-3) var(--spacing-44);\n  font-size: var(--if-text-base);\n  border-color: var(--if-lime);\n}');
  });

  it('moves the accent as text colour onto accent-text, and leaves accent fills and borders alone', () => {
    expect(
      run(
        '.a {\n  color: var(--if-lime);\n  caret-color: var(--tb-lime);\n  text-decoration-color: var(--color-accent);\n  background: var(--if-lime);\n  border: 1px solid var(--if-lime);\n  color: var(--if-on-lime);\n  color: var(--if-lime-hover);\n}',
      ),
    ).toBe(
      '.a {\n  color: var(--if-accent-text);\n  caret-color: var(--if-accent-text);\n  text-decoration-color: var(--if-accent-text);\n  background: var(--if-lime);\n  border: 1px solid var(--if-lime);\n  color: var(--if-on-lime);\n  color: var(--if-lime-hover);\n}',
    );
  });

  it('keeps a fallback, covers the vendor text fill, counts each value once, and leaves --if-accent (orange in the console)', () => {
    const out = transform(
      '.b {\n  color: var(--if-lime, #c8f64a);\n  -webkit-text-fill-color: var(--tb-lime);\n  color: var(--color-accent);\n  color: var(--if-accent);\n  --x: var(--if-lime);\n}',
      s,
    );
    expect(out.css).toBe(
      '.b {\n  color: var(--if-accent-text, #c8f64a);\n  -webkit-text-fill-color: var(--if-accent-text);\n  color: var(--if-accent-text);\n  color: var(--if-accent);\n  --x: var(--if-lime);\n}',
    );
    expect(out.changed).toBe(3);
  });

  it('keeps --color-background, which the light theme still overrides', () => {
    expect(run('.d {\n  background: var(--color-background);\n}')).toBe('.d {\n  background: var(--color-background);\n}');
  });

  it('maps an older size name only in a property of its family, and only if it was ever defined', () => {
    const css =
      '.f {\n  width: var(--spacing-28);\n  outline-offset: var(--spacing-4);\n  padding: var(--spacing-24, 24px) var(--spacing-8, 8px) var(--spacing-12, 3px);\n}';
    expect(run(css)).toBe(
      '.f {\n  width: var(--spacing-28);\n  outline-offset: var(--spacing-4);\n  padding: var(--spacing-24, var(--if-space-6)) var(--if-space-2) var(--if-space-3, 3px);\n}',
    );
  });

  it('leaves hero sizes, custom properties, two-declaration lines and commented lines alone', () => {
    const css = '.g {\n  font-size: 48px;\n  --card-radius: 12px;\n  padding: 8px; width: 12px;\n  margin: 8px; /* 12px on phones */\n}';
    expect(run(css)).toBe(css);
  });

  it('ignores the values of looks other than the default', () => {
    const withLook = `${renderTokensCss()}\n:root:where([data-look='x']) {\n  --if-text-xs: 13px;\n  --if-space-3: 13px;\n}\n`;
    expect(scales(withLook)).toEqual(s);
  });

  it('is idempotent', () => {
    const once = run('.e {\n  padding: 12px;\n  font: 400 13px/18px var(--if-font-ui);\n}');
    expect(run(once)).toBe(once);
    expect(transform(once, s).changed).toBe(0);
  });

  it('reads the same tokens file it is run against', () => {
    const generated = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');
    expect(scales(generated)).toEqual(s);
  });
});
