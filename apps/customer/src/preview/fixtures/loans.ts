import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the loans Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const loansFixture = definePreviewFixture<readonly SampleLine[]>('loans', 'Loan calculator: sample collateral and borrow limits.', [
  { label: 'Collateral', value: '1.00 BTC', detail: 'Sample' },
  { label: 'Borrow up to', value: '$38,500.00', detail: '60% loan to value' },
  { label: 'Margin call at', value: '75%', detail: 'Sample threshold' },
]);
