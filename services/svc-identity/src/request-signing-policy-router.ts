import { router } from '@intafaced/contracts/trpc';
import { requestSigningPolicySchema } from '@intafaced/contracts/api-keys';
import { requestSigningPolicy } from './auth/api-key-request-sign.js';
import { IDENTITY_REQUEST_SIGNING_POLICY } from '@intafaced/contracts/identity-request-signing-policy-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from './record-refusal.js';

/**
 * The published request-signing policy (DV-auth-01, J-developer-04 #1 and #2): the owner's timestamp window and one
 * TEST request signed by this service's own signer. Public: it names no key and no account, and the developer pages
 * read it before anyone signs in. Top level, like `setApiKeyRequestSigning`, so no merge can replace `apiKeys.*`.
 */
export function createRequestSigningPolicyRouter(windowSeconds: number | null) {
  const policy = requestSigningPolicySchema.parse(requestSigningPolicy(windowSeconds));
  return router({
    requestSigningPolicy: mountRecord(IDENTITY_REQUEST_SIGNING_POLICY, () => policy, codedRefusal),
  });
}
