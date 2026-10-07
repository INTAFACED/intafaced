import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { createApiClient, type ApiClient, type ApiResult } from '../../shared/api';

export const sessionSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.string().datetime({ offset: true }), userId: z.string().uuid() });
export type Session = z.infer<typeof sessionSchema>;
type SessionContext = { session: Session | null; api: ApiClient; commit: (session: Session) => void; logout: () => Promise<ApiResult<{ ok: true }>>; mode: 'Personal' | 'Business'; userId: string | null };
const Context = createContext<SessionContext | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef(session); current.current = session;
  const api = useMemo(() => createApiClient({ token: () => current.current?.accessToken, onUnauthorized: () => setSession(null) }), []);
  useEffect(() => {
    if (!session) return;
    const deadline = Date.parse(session.expiresAt);
    if (!Number.isFinite(deadline)) { setSession(null); return; }
    const timeout = setTimeout(() => {
      void api.mutate('identity', 'auth.refresh', { refreshToken: session.refreshToken }, sessionSchema).then((result) => { if (current.current?.refreshToken === session.refreshToken) setSession(result.ok ? result.data : null); });
    }, Math.max(0, Math.min(2_147_483_647, deadline - Date.now() - 30_000)));
    return () => clearTimeout(timeout);
  }, [api, session]);
  async function logout() {
    const previous = current.current;
    setSession(null);
    if (!previous) return { ok: true as const, data: { ok: true as const } };
    return api.mutate('identity', 'auth.logout', { refreshToken: previous.refreshToken }, z.object({ ok: z.literal(true) }));
  }
  return <Context.Provider value={{ session, api, commit: (value) => setSession(sessionSchema.parse(value)), logout, mode: 'Personal', userId: session?.userId ?? null }}>{children}</Context.Provider>;
}
export function useSession() { const context = useContext(Context); if (!context) throw new Error('SessionProvider is required'); return context; }
export function useApi() { return useSession().api; }
