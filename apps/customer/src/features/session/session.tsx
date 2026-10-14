import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../shared/api';
import { sessionSchema, type Session } from './session-schema';
import { getSessionSync } from './session-sync';

export { sessionSchema, type Session };
type SessionContext = {
  session: Session | null;
  /** True from the first paint until the page has asked the edge whether a cookie session exists. Private rooms wait on it. */
  restoring: boolean;
  api: ApiClient;
  commit: (session: Session) => void;
  clear: () => void;
  logout: () => Promise<ApiResult<{ ok: true }>>;
  mode: 'Personal' | 'Business';
  userId: string | null;
};
const Context = createContext<SessionContext | null>(null);

/** A request that fails right after a recovery is a real refusal, not a stale token. */
const RECOVERY_COOLDOWN_MS = 5_000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const sync = getSessionSync();
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef(session);
  const recoveredAt = useRef(0);
  const recovering = useRef<Promise<void> | null>(null);
  const [restoring, setRestoring] = useState(() => sync.mightBeSignedIn());
  const accessToken = session?.accessToken;
  function clear() {
    current.current = null;
    setSession(null);
  }
  /** Take a session another tab or the refresh door produced. Already published; do not announce again. */
  function adopt(value: Session) {
    current.current = value;
    setSession(value);
  }
  function commit(value: Session) {
    const validated = sessionSchema.parse(value);
    adopt(validated);
    sync.announce(validated);
  }
  const api = useMemo(
    () =>
      createApiClient({
        token: () => accessToken,
        canWrite: () => current.current?.accessToken === accessToken,
        onUnauthorized: (requestToken) => {
          if (!requestToken || current.current?.accessToken !== requestToken) return;
          // The token may only be stale: another tab can have rotated the session (which retires this
          // tab's access token). Ask for the current one before giving up on the sign-in.
          if (recovering.current) return; // a recovery is already in flight; it decides for every request
          if (Date.now() - recoveredAt.current < RECOVERY_COOLDOWN_MS) {
            clear();
            return;
          }
          recoveredAt.current = Date.now();
          recovering.current = sync.refresh({ staleToken: requestToken }).then((outcome) => {
            recovering.current = null;
            if (current.current?.accessToken !== requestToken) return;
            if (outcome.kind === 'session') adopt(outcome.session);
            else clear();
          });
        },
      }),
    [accessToken],
  );

  // Load: no session in memory, so ask the edge to turn the cookie (if any) into an access token.
  useEffect(() => {
    if (!restoring) return;
    let live = true;
    void sync.restore().then((outcome) => {
      if (!live) return;
      // Never replace a session something else committed while this was in flight.
      if (outcome.kind === 'session' && !current.current) adopt(outcome.session);
      setRestoring(false);
    });
    return () => {
      live = false;
    };
  }, []);

  // Other tabs: follow their sign-in, their rotation and their sign-out.
  useEffect(
    () =>
      sync.subscribe((message) => {
        if (message.type === 'session') adopt(message.session);
        else clear();
      }),
    [],
  );

  // Renew the access token shortly before it expires. Tabs share one refresh through the lock.
  useEffect(() => {
    if (!session) return;
    const deadline = Date.parse(session.expiresAt);
    if (!Number.isFinite(deadline)) {
      clear();
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      void sync.refresh({ staleToken: session.accessToken }).then((outcome) => {
        // Another tab (or a sign-in) already moved this tab on: nothing to do here.
        if (cancelled || current.current?.accessToken !== session.accessToken) return;
        if (outcome.kind === 'session') adopt(outcome.session);
        else if (outcome.kind === 'signed-out') clear();
        // The edge was unreachable: the cookie is intact, so keep trying until the token really expires.
        else if (Date.now() < deadline) timer = setTimeout(attempt, 10_000);
        else clear();
      });
    };
    timer = setTimeout(attempt, Math.max(0, Math.min(2_147_483_647, deadline - Date.now() - 30_000)));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session]);

  async function logout() {
    clear();
    // Revoke even with nothing in memory: after a reload the cookie may be all this tab has.
    return sync.logout();
  }
  return (
    <Context.Provider value={{ session, restoring, api, commit, clear, logout, mode: 'Personal', userId: session?.userId ?? null }}>
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const context = useContext(Context);
  if (!context) throw new Error('SessionProvider is required');
  return context;
}
export function useApi() {
  return useSession().api;
}
