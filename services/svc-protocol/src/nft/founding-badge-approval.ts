import { createIdentityApprovalClient } from '@intafaced/contracts';
import { BADGE_STUCK_APPROVAL_REFUSED, BadgeRefusedError, type BadgeApprovalConsumer } from './founding-badge.js';

/**
 * Identity action-approval consumer for the founding-badge stuck-mint clear (RC-more-catalogue-04 review).
 * Shared-secret (dual) mode only: svc-protocol has no S2S signing key. Either setting blank returns null, and the
 * clear refuses `badge.stuck_approval_unwired`; no second person is ever invented.
 */
export function badgeApprovalConsumer(identityUrl: string | undefined, internalSecret: string | undefined): BadgeApprovalConsumer | null {
  if (!identityUrl || !internalSecret) return null;
  return createIdentityApprovalClient({
    service: 'svc-protocol',
    baseUrl: identityUrl,
    internalSecret,
    timeoutMs: 2_000,
    fail: (message) => new BadgeRefusedError(BADGE_STUCK_APPROVAL_REFUSED, message),
  });
}
