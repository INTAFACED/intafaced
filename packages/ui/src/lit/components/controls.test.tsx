import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from './index.js';
import { Checkbox, FormField, Input } from './controls.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const css = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '../templates/templates.css'), 'utf8');

describe('the desk form parts', () => {
  it('ties the label, hint and error to the input inside a FormField', () => {
    const out = html(
      <FormField label="Margin amount" hint="Free 10 USDT" error="Too much">
        <Input kind="decimal" value="1.5" onValueChange={() => {}} precision={8} trailing="USDT" />
      </FormField>,
    );
    expect(out).toContain('Margin amount');
    expect(out).toMatch(/aria-invalid="true"/);
    expect(out).toMatch(/aria-describedby="[^"]*-hint [^"]*-error"/);
    expect(out).toContain('inputMode="decimal"');
    expect(out).toContain('value="1.5"');
    expect(out).toContain('USDT');
    expect(out).toContain('role="alert"');
  });

  it('a busy button says so and stays focusable', () => {
    const out = html(<Button busy>Save</Button>);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('aria-disabled="true"');
    expect(out).not.toMatch(/\sdisabled=""/);
  });

  it('a checkbox is the platform control', () => {
    expect(html(<Checkbox checked onCheckedChange={() => {}} />)).toMatch(/<input type="checkbox" checked=""/);
  });

  it('their styles read only lit roles and logical sides', () => {
    const block = css.slice(css.indexOf('/* ---- form and overlay parts'));
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|\bpx\b/i);
    expect(block).not.toMatch(/\b(left|right|top|bottom)\s*:/);
  });
});
