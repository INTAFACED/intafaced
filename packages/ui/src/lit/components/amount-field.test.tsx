// AmountField: the money box. A decimal string in and out, never a number; the unit beside the figure; what is
// available and the Max key under it; a refusal that is announced and marks it invalid.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AmountField } from './amount-field.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const none = () => undefined;

// Typing, pasting, leaving and Max run in a page: apps/customer/src/app/kit/volt-kit.render.test.tsx. The string work
// under them is ../../components/amount-input-logic.test.ts.
describe('AmountField', () => {
  it('is a decimal text box named by its label, with its unit beside the figure, never type="number"', () => {
    const out = html(<AmountField id="a" label="Amount to send" value="12.5" onChange={none} precision={2} unit="USDT" />);
    expect(out).toContain('<label for="a">Amount to send</label>');
    expect(out).toMatch(/<input id="a" type="text" inputMode="decimal" autoComplete="off"/);
    expect(out).toContain('value="12.5"');
    expect(out).toContain('<span data-part="unit">USDT</span>');
    expect(out).not.toContain('type="number"');
    expect(out).not.toContain('aria-invalid');
    expect(out).not.toContain('style=');
  });

  it('shows what is available and a Max key; the available words describe the box', () => {
    const out = html(
      <AmountField
        id="b"
        label="Amount"
        value=""
        onChange={none}
        precision={2}
        available="Available 9,218.50 USDT"
        max={{ label: 'Max', onSelect: none }}
      />,
    );
    expect(out).toContain('aria-describedby="b-available"');
    expect(out).toContain('<span id="b-available" data-part="available">Available 9,218.50 USDT</span>');
    expect(out).toContain('<button type="button" data-part="max">Max</button>');
  });

  it('a refusal takes the hint’s place, is announced, and marks the box invalid', () => {
    const out = html(
      <AmountField id="c" label="Amount" value="99999" onChange={none} precision={2} hint="Up to 2 decimals" error="More than you have" />,
    );
    expect(out).toContain('data-invalid=""');
    expect(out).toContain('aria-invalid="true" aria-describedby="c-note"');
    expect(out).toContain('<small id="c-note" data-part="error" role="alert">More than you have</small>');
    expect(out).not.toContain('Up to 2 decimals');
  });

  it('the hero size keeps its label for a screen reader only', () => {
    const out = html(<AmountField id="h" label="Amount to send" hideLabel size="hero" value="" onChange={none} precision={2} />);
    expect(out).toContain('data-size="hero"');
    expect(out).toContain('<label for="h" class="lit-sr">Amount to send</label>');
    expect(out).toContain('placeholder="0"');
  });

  it('a disabled field disables its Max key too', () => {
    const out = html(<AmountField label="Amount" value="" onChange={none} precision={2} disabled max={{ label: 'Max', onSelect: none }} />);
    expect(out).toContain('disabled=""');
    expect(out).toMatch(/<button type="button" data-part="max" disabled="">Max<\/button>/);
  });
});
