/**
 * Signed governance votes (MC-token-03, J-more-catalogue-09 #7). A vote is the canonical message below, signed by a
 * wallet the person linked through identity. Identity holds the links and checks the signer
 * (`POST /internal/wallet-signatures/verify`); svc-token keeps no copy.
 *
 * An unreachable identity, an unset IDENTITY_URL, an unreadable answer, an account with no linked wallet or one that may
 * not act refuse `token.signed_vote_unavailable`. A signature from no linked wallet refuses
 * `token.vote_signature_invalid`. Nothing is stored on a refusal.
 */
import {
  serviceCallSigner,
  WALLET_SIGNATURE_VERIFY_PATH,
  walletSignatureVerifySchema,
  type ServiceAuthMode,
  type ServiceSigner,
  type WalletSignatureVerify,
} from '@intafaced/contracts';
import type { Ballot } from './ballot-tally.js';
import type { VoteChoice } from './token-service.js';

export interface VoteSignaturePort {
  /** Identity's answer, or `null` when it could not be asked or read. */
  verify(input: { userId: string; message: string; signature: string }): Promise<WalletSignatureVerify | null>;
}

/** The exact text a wallet signs for one vote. Keys in a fixed order, so the browser and the service build the same bytes. */
export function voteMessage(input: { proposalId: string; userId: string; choice?: VoteChoice; ballot?: Ballot }): string {
  const vote =
    input.ballot === undefined
      ? { choice: input.choice ?? null }
      : {
          ballot:
            input.ballot.kind === 'abstain'
              ? { kind: 'abstain' }
              : input.ballot.kind === 'pick'
                ? { kind: 'pick', choices: [...input.ballot.choices] }
                : { kind: 'split', parts: input.ballot.parts.map((part) => ({ choice: part.choice, bps: part.bps })) },
        };
  return JSON.stringify({
    purpose: 'INTAFACED governance vote',
    origin: 'svc-token',
    proposalId: input.proposalId,
    userId: input.userId,
    ...vote,
  });
}

const FETCH_MS = 3_000;

export function createIdentityVoteSignatures(
  baseUrl: string,
  internalSecret: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): VoteSignaturePort {
  const target = `${baseUrl.replace(/\/+$/, '')}${WALLET_SIGNATURE_VERIFY_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-token', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async verify(input) {
      const raw = JSON.stringify(input);
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...sign(raw, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
          },
          body: raw,
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch {
        return null;
      }
      if (!response.ok) return null;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }
      const parsed = walletSignatureVerifySchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    },
  };
}
