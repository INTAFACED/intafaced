import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the bots Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const botsFixture = definePreviewFixture<readonly SampleLine[]>('bots', 'Grid and DCA bots: sample settings.', [
  { label: 'Grid range', value: '$60,000.00 to $68,000.00', detail: 'BTC-USDT' },
  { label: 'Grids', value: '24', detail: 'Sample' },
  { label: 'Daily DCA', value: '$25.00', detail: 'Sample' },
]);
