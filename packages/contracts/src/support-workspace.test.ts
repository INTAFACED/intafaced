import { describe, expect, it } from 'vitest';
import { SUPPORT_WORKSPACE_ERROR_CODES, supportExpectedSequenceSchema, supportWorkspaceErrorCodeSchema } from './support-workspace.js';
import * as root from './index.js';

describe('support workspace codes', () => {
  it('names the stale refusal, the empty queue and the owner-change refusals, and nothing else', () => {
    expect(SUPPORT_WORKSPACE_ERROR_CODES).toEqual([
      'support.stale_ticket',
      'support.claim.queue_empty',
      'support.release.not_assignee',
      'support.not_lead',
      'support.not_staff',
    ]);
    expect(supportWorkspaceErrorCodeSchema.safeParse('support.claim.already_claimed').success).toBe(false);
  });
  it('takes a whole, non-negative trail sequence only', () => {
    expect(supportExpectedSequenceSchema.safeParse(0).success).toBe(true);
    expect(supportExpectedSequenceSchema.safeParse(-1).success).toBe(false);
    expect(supportExpectedSequenceSchema.safeParse(1.5).success).toBe(false);
    expect(supportExpectedSequenceSchema.safeParse('3').success).toBe(false);
  });
  it('is exported from the package root', () => {
    expect(root.SUPPORT_WORKSPACE_ERROR_CODES).toBe(SUPPORT_WORKSPACE_ERROR_CODES);
  });
});
