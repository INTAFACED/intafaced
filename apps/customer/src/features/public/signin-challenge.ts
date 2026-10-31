import { signInChallengeSchema, type SignInChallenge, type SignInChallengeProof } from '@intafaced/contracts/identity-signin-challenge';
import type { ApiClient, ApiResult } from '../../shared/api';

/** The challenge `auth.login` asks for once this address had too many failed sign-ins (I-signin-sessions-30). */
export function fetchSignInChallenge(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<SignInChallenge>> {
  return api.mutate('identity', 'auth.challenge', undefined, signInChallengeSchema, signal ? { signal } : {});
}

/**
 * Solves the challenge in a worker, so the page stays responsive and can show its progress. `onProgress` gets the
 * number of tries so far. Rejects with an AbortError when `signal` aborts.
 */
export function solveSignInChallenge(
  challenge: SignInChallenge,
  signal: AbortSignal,
  onProgress: (tries: number) => void,
): Promise<SignInChallengeProof> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./signin-challenge.worker.ts', import.meta.url), { type: 'module' });
    const stop = () => {
      worker.terminate();
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    worker.onmessage = (event: MessageEvent<{ nonce?: string; tries?: number }>) => {
      if (event.data.tries !== undefined) onProgress(event.data.tries);
      if (event.data.nonce !== undefined) {
        signal.removeEventListener('abort', stop);
        worker.terminate();
        resolve({ token: challenge.token, nonce: event.data.nonce });
      }
    };
    worker.onerror = (event) => {
      signal.removeEventListener('abort', stop);
      worker.terminate();
      reject(new Error(event.message || 'challenge worker failed'));
    };
    worker.postMessage({ token: challenge.token, bits: challenge.bits });
  });
}
