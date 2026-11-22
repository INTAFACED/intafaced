import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { components } from '../contracts.js';
import { pastedDecimalValue, typedDecimalValue } from '../../components/input-logic.js';
import { Sheet } from './b2-basics.js';
import { ChoiceGroup, DecimalField, Freshness } from './index.js';

const words = { live: 'Live', stale: 'Stale', unknown: 'Unknown', asOf: 'as of' };
const NOW = Date.parse('2026-11-22T10:00:00.000Z');

describe('DecimalField and Freshness', () => {
  it('are named in the contracts', () => {
    expect(Object.keys(components)).toEqual(expect.arrayContaining(['ChoiceGroup', 'DecimalField', 'Freshness']));
  });

  it('DecimalField labels its input, shows the canonical value and asks for the decimal keyboard', () => {
    const out = renderToStaticMarkup(
      <DecimalField id="p" label="Price" hint="Per period" value="12.5" onValueChange={() => {}} precision={2} />,
    );
    expect(out).toContain('<label for="p">Price</label>');
    expect(out).toContain('inputMode="decimal"');
    expect(out).toContain('value="12.5"');
    expect(out).toContain('aria-describedby="p-hint"');
  });

  it('DecimalField cleans a pasted grouped amount to its canonical value, and refuses one it cannot read', () => {
    expect(pastedDecimalValue('', '1,234.56', { precision: 18 })).toBe('1234.56');
    expect(pastedDecimalValue('', '$ 1,234.56 USDT', { precision: 2 })).toBe('1234.56');
    expect(pastedDecimalValue('', '1.234,56', { precision: 2 })).toBe('1234.56');
    expect(pastedDecimalValue('', '1,234.567', { precision: 2 })).toBe('1234.56');
    expect(pastedDecimalValue('7', '1e5', { precision: 2 })).toBe('7');
  });

  it("DecimalField's typedMark 'either' reads a typed comma as the decimal point; the default refuses it", () => {
    expect(typedDecimalValue('12', '12,5', { precision: 18, typedMark: 'either' })).toBe('12.5');
    expect(typedDecimalValue('12', '12,5', { precision: 18 })).toBe('12');
    expect(typedDecimalValue('1.2', '1.2,', { precision: 18, typedMark: 'either' })).toBe('1.2');
    expect(typedDecimalValue('1.25', '1.255', { precision: 2, typedMark: 'either' })).toBe('1.25');
    expect(typedDecimalValue('', '007', { precision: 2, typedMark: 'either' })).toBe('7');
  });

  it('Sheet held open while a save runs: Close is disabled; by default it is not', () => {
    const held = renderToStaticMarkup(
      <Sheet open title="Change your handle" onClose={() => {}} dismissible={false}>
        <p>Body</p>
      </Sheet>,
    );
    expect(held).toMatch(/<button type="button" class="lt-button lt-button-secondary" disabled="">Close<\/button>/);
    const free = renderToStaticMarkup(
      <Sheet open title="Change your handle" onClose={() => {}}>
        <p>Body</p>
      </Sheet>,
    );
    expect(free).toMatch(/<button type="button" class="lt-button lt-button-secondary">Close<\/button>/);
  });

  it('Freshness says Live with the as-of time inside the limit, Stale past it, Unknown without a time', () => {
    const at = new Date(NOW - 10_000).toISOString();
    const live = renderToStaticMarkup(<Freshness asOf={at} staleAfterMs={60_000} now={NOW} timeZone="UTC" words={words} />);
    expect(live).toContain('data-fresh="live"');
    expect(live).toContain('Live');
    expect(live).toContain(`as of <time dateTime="${at}">09:59:50</time>`);
    const stale = renderToStaticMarkup(<Freshness asOf={at} staleAfterMs={5_000} now={NOW} timeZone="UTC" words={words} />);
    expect(stale).toContain('data-fresh="stale"');
    const unknown = renderToStaticMarkup(<Freshness asOf={null} staleAfterMs={5_000} now={NOW} words={words} reason="Could not be read" />);
    expect(unknown).toContain('data-fresh="unknown"');
    expect(unknown).toContain('Could not be read');
    expect(unknown).not.toContain('<time');
  });

  it('ChoiceGroup draws one radio per option, named by its label, with the current one checked', () => {
    const out = renderToStaticMarkup(
      <ChoiceGroup
        legend="Fee model"
        name="fee"
        value="b"
        onChange={() => {}}
        options={[
          { value: 'a', label: 'Free' },
          { value: 'b', label: 'Monthly', hint: 'Per period' },
        ]}
      />,
    );
    expect(out).toContain('<legend>Fee model</legend>');
    expect(out.match(/type="radio"/g)).toHaveLength(2);
    expect(out).toContain('checked="" value="b"');
    expect(out).toContain('Per period');
  });
});
