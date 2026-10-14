import { definePreviewFixture, type SampleLine } from './types';

/** SAMPLE data for the ifc Preview. Invented numbers; never mixed with real data. See ../README.md. */
export const ifcFixture = definePreviewFixture<readonly SampleLine[]>('ifc', 'IFC tiers: sample fee discounts.', [
  { label: 'Tier 1', value: '5% off fees', detail: 'Sample: hold 100 IFC' },
  { label: 'Tier 2', value: '10% off fees', detail: 'Sample: hold 1,000 IFC' },
  { label: 'Tier 3', value: '20% off fees', detail: 'Sample: hold 10,000 IFC' },
]);
