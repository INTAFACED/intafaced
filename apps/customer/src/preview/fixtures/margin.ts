import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the margin Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const marginFixture = definePreviewFixture<readonly SampleLine[]>(
  'margin',
  'Spot margin: sample borrow, ratio and liquidation price.',
  [
    { label: 'Margin ratio', value: '245%', detail: 'Sample' },
    { label: 'Borrowed', value: '1,000.00 USDT', detail: 'Sample' },
    { label: 'Liquidation price', value: '$41,300.00', detail: 'BTC-USDT' },
  ],
);
