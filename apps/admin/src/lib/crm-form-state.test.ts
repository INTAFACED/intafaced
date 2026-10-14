import { describe, expect, it } from 'vitest';
import { submitProps } from './crm-form-state';

describe('primary button state', () => {
  it('is lime only when the form has changes and the button is enabled', () => {
    expect(submitProps({ disabled: false, changed: true })).toEqual({ disabled: false, 'data-primary': 'true' });
  });
  it('is neutral while the form is unchanged', () => {
    expect(submitProps({ disabled: false, changed: false })['data-primary']).toBe('false');
  });
  it('stays neutral but enabled when the save is certain to be refused', () => {
    expect(submitProps({ disabled: false, changed: true, refused: true })).toEqual({ disabled: false, 'data-primary': 'false' });
  });
  it('is never lime while disabled, even with changes', () => {
    expect(submitProps({ disabled: true, changed: true })).toEqual({ disabled: true, 'data-primary': 'false' });
  });
});
