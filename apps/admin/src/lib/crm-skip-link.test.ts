import { describe, expect, it } from 'vitest';
import { skipLabel, skipTarget } from './crm-skip-link';

describe('CRM skip link', () => {
  it('points at the list whenever the list is on screen', () => {
    expect(skipTarget(true, true)).toBe('list');
    expect(skipTarget(true, false)).toBe('list');
  });
  it('points at the enquiry heading when only the detail is on screen (phone detail view)', () => {
    expect(skipTarget(false, true)).toBe('detail');
  });
  it('points nowhere when neither is on screen', () => {
    expect(skipTarget(false, false)).toBeNull();
  });
  it('reads "Skip to enquiry" only when it lands on the enquiry heading', () => {
    expect(skipLabel('detail')).toBe('Skip to enquiry');
    expect(skipLabel('list')).toBe('Skip to enquiries');
    expect(skipLabel(null)).toBe('Skip to enquiries');
  });
});
