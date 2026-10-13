/** Obtain the current session nonce without exposing credentials to browser code. */
export async function founderMutationHeaders(): Promise<Record<string, string>> {
  const response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Your founder session is unavailable. Sign in again.');
  const session: unknown = await response.json();
  if (
    typeof session !== 'object' ||
    session === null ||
    !('csrf' in session) ||
    typeof session.csrf !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(session.csrf)
  )
    throw new Error('The founder session could not be confirmed. Sign in again.');
  return { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf };
}
