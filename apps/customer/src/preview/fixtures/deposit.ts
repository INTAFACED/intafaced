import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the deposit Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const depositFixture = definePreviewFixture<readonly SampleLine[]>('deposit', 'Deposit: sample network and address.', [
  { label: 'Network', value: 'Sample network', detail: 'Pick the network you send on' },
  { label: 'Address', value: 'sample-address-not-real', detail: 'Not a real address' },
  { label: 'Minimum deposit', value: '10.00 USDT', detail: 'Sample' },
]);
