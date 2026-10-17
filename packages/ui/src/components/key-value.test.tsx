import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KeyValue } from './key-value.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (out: string) => out.replace(/<[^>]+>/g, '');

const items = [
  { label: 'Order', value: 'TEST-0001', mono: true },
  { label: 'Fee', value: '0.10', hint: 'TEST DATA' },
  { label: 'Venue', value: null },
];

describe('KeyValue structure', () => {
  const out = html(<KeyValue items={items} />);
  it('is a real dl with one dt and one dd per item', () => {
    expect(out.startsWith('<dl')).toBe(true);
    expect(out.match(/<dt\b/g)).toHaveLength(3);
    expect(out.match(/<dd\b/g)).toHaveLength(3);
    expect(out).toContain('data-slot="key-value"');
    expect(out).toContain('data-layout="inline"');
  });
  it('wraps each pair in a div row with a hairline separator', () => {
    expect(out.match(/data-slot="key-value-row"/g)).toHaveLength(3);
    expect(out).toContain('border-b border-line');
    expect(out).toContain('last:border-b-0');
  });
  it('right-aligns values with tabular figures; mono uses if-mono', () => {
    expect(out).toContain('text-right');
    expect(out).toContain('tabular-nums');
    expect(out).toContain('if-mono');
    expect(out).toContain('TEST-0001');
  });
  it('draws the hint', () => {
    expect(text(out)).toContain('TEST DATA');
  });
});

describe('KeyValue null handling', () => {
  const out = html(<KeyValue items={[{ label: 'Venue', value: null }]} />);
  it('draws the dash with an sr-only unknown, never 0', () => {
    expect(out).toContain('>—<');
    expect(out).toContain('<span class="sr-only">unknown</span>');
    expect(out).toContain('data-unknown="true"');
    expect(text(out)).not.toMatch(/\b0\b/);
  });
  it('sr-only word is overridable', () => {
    expect(html(<KeyValue items={[{ label: 'a', value: null }]} unknownLabel="inconnu" />)).toContain('>inconnu<');
  });
});

describe('KeyValue density and layout', () => {
  it('dense rows are min-h-7 (28px), comfortable min-h-10 (40px)', () => {
    expect(html(<KeyValue items={items} density="dense" />)).toContain('min-h-7');
    const comfy = html(<KeyValue items={items} />);
    expect(comfy).toContain('min-h-10');
    expect(comfy).toContain('data-density="comfortable"');
  });
  it('stacked puts the value left under the label', () => {
    const out = html(<KeyValue items={items} layout="stacked" />);
    expect(out).toContain('data-layout="stacked"');
    expect(out).toContain('flex-col');
    expect(out).toContain('text-left');
    expect(out).not.toContain('text-right');
  });
});

describe('KeyValue asOf', () => {
  it('draws a time element with dateTime', () => {
    const out = html(
      <KeyValue
        items={[{ label: 'Rate', value: '1.0', asOf: '2026-10-17T14:03:07Z' }]}
        timeZone="UTC"
        locale="en-GB"
        now={Date.UTC(2026, 9, 17, 14, 5, 0)}
      />,
    );
    expect(out).toContain('<time dateTime="2026-10-17T14:03:07.000Z">14:03:07</time>');
    expect(text(out)).toContain('as of 14:03:07');
  });
  it('draws nothing for an unusable asOf', () => {
    expect(html(<KeyValue items={[{ label: 'Rate', value: '1.0', asOf: 'nope' }]} />)).not.toContain('<time');
  });
});
