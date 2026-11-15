// One kept sign-in per person for a journey's own reads through the API.
//
// (Failure it prevents: identity takes each authenticator step once, so a person with a second factor gets at most one new
// code per 30 seconds. J-bank-04 signed its sender in again, with a new code, for each of about 20 balance and list reads,
// and waited out a step for nearly every one: 18.8 of its minutes in main's run 43616532374, the second-longest file and a
// shard of its own. J-wallet-05 did the same once a step. A file runs whole in one shard, so the whole main run waited on
// it.) A code typed where the step is about the code (a sign-in, a step-up, a confirm) is still typed fresh each time;
// only the token a read rides on is kept, the way a signed-in person's app keeps it.
//
// `keptSession(signIn)` returns `token()`: the access token `signIn()` answered, reused until shortly before its own `exp`
// says it ends, and fetched again once `drop()` is called (a read refused 401) or the token cannot be read.

/** Milliseconds since the epoch at which a JWT's `exp` says it ends, or null when it names none. */
export function tokenEnds(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** A token is reused only while it has at least this much life left, so a read never rides on one about to end. */
export const KEEP_MARGIN_MS = 120_000;

export function keptSession(signIn, { now = () => Date.now(), marginMs = KEEP_MARGIN_MS } = {}) {
  let held = null;
  // Reads that ask at once share one sign-in, so they spend one code between them.
  let pending = null;
  const fetchOne = async () => {
    const fresh = await signIn();
    if (!fresh) throw new Error('the sign-in gave no access token');
    const ends = tokenEnds(fresh);
    // A token with no readable end is used once and never kept.
    held = ends === null ? null : { token: fresh, ends };
    return fresh;
  };
  const token = async () => {
    if (held && held.ends - marginMs > now()) return held.token;
    pending ??= fetchOne().finally(() => {
      pending = null;
    });
    return pending;
  };
  token.drop = () => {
    held = null;
  };
  return token;
}
