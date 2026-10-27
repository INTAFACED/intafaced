import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Input } from './input.js';
import { Field } from './field.js';

const noop = () => {};
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
// React writes some attributes in camelCase (inputMode, readOnly); HTML reads them case-insensitively.
const has = (el: string, attrText: string) => new RegExp(`\\s${attrText}`, 'i').test(el);
const tag = (markup: string, name: string) => markup.match(new RegExp(`<${name}\\b[^>]*>`))?.[0] ?? '';

describe('Input text kind', () => {
  it('renders a plain type="text" input with the value', () => {
    const out = html(<Input value="hello" onValueChange={noop} aria-label="Name" />);
    const input = tag(out, 'input');
    expect(input).toContain('type="text"');
    expect(input).toContain('value="hello"');
    expect(input).toContain('aria-label="Name"');
    expect(has(input, 'inputmode')).toBe(false);
    expect(out).toContain('data-slot="input"');
    expect(out).toContain('data-kind="text"');
    expect(out).toContain('text-start');
  });

  it('works without a Field around it', () => {
    expect(() => html(<Input value="" onValueChange={noop} aria-label="x" />)).not.toThrow();
  });
});

describe('Input decimal kind', () => {
  it('is type="text" with inputmode="decimal", never type="number"', () => {
    const out = html(<Input kind="decimal" value="0.1" onValueChange={noop} precision={8} aria-label="Amount" />);
    const input = tag(out, 'input');
    expect(input).toContain('type="text"');
    expect(input).not.toContain('type="number"');
    expect(has(input, 'inputmode="decimal"')).toBe(true);
    expect(has(input, 'autocomplete="off"')).toBe(true);
    expect(input).toContain('value="0.1"');
    expect(out).toContain('tabular-nums');
    expect(out).toContain('text-end');
    expect(out).toContain('data-kind="decimal"');
  });

  it('echoes an 18-decimal string and a huge integer without losing a digit', () => {
    const a = '0.123456789012345678';
    const b = '123456789012345678901234567890.000000000000000001';
    expect(tag(html(<Input kind="decimal" value={a} onValueChange={noop} precision={18} aria-label="a" />), 'input')).toContain(
      `value="${a}"`,
    );
    expect(tag(html(<Input kind="decimal" value={b} onValueChange={noop} precision={18} aria-label="a" />), 'input')).toContain(
      `value="${b}"`,
    );
  });

  it('shows the comma mark when asked, value stays canonical', () => {
    const out = html(<Input kind="decimal" value="0.25" onValueChange={noop} precision={8} decimalSeparator="," aria-label="a" />);
    expect(tag(out, 'input')).toContain('value="0,25"');
  });

  it('an empty value renders empty', () => {
    const out = html(<Input kind="decimal" value="" onValueChange={noop} precision={2} aria-label="a" placeholder="0" />);
    expect(tag(out, 'input')).toContain('value=""');
  });

  it('can be aligned to the start', () => {
    const out = html(<Input kind="decimal" value="1" onValueChange={noop} precision={2} aria-label="a" align="start" />);
    expect(out).toContain('text-start');
  });
});

