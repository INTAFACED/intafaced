import { describe, expect, it } from 'vitest';
import {
  COMPLIANCE_CASE_REFUSAL_CODES,
  complianceCasesListInputSchema,
  complianceQueueBusinessKey,
  complianceQueueDefineInputSchema,
} from './ops-compliance-cases.js';

describe('compliance cases', () => {
  it('lets a blank list limit through so svc-ops can refuse it by name', () => {
    const parsed = complianceCasesListInputSchema.parse({ inboxId: 'inbox-1' });
    expect(parsed.limit).toBeUndefined();
    expect(parsed.groupByReviewLevel).toBe(false);
  });

  it('lets an unknown entity type reach the typed refusal', () => {
    expect(
      complianceQueueDefineInputSchema.safeParse({ name: 'q', version: 1, entityType: 'spaceship', workflow: 'default' }).success,
    ).toBe(true);
  });

  it('builds the queue business key from the name and version, never a clock', () => {
    expect(complianceQueueBusinessKey('high-risk', 3)).toBe('compliance:queue:high-risk:3');
  });

  it('names every refusal in the compliance namespace', () => {
    for (const code of COMPLIANCE_CASE_REFUSAL_CODES) expect(code.startsWith('compliance.')).toBe(true);
  });
});
