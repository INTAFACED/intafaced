import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the options Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const optionsFixture = definePreviewFixture<readonly SampleLine[]>('options', 'BTC options: sample expiry, strikes and prices.', [
  { label: 'Expiry', value: 'Fri 27 Mar', detail: 'Sample' },
  { label: 'Call 65,000', value: '$1,420.00', detail: 'Implied volatility 52%' },
  { label: 'Put 63,000', value: '$1,180.00', detail: 'Implied volatility 54%' },
]);
