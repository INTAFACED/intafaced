/// <reference lib="webworker" />
import { signInChallengeMet, signInChallengeText } from '@intafaced/contracts/identity-signin-challenge';

/**
 * Solves one sign-in challenge (I-signin-sessions-30) off the page's thread: finds a nonce whose SHA-256 over the
 * challenge text starts with the asked number of zero bits, posting how many tries it took every so often.
 */
self.onmessage = async (event: MessageEvent<{ token: string; bits: number }>) => {
  const { token, bits } = event.data;
  const encoder = new TextEncoder();
  for (let n = 0; ; n += 1) {
    const nonce = n.toString(36);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(signInChallengeText(token, nonce))));
    if (signInChallengeMet(digest, bits)) {
      self.postMessage({ nonce });
      return;
    }
    if (n % 2000 === 1999) self.postMessage({ tries: n + 1 });
  }
};
