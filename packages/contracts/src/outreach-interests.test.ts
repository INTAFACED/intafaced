import { describe, expect, it } from 'vitest';
import { outreachAddInterestsInputSchema } from './outreach-interests.js';

const input = {
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  submissionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  continuationToken: 'A'.repeat(43),
  expectedRevision: 2,
  interests: ['merchant', 'academy'],
};
describe('additive prospect interests', () => {
  it('accepts bounded additional audiences with the existing continuation proof', () => {
    expect(outreachAddInterestsInputSchema.parse(input)).toEqual(input);
  });
  it('rejects missing capability, duplicate interests, unsafe revisions, removals and staff injection', () => {
    for (const changed of [
      { continuationToken: '' },
      { interests: [] },
      { interests: ['merchant', 'merchant'] },
      { expectedRevision: 9007199254740992 },
      { remove: ['investor'] },
      { actorUserId: input.requestId },
    ])
      expect(outreachAddInterestsInputSchema.safeParse({ ...input, ...changed }).success).toBe(false);
  });
});
