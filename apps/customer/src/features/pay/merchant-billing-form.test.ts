import { expect, it } from 'vitest';
import { mandateFormDirty } from './MerchantBilling';
import { DEFAULT_ASSET } from './portal/payments/asset-choices';

const untouched = { customer: '', asset: DEFAULT_ASSET, amount: '', ceiling: '', starts: '', ends: '', rail: '', reference: '' };
it('does not warn about unsaved changes on an untouched form', () => {
  expect(mandateFormDirty(untouched)).toBe(false);
});
it('warns once something is typed or the asset is changed', () => {
  expect(mandateFormDirty({ ...untouched, customer: 'TEST-customer' })).toBe(true);
  expect(mandateFormDirty({ ...untouched, amount: '5' })).toBe(true);
  expect(mandateFormDirty({ ...untouched, asset: 'EURC' })).toBe(true);
});
it('an emptied asset is not the default, so it is a change', () => {
  expect(mandateFormDirty({ ...untouched, asset: '' })).toBe(true);
});
