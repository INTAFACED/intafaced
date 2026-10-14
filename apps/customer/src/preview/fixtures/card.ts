import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the card Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const cardFixture = definePreviewFixture<readonly SampleLine[]>('card', 'Card: sample limits and spend.', [
  { label: 'Monthly limit', value: '$5,000.00', detail: 'Sample' },
  { label: 'Spent this month', value: '$412.30', detail: 'Sample' },
  { label: 'Card status', value: 'Not issued', detail: 'Sample' },
]);
