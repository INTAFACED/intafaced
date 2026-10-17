import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Field } from './field.js';
import { Input } from './input.js';

const noop = () => {};
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const tag = (markup: string, name: string) => markup.match(new RegExp(`<${name}\\b[^>]*>`))?.[0] ?? '';
const attr = (el: string, name: string) => el.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

describe('Field default', () => {
  const out = html(
    <Field label="Price" hint="Per coin">
      <Input value="" onValueChange={noop} />
    </Field>,
  );

  it('ties the label to the input (for = id)', () => {
    const label = tag(out, 'label');
    const input = tag(out, 'input');
    expect(attr(label, 'for')).toBeTruthy();
    expect(attr(label, 'for')).toBe(attr(input, 'id'));
    expect(out).toContain('>Price');
  });

  it('points aria-describedby at the hint', () => {
    const input = tag(out, 'input');
    const describedBy = attr(input, 'aria-describedby');
    expect(describedBy).toBeTruthy();
    const hint = out.match(/<p\b[^>]*data-slot="field-hint"[^>]*>/)?.[0] ?? '';
    expect(attr(hint, 'id')).toBe(describedBy);
    expect(out).toContain('Per coin');
  });

  it('has no error, no alert, not invalid, no required marker', () => {
    expect(out).not.toContain('role="alert"');
    expect(out).not.toContain('aria-invalid');
    expect(out).not.toContain('required');
    expect(out).toContain('data-slot="field"');
    expect(out).toContain('data-density="comfortable"');
    expect(out).toContain('data-orientation="vertical"');
  });
});

describe('Field error', () => {
  const out = html(
    <Field label="Price" hint="Per coin" error="Enter a price">
      <Input value="" onValueChange={noop} />
    </Field>,
  );

  it('marks the input invalid and shows the text in an alert', () => {
    expect(tag(out, 'input')).toContain('aria-invalid="true"');
    const alert = out.match(/<div\b[^>]*role="alert"[^>]*>/)?.[0] ?? '';
    expect(alert).toBeTruthy();
    expect(out).toContain('Enter a price');
    expect(out).toContain('text-error-text');
    expect(out).toContain('border-error');
  });

  it('is not colour alone: the error has an icon', () => {
    const alertHtml = out.slice(out.indexOf('role="alert"'));
    expect(alertHtml).toContain('<svg');
    expect(alertHtml).toContain('aria-hidden="true"');
  });

  it('describes the input by both the hint and the error ids', () => {
    const ids = (attr(tag(out, 'input'), 'aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(2);
    const alert = out.match(/<div\b[^>]*role="alert"[^>]*>/)?.[0] ?? '';
    expect(ids).toContain(attr(alert, 'id'));
  });

  it('sets data-invalid on the root', () => {
    expect(tag(out, 'div')).toContain('data-invalid=""');
  });
});

describe('Field required', () => {
  const out = html(
    <Field label="Name" required>
      <Input value="" onValueChange={noop} />
    </Field>,
  );

  it('shows a visible marker plus sr-only text and sets required on the control', () => {
    expect(out).toMatch(/<span aria-hidden="true"[^>]*>\*<\/span>/);
    expect(out).toContain('<span class="sr-only"> required</span>');
    expect(tag(out, 'input')).toContain('required=""');
  });

  it('the sr-only word can be replaced', () => {
    const de = html(
      <Field label="Name" required requiredLabel="Pflichtfeld">
        <Input value="" onValueChange={noop} />
      </Field>,
    );
    expect(de).toContain('> Pflichtfeld</span>');
  });
});

describe('Field disabled', () => {
  it('disables the control and dims the label', () => {
    const out = html(
      <Field label="Name" disabled>
        <Input value="" onValueChange={noop} />
      </Field>,
    );
    expect(tag(out, 'input')).toContain('disabled=""');
    expect(tag(out, 'label')).toContain('data-disabled=""');
    expect(out).toContain('opacity-40');
  });
});

describe('Field density and orientation', () => {
  it('dense passes data-density and a smaller label', () => {
    const out = html(
      <Field label="Name" density="dense">
        <Input value="" onValueChange={noop} />
      </Field>,
    );
    expect(tag(out, 'div')).toContain('data-density="dense"');
    expect(tag(out, 'label')).toContain('text-xs');
    expect(out).toContain('h-(--if-ctl-h-dense)');
  });

  it('horizontal puts the label in the left column', () => {
    const out = html(
      <Field label="Name" orientation="horizontal" hint="Help" error="Bad">
        <Input value="" onValueChange={noop} />
      </Field>,
    );
    expect(tag(out, 'div')).toContain('data-orientation="horizontal"');
    expect(tag(out, 'div')).toContain('grid-cols-[8rem_minmax(0,1fr)]');
    expect(out).toContain('col-start-2');
  });
});

describe('Field labelAction and className', () => {
  it('renders the action next to the label', () => {
    const out = html(
      <Field label="Amount" labelAction={<button type="button">Max</button>} className="mine">
        <Input value="" onValueChange={noop} />
      </Field>,
    );
    expect(out).toContain('data-slot="field-label-action"');
    expect(out).toContain('>Max</button>');
    expect(tag(out, 'div')).toContain('mine');
  });
});

describe('Field with a decimal Input', () => {
  it('labels an inputmode=decimal type=text control', () => {
    const out = html(
      <Field label="Amount" required>
        <Input kind="decimal" precision={8} value="0.1" onValueChange={noop} />
      </Field>,
    );
    const input = tag(out, 'input');
    expect(input).toContain('type="text"');
    expect(input).toMatch(/inputmode="decimal"/i);
    expect(attr(tag(out, 'label'), 'for')).toBe(attr(input, 'id'));
  });
});