describe('Input states', () => {
  it('disabled: disabled attribute, data-disabled, opacity-40, not-allowed cursor', () => {
    const out = html(<Input value="" onValueChange={noop} aria-label="a" disabled />);
    expect(has(tag(out, 'input'), 'disabled=""')).toBe(true);
    expect(out).toContain('data-disabled=""');
    expect(out).toContain('opacity-40');
    expect(out).toContain('cursor-not-allowed');
  });

  it('readOnly: readonly attribute and data-readonly, still enabled', () => {
    const out = html(<Input value="x" onValueChange={noop} aria-label="a" readOnly />);
    expect(has(tag(out, 'input'), 'readonly=""')).toBe(true);
    expect(has(tag(out, 'input'), 'disabled(="")?[\\s/>]')).toBe(false);
    expect(out).toContain('data-readonly=""');
  });

  it('loading: aria-busy on the input, a spinner, and the field stays editable', () => {
    const out = html(<Input value="x" onValueChange={noop} aria-label="a" loading />);
    expect(tag(out, 'input')).toContain('aria-busy="true"');
    expect(has(tag(out, 'input'), 'readonly(="")?[\\s/>]')).toBe(false);
    expect(has(tag(out, 'input'), 'disabled(="")?[\\s/>]')).toBe(false);
    expect(out).toContain('data-slot="input-spinner"');
    expect(out).toContain('data-loading=""');
  });

  it('not loading: no aria-busy, no spinner', () => {
    const out = html(<Input value="x" onValueChange={noop} aria-label="a" />);
    expect(out).not.toContain('aria-busy');
    expect(out).not.toContain('input-spinner');
  });

  it('invalid: aria-invalid and the error border', () => {
    const out = html(<Input value="x" onValueChange={noop} aria-label="a" invalid />);
    expect(tag(out, 'input')).toContain('aria-invalid="true"');
    expect(out).toContain('border-error');
    expect(out).toContain('data-invalid=""');
  });

  it('valid: no aria-invalid', () => {
    expect(html(<Input value="x" onValueChange={noop} aria-label="a" />)).not.toContain('aria-invalid');
  });

  it('required sets the required attribute', () => {
    expect(tag(html(<Input value="" onValueChange={noop} aria-label="a" required />), 'input')).toContain('required=""');
  });

  it('draws leading and trailing slots', () => {
    const out = html(<Input value="1" onValueChange={noop} aria-label="a" leading={<i>ICON</i>} trailing="USDT" />);
    expect(out).toContain('data-slot="input-leading"');
    expect(out).toContain('ICON');
    expect(out).toContain('data-slot="input-trailing"');
    expect(out).toContain('USDT');
  });

  it('has the lime focus ring on the wrapper', () => {
    const out = html(<Input value="" onValueChange={noop} aria-label="a" />);
    expect(out).toContain('has-[input:focus-visible]:outline-focus');
  });
});

describe('Input density', () => {
  it('defaults to comfortable', () => {
    const out = html(<Input value="" onValueChange={noop} aria-label="a" />);
    expect(out).toContain('data-density="comfortable"');
    expect(out).toContain('h-(--if-ctl-h)');
    expect(out).toContain('text-base');
  });

  it('dense is 32 px with 13 px text', () => {
    const out = html(<Input value="" onValueChange={noop} aria-label="a" density="dense" />);
    expect(out).toContain('data-density="dense"');
    expect(out).toContain('h-(--if-ctl-h-dense)');
    expect(out).toContain('text-sm');
  });
});

describe('Input inside a Field', () => {
  it('takes density, required, disabled and invalid from the Field', () => {
    const out = html(
      <Field label="Amount" density="dense" required disabled error="Too small">
        <Input value="" onValueChange={noop} />
      </Field>,
    );
    const input = tag(out, 'input');
    expect(out).toContain('data-slot="input"');
    expect(out).toMatch(/data-slot="input"[^>]*data-density="dense"/);
    expect(input).toContain('required=""');
    expect(has(input, 'disabled=""')).toBe(true);
    expect(input).toContain('aria-invalid="true"');
  });

  it('an explicit Input prop wins over the Field', () => {
    const out = html(
      <Field label="A" density="dense">
        <Input value="" onValueChange={noop} density="comfortable" />
      </Field>,
    );
    expect(out).toMatch(/data-slot="input"[^>]*data-density="comfortable"/);
  });

  it('keeps its own aria-describedby next to the Field ids', () => {
    const out = html(
      <Field label="A" hint="Help">
        <Input value="" onValueChange={noop} aria-describedby="extra" />
      </Field>,
    );
    const input = tag(out, 'input');
    expect(input).toMatch(/aria-describedby="extra [^"]+"/);
  });
});

describe('invalid is never colour alone', () => {
  it('draws an icon next to the red border, with or without a Field message', () => {
    const out = renderToStaticMarkup(<Input kind="text" value="x" onValueChange={() => undefined} invalid aria-label="x" />);
    expect(out).toContain('data-slot="input-invalid-icon"');
    expect(out).toContain('aria-invalid="true"');
    expect(renderToStaticMarkup(<Input kind="text" value="x" onValueChange={() => undefined} aria-label="x" />)).not.toContain(
      'input-invalid-icon',
    );
  });
});
