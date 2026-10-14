import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the agents Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const agentsFixture = definePreviewFixture<readonly SampleLine[]>('agents', 'Agent suggestions: sample, you approve each one.', [
  { label: 'Navigator', value: 'Consider a limit buy near $63,800.00', detail: 'Sample suggestion' },
  { label: 'Scanner', value: 'ETH volume is up 2.1x', detail: 'Sample signal' },
]);
