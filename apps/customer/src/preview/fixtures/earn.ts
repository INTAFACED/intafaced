import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the earn Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const earnFixture = definePreviewFixture<readonly SampleLine[]>('earn', 'Earn products: sample yields.', [
  { label: 'Flexible USDT', value: '4.20%', detail: 'Sample APR, withdraw anytime' },
  { label: 'Fixed 30-day USDT', value: '6.10%', detail: 'Sample APR, locked 30 days' },
  { label: 'Flexible BTC', value: '1.10%', detail: 'Sample APR' },
]);
