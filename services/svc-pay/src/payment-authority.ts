import { createHash } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import type { IdentityOperationIntent } from '@intafaced/contracts';
import type { Sql } from 'postgres';
/** Owner-only seam: resolve immutable provenance and recheck it under the merchant guard. */
export interface OwnerIdentityAuthorityPort {
  resolve(
    tx: Sql,
    operation: Extract<IdentityOperationIntent['operation'], { service: 'svc-pay' }>,
    authority: IdentityOperationIntent['authority'],
  ): Promise<IdentityOperationIntent['authority']>;
  validate(tx: Sql, authority: IdentityOperationIntent['authority']): Promise<void>;
}
/** Server-derived from the authenticated principal; never read from an operation body. */
export function credentialAuthority(principal: Principal): IdentityOperationIntent['authority'] {
  return {
    kind: 'credential',
    subject: {
      userId: principal.userId,
      credential: principal.kid ? { kind: 'api_key', apiKeyId: principal.kid } : { kind: 'session', sessionId: principal.sid },
      ...(principal.sub_account ? { subAccountId: principal.sub_account } : {}),
    },
  };
}
/** Existing opaque REST idempotency keys identify one original creation, including crash recovery. */
export function restPaymentCreationId(userId: string, key: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['svc-pay', 'rest.payment.create', userId.toLowerCase(), key]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
