import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the withdraw Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const withdrawFixture = definePreviewFixture<readonly SampleLine[]>('withdraw', 'Withdraw: sample fee and limit.', [
  { label: 'Network fee', value: '1.00 USDT', detail: 'Sample' },
  { label: 'Daily limit', value: '$10,000.00', detail: 'Sample' },
  { label: 'Steps', value: 'Address, amount, confirm', detail: 'Sample' },
]);
