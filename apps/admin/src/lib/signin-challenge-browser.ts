import {
  signInChallengeMet,
  signInChallengeText,
  type SignInChallenge,
  type SignInChallengeProof,
} from '@intafaced/contracts/identity-signin-challenge';

/**
 * Solves identity's sign-in challenge (I-signin-sessions-30) in the founder's browser: a nonce whose SHA-256 over the
 * challenge text starts with the asked number of zero bits. Yields to the page now and then and reports the tries so
 * far; gives up when the token expires, since identity would refuse the answer anyway.
 */
export async function solveSignInChallenge(
  challenge: SignInChallenge,
  onProgress: (tries: number) => void,
  now: () => number = Date.now,
): Promise<SignInChallengeProof> {
  const encoder = new TextEncoder();
  const expiresAt = Date.parse(challenge.expiresAt);
  for (let n = 0; ; n += 1) {
    const nonce = n.toString(36);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(signInChallengeText(challenge.token, nonce))));
    if (signInChallengeMet(digest, challenge.bits)) return { token: challenge.token, nonce };
    if (n % 2000 === 1999) {
      if (now() >= expiresAt) throw new Error('The sign-in check ran out of time. Sign in again to get a new one.');
      onProgress(n + 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
