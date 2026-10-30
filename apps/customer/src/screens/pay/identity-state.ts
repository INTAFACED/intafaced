import { useEffect, useState } from 'react';
import { fetchMe, type ApiClient } from './deps';

/**
 * What this server can do about handles, read once per screen:
 *   - `handles`: `identity.me` answered; Send looks people up by @handle and Receive shows the customer's own.
 *   - `accountId`: the server has no handle procedures yet (404/501), so Send takes an Account ID and Receive shows it.
 *   - `error`: we could not tell (network or server error); the screen says so and offers a retry. It never guesses.
 *
 * `renamed` takes the handle the service answered after a change (PP-send-request-03), so every tab shows it at once.
 */
export type IdentityState =
  | { status: 'loading' }
  | { status: 'handles'; handle: string; renamed?: (handle: string) => void }
  | { status: 'accountId' }
  | { status: 'error'; retry: () => void };

export function useIdentity(api: ApiClient, userId: string | null): IdentityState {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; value: Exclude<IdentityState, { status: 'error' }> | 'error' }>({
    key: '',
    value: { status: 'loading' },
  });
  const key = `${userId}:${revision}`;
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void fetchMe(api, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      // The answer must be about the signed-in person. Anything else is a bad answer, not a handle to show.
      if (outcome.kind === 'ok')
        setState({ key, value: outcome.userId === userId ? { status: 'handles', handle: outcome.handle } : 'error' });
      else setState({ key, value: outcome.kind === 'unavailable' ? { status: 'accountId' } : 'error' });
    });
    return () => controller.abort();
  }, [api, userId, key]);
  if (!userId || state.key !== key) return { status: 'loading' };
  if (state.value === 'error') return { status: 'error', retry: () => setRevision((n) => n + 1) };
  if (state.value.status === 'handles')
    return { ...state.value, renamed: (handle: string) => setState({ key, value: { status: 'handles', handle } }) };
  return state.value;
}
