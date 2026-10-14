import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the academy Preview. Invented lessons; never mixed with real data. See ../README.md. */
export const academyFixture = definePreviewFixture<readonly SampleLine[]>('academy', 'Academy: sample lessons and certificates.', [
  { label: 'Start here: how an order works', value: '12 min', detail: 'Sample lesson' },
  { label: 'Reading an order book', value: '18 min', detail: 'Sample lesson' },
  { label: 'Risk basics certificate', value: 'Not started', detail: 'Sample certificate' },
]);
