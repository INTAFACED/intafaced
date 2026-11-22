import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { components } from '../contracts.js';
import { CoinMark, DecimalField, Disclosure, Progress, TestLabel } from './index.js';

describe('the buy and convert parts', () => {
  it('are named in the contracts', () => {
    expect(Object.keys(components)).toEqual(expect.arrayContaining(['CoinMark', 'Disclosure', 'Progress', 'TestLabel']));
  });

  it('CoinMark draws the kit artwork for a listed coin and a letter for any other, hidden from assistive tech', () => {
    const btc = renderToStaticMarkup(<CoinMark asset="btc" />);
    expect(btc).toContain('data-asset="BTC"');
    expect(btc).toContain('aria-hidden="true"');
    expect(btc).toContain('<svg');
    expect(btc).not.toContain('data-fallback');
    const other = renderToStaticMarkup(<CoinMark asset="sol" size="sm" />);
    expect(other).toContain('data-fallback="lettered"');
    expect(other).toContain('data-size="sm"');
    expect(other).toMatch(/>S<\/span>$/);
  });

  it('Disclosure is a details element whose summary carries its name; the answer sits in its panel', () => {
    const out = renderToStaticMarkup(
      <Disclosure summary="i" summaryLabel="About the rate" variant="inline">
        Included in the rate
      </Disclosure>,
    );
    expect(out).toContain('<details class="lit-disclosure" data-variant="inline">');
    expect(out).toContain('<summary aria-label="About the rate">i</summary>');
    expect(out).toContain('<div data-part="panel">Included in the rate</div>');
    expect(renderToStaticMarkup(<Disclosure summary="Q">A</Disclosure>)).toContain('data-variant="row"');
  });

  it('Progress is a native progress bar with its name and its value in words', () => {
    const out = renderToStaticMarkup(<Progress label="Time left" value={12} max={30} valueText="12s" data-testid="hold-bar" />);
    expect(out).toContain('<progress');
    expect(out).toContain('aria-label="Time left"');
    expect(out).toContain('aria-valuetext="12s"');
    expect(out).toContain('value="12"');
    expect(out).toContain('max="30"');
    expect(out).toContain('data-testid="hold-bar"');
  });

  it('TestLabel says TEST by default and the room copy word when given', () => {
    expect(renderToStaticMarkup(<TestLabel />)).toBe('<span class="lit-test">TEST</span>');
    expect(renderToStaticMarkup(<TestLabel title="A TEST venue">TEST</TestLabel>)).toContain('title="A TEST venue"');
  });

  it('DecimalField with a unit and Max draws both inside the box; Max is off while the field is', () => {
    const out = renderToStaticMarkup(
      <DecimalField
        id="a"
        label="Amount in USD"
        labelHidden
        size="hero"
        unit="USD"
        onMax={() => {}}
        maxLabel="Max"
        value="5"
        onValueChange={() => {}}
        precision={2}
      />,
    );
    expect(out).toContain('data-slot="decimal-field" data-size="hero"');
    expect(out).toContain('<label for="a" class="lit-sr">Amount in USD</label>');
    expect(out).toContain('<span data-part="unit" aria-hidden="true">USD</span>');
    expect(out).toMatch(/data-part="max">Max<\/button>/);
    const off = renderToStaticMarkup(
      <DecimalField label="Amount" onMax={() => {}} disabled value="" onValueChange={() => {}} precision={2} />,
    );
    expect(off).toMatch(/data-part="max" disabled="">Max<\/button>/);
    const plain = renderToStaticMarkup(<DecimalField label="Amount" value="" onValueChange={() => {}} precision={2} />);
    expect(plain).not.toContain('lit-field-row');
    expect(plain).not.toContain('data-size');
  });
});
