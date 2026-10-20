import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../shared/api';
import { createSessionController, sessionSchema, type Session, type SessionNotice } from './session-restore';
import { useProfiles, type Profiles } from './use-profiles';

export { sessionSchema, type Session };
type SessionContext = {
  session: Session | null;
  api: ApiClient;
  commit: (session: Session) => void;
  clear: () => void;
  logout: () => Promise<ApiResult<{ ok: true }>>;
  /** True until the boot refresh has answered. A private room waits; a public room does not. */
  restoring: boolean;
  /** The boot refresh could not reach the service: show Retry, not a sign-in prompt. The cookie is untouched. */
  restoreFailed: boolean;
  retryRestore: () => void;
  /** Why the server ended the session, when it said (sign-in used elsewhere, frozen account). */
  notice: SessionNotice | null;
  /** Ask the server again to end the session after a logout it did not confirm. */
  retryLogout: () => Promise<ApiResult<{ ok: true }>>;
  /** Derived from the profile in view: Business only while the person has picked a business they belong to. */
  mode: 'Personal' | 'Business';
  /** The profiles the person can pick and the one in view. */
  profiles: Profiles;
  userId: string | null;
};
const Context = createContext<SessionContext | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(createSessionController);
  const { session, restoring, restoreFailed, notice } = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const accessToken = session?.accessToken;
  useEffect(() => {
    void controller.start();
    return () => controller.stop();
  }, [controller]);
  const api = useMemo(
    () =>
      createApiClient({
        token: () => accessToken,
        canWrite: () => controller.getState().session?.accessToken === accessToken,
        onUnauthorized: (requestToken) => {
          if (requestToken && controller.getState().session?.accessToken === requestToken) controller.clear();
        },
      }),
    [accessToken, controller],
  );
  const profiles = useProfiles(api, session?.userId ?? null);
  return (
    <Context.Provider
      value={{
        session,
        api,
        commit: controller.commit,
        clear: controller.clear,
        logout: controller.logout,
        restoring,
        restoreFailed,
        retryRestore: () => void controller.retryRestore(),
        notice,
        retryLogout: controller.retryLogout,
        mode: profiles.business ? 'Business' : 'Personal',
        profiles,
        userId: session?.userId ?? null,
      }}
    >
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
