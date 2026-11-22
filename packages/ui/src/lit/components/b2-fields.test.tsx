// The kit's form controls inside lt-field: each holds the native control, labelled by its words, with no style of its own.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckField, SelectField, TextAreaField, TextField } from './b2-fields.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const none = () => undefined;

describe('kit fields', () => {
  it('SelectField: a native select inside its label, every option, the value chosen', () => {
    const out = html(<SelectField label="Topic" value="b" onChange={none} options={['a', { value: 'b', label: 'Bee' }]} />);
    expect(out).toMatch(/^<label class="lt-field"><span>Topic<\/span><select>/);
    expect(out).toContain('<option value="a">a</option>');
    expect(out).toContain('<option value="b" selected="">Bee</option>');
    expect(out).not.toContain('style=');
  });

  it('TextAreaField: a native textarea with its limit and rows', () => {
    const out = html(<TextAreaField label="Ask" value="hi" onChange={none} maxLength={20} />);
    expect(out).toContain('<label class="lt-field"><span>Ask</span><textarea maxLength="20" rows="5">hi</textarea>');
  });

  it('TextField: a native input with its hint under it', () => {
    const out = html(<TextField label="Name" value="x" onChange={none} hint="Your own" />);
    expect(out).toContain('<input value="x"/><small>Your own</small>');
  });

  it('CheckField: the tick, then its words, on one row', () => {
    const out = html(<CheckField label="Pick" checked onChange={none} />);
    expect(out).toBe('<label class="lt-field"><input type="checkbox" checked=""/><span>Pick</span></label>');
  });
});
