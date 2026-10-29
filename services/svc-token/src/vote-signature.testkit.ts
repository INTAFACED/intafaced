import type { WalletSignatureVerify } from '@intafaced/contracts';
import type { VoteSignaturePort } from './vote-signature.js';

/** A TEST signature string; it signs nothing. The stub below stands in for identity's check. */
export const TEST_VOTE_SIGNATURE = `0x${'ab'.repeat(65)}` as const;
/** The TEST wallet the stub answers as linked. */
export const TEST_VOTE_SIGNER = `0x${'cd'.repeat(20)}` as const;

/**
 * Identity's wallet-signature check, in memory: `TEST_VOTE_SIGNATURE` is linked, any other signature is not.
 * `answer` overrides the reply; `null` is identity not answering. Every ask is recorded.
 */
export function testVoteSignatures(answer?: WalletSignatureVerify | null): VoteSignaturePort & {
  asked: Array<{ userId: string; message: string; signature: string }>;
} {
  const asked: Array<{ userId: string; message: string; signature: string }> = [];
  return {
    asked,
    async verify(input) {
      asked.push(input);
      if (answer !== undefined) return answer;
      return input.signature === TEST_VOTE_SIGNATURE ? { state: 'linked', address: TEST_VOTE_SIGNER } : { state: 'not_linked' };
    },
  };
}
