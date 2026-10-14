import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the p2p Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const p2pFixture = definePreviewFixture<readonly SampleLine[]>('p2p', 'P2P ads: sample prices and limits.', [
  { label: 'Buy USDT', value: '1.002 USD', detail: 'Limits $100.00 to $2,000.00' },
  { label: 'Sell USDT', value: '0.998 USD', detail: 'Limits $50.00 to $1,500.00' },
]);
