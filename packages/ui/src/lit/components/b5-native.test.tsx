import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { components } from '../contracts.js';
import { CheckRow, NativeSelect, NativeTextArea } from './index.js';

describe('NativeSelect, NativeTextArea and CheckRow', () => {
  it('are named in the contracts', () => {
    expect(Object.keys(components)).toEqual(expect.arrayContaining(['NativeSelect', 'NativeTextArea', 'CheckRow']));
  });

  it('NativeSelect is a real select with its own options and every native attribute', () => {
    const out = renderToStaticMarkup(
      <NativeSelect id="s" name="fiat" aria-labelledby="l" data-testid="pick" value="EUR" onChange={() => {}} required disabled>
        <option value="">Pick</option>
        <option value="EUR">EUR</option>
      </NativeSelect>,
    );
    expect(out).toMatch(/^<select /);
    expect(out).toContain('id="s"');
    expect(out).toContain('name="fiat"');
    expect(out).toContain('aria-labelledby="l"');
    expect(out).toContain('data-testid="pick"');
    expect(out).toContain('required=""');
    expect(out).toContain('disabled=""');
    expect(out).toContain('class="lit-native-select"');
    expect(out).toContain('<option value="EUR" selected="">EUR</option>');
  });

  it('NativeTextArea is a real textarea that keeps its value and attributes', () => {
    const out = renderToStaticMarkup(
      <NativeTextArea id="t" name="reason" maxLength={20} aria-invalid data-x="1" value="Because" onChange={() => {}} required />,
    );
    expect(out).toMatch(/^<textarea /);
    expect(out).toContain('maxLength="20"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('data-x="1"');
    expect(out).toContain('class="lit-textarea"');
    expect(out).toContain('>Because</textarea>');
  });

  it('CheckRow is a native checkbox inside its label, with the row attributes on the label', () => {
    const out = renderToStaticMarkup(
      <CheckRow
        name="m"
        checked
        disabled
        onChange={() => {}}
        aria-describedby="h"
        label={<span lang="und">TEST bank transfer</span>}
        labelProps={{ 'data-testid': 'row', 'data-offer-id': 'o1' }}
      />,
    );
    expect(out).toMatch(/^<label data-testid="row" data-offer-id="o1" class="lit-check"><input /);
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('checked=""');
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-describedby="h"');
    expect(out).toContain('<span lang="und">TEST bank transfer</span></label>');
  });
});
