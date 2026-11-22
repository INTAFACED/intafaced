// The kit's form controls inside lt-field: each holds the native control, named by its label alone (a hint describes it),
// with no style of its own.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckField, FileField, SelectField, TextAreaField, TextField } from './b2-fields.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const none = () => undefined;

describe('kit fields', () => {
  it('SelectField: a native select its label names, every option, the value chosen', () => {
    const out = html(<SelectField id="t" label="Topic" value="b" onChange={none} options={['a', { value: 'b', label: 'Bee' }]} />);
    expect(out).toMatch(/^<div class="lt-field"><label for="t">Topic<\/label><select id="t">/);
    expect(out).toContain('<option value="a">a</option>');
    expect(out).toContain('<option value="b" selected="">Bee</option>');
    expect(out).not.toContain('style=');
  });

  it('TextAreaField: a native textarea with its limit and rows', () => {
    const out = html(<TextAreaField id="a" label="Ask" value="hi" onChange={none} maxLength={20} />);
    expect(out).toBe('<div class="lt-field"><label for="a">Ask</label><textarea maxLength="20" id="a" rows="5">hi</textarea></div>');
  });

  it('TextField: the hint sits outside the label and describes the input', () => {
    const out = html(<TextField id="n" label="Name" value="x" onChange={none} hint="Your own" />);
    expect(out).toBe(
      '<div class="lt-field"><label for="n">Name</label><input id="n" aria-describedby="n-hint" value="x"/><small id="n-hint">Your own</small></div>',
    );
  });

  it('CheckField: the tick, then its words, on one row', () => {
    const out = html(<CheckField label="Pick" checked onChange={none} />);
    expect(out).toBe('<label class="lt-field"><input type="checkbox" checked=""/><span>Pick</span></label>');
  });

  it('FileField: a native file picker with the hint it is described by', () => {
    const out = html(<FileField id="img" label="Image" accept="image/png" hint="PNG only" onChange={none} />);
    expect(out).toBe(
      '<div class="lt-field"><label for="img">Image</label><input accept="image/png" id="img" type="file" aria-describedby="img-hint"/><small id="img-hint">PNG only</small></div>',
    );
  });
});
