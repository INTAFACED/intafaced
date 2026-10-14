import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the copy Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const copyFixture = definePreviewFixture<readonly SampleLine[]>('copy', 'Copy trading leaderboard: sample traders.', [
  { label: 'Trader A', value: '+18.4%', detail: '30-day sample return' },
  { label: 'Trader B', value: '+9.7%', detail: '30-day sample return' },
  { label: 'Trader C', value: '+4.2%', detail: '30-day sample return' },
]);
