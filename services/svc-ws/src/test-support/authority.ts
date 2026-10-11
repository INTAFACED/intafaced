import { currentAuthorityResultSchema, type CurrentAuthorityInput, type CurrentAuthorityResult } from '@intafaced/contracts';
import type { CurrentAuthorityPort } from '../private/authority.js';

/** Explicit fixture injection only; production boot never selects this port. */
export function eligibleAuthority(subject: CurrentAuthorityInput, durationMs = 5000, at = Date.now()): CurrentAuthorityResult {
  const ref = subject.credential;
  return currentAuthorityResultSchema.parse({
    subject,
    checkedAt: new Date(at).toISOString(),
    status: 'eligible',
    account: { userId: subject.userId, status: 'active', kycTier: 'none' },
    credential: {
      kind: ref.kind,
      ownership: { id: ref.kind === 'session' ? ref.sessionId : ref.apiKeyId, userId: subject.userId, revoked: false },
    },
    subAccount: subject.subAccountId ? { id: subject.subAccountId, parentUserId: subject.userId, revoked: false } : null,
    version: '0',
    leaseExpiresAt: new Date(at + durationMs).toISOString(),
  });
}
export const TEST_AUTHORITY: CurrentAuthorityPort = {
  async read(subject) {
    return eligibleAuthority(subject);
  },
};
