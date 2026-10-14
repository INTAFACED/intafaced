import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the futures Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const futuresFixture = definePreviewFixture<readonly SampleLine[]>(
  'futures',
  'BTC perpetual: sample mark price, funding and open interest.',
  [
    { label: 'Mark price', value: '$64,250.00', detail: 'BTC-USDT perpetual' },
    { label: 'Funding rate', value: '0.0100%', detail: 'Next funding in 3h 20m' },
    { label: 'Open interest', value: '$1,820,000,000', detail: 'All traders' },
    { label: 'Max leverage', value: '20x', detail: 'Sample limit' },
  ],
);
