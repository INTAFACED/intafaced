import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HeroNumber } from './hero-number.js';
import { Amount, ChangeText, Money, Pct, Price } from './numbers.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

// TEST figures. On an Arabic or Hebrew page a figure without its own direction reads "(1.68%+) $206.29+".
describe('figures keep left-to-right order on a right-to-left page', () => {
  it('isolates the change line, not its trailing words', () => {
    const out = html(<ChangeText value="+$206.29 (+1.68%)" suffix="Today" hidden={false} />);
    expect(out).toMatch(/<span dir="ltr" data-ltr="" class="if-num[^"]*">(<span[^>]*>▲<\/span>)?\+\$206\.29 \(\+1\.68%\)<\/span>/);
    // The suffix is copy, so it takes the page's direction.
    expect(out).toMatch(/<span class="text-fg-2">Today<\/span>/);
  });

  it('isolates money, amounts, prices, percents and the hero total', () => {
    for (const el of [
      <Money key="m" value="$1,234.50" hidden={false} />,
      <Amount key="a" value="0.123456 BTC" hidden={false} />,
      <Price key="p" value="67,000.10" />,
      <Pct key="c" value="−0.28%" />,
      <HeroNumber key="h" value="999.88" decimals={2} prefix="$" hidden={false} />,
    ]) {
      expect(html(el)).toMatch(/^<span[^>]* dir="ltr" data-ltr=""/);
    }
  });

  it('cannot be undone by a caller', () => {
    expect(html(<Money value="$1,234.50" hidden={false} dir="rtl" />)).toContain('dir="ltr"');
    expect(html(<Pct value="+1.24%" dir="rtl" />)).toContain('dir="ltr"');
  });

  it('keeps isolation when the figure is hidden', () => {
    expect(html(<ChangeText value="+$206.29 (+1.68%)" hidden />)).toContain('dir="ltr"');
    expect(html(<Money value="$1,234.50" hidden />)).toContain('dir="ltr"');
  });
});
