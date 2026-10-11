import { currentAuthorityInputSchema, currentAuthorityResultSchema, type KycTierValue } from '@intafaced/contracts';

/** Synthetic currentAuthority replies for edge perimeter tests. */
export function currentAuthorityTestReply(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  state: {
    expectedUserId: string;
    expectedCredentialId: string;
    accountStatus?: string;
    credentialRevoked?: boolean;
    currentTier?: KycTierValue;
  },
): Response | undefined {
  if (!String(input).endsWith('/trpc/accountControls.currentAuthority')) return undefined;

  const subject = currentAuthorityInputSchema.parse(JSON.parse(String(init?.body)) as unknown);
  const checkedAt = new Date();
  const timestamp = checkedAt.toISOString();
  const credentialId = subject.credential.kind === 'session' ? subject.credential.sessionId : subject.credential.apiKeyId;
  if (subject.userId !== state.expectedUserId || credentialId !== state.expectedCredentialId) {
    const denial = currentAuthorityResultSchema.parse({ status: 'denied', subject, checkedAt: timestamp, code: 'auth.credential_denied' });
    return Response.json({ result: { data: denial } });
  }
  if (state.accountStatus && state.accountStatus !== 'active') {
    const denial = currentAuthorityResultSchema.parse({ status: 'denied', subject, checkedAt: timestamp, code: 'auth.account_frozen' });
    return Response.json({ result: { data: denial } });
  }
  if (state.credentialRevoked) {
    const denial = currentAuthorityResultSchema.parse({ status: 'denied', subject, checkedAt: timestamp, code: 'auth.credential_revoked' });
    return Response.json({ result: { data: denial } });
  }

  const proof = currentAuthorityResultSchema.parse({
    status: 'eligible',
    subject,
    checkedAt: timestamp,
    leaseExpiresAt: new Date(checkedAt.getTime() + 4000).toISOString(),
    account: { userId: state.expectedUserId, status: 'active', kycTier: state.currentTier ?? 'none' },
    credential: {
      kind: subject.credential.kind,
      ownership: { id: state.expectedCredentialId, userId: state.expectedUserId, revoked: false },
    },
    subAccount: null,
    version: '0',
  });
  return Response.json({ result: { data: proof } });
}
