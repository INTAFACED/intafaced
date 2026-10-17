import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../shared/api';
import { createSessionController, sessionSchema, type Session } from './session-restore';

export { sessionSchema, type Session };
type SessionContext = {
  session: Session | null;
  api: ApiClient;
  commit: (session: Session) => void;
  clear: () => void;
  logout: () => Promise<ApiResult<{ ok: true }>>;
  /** True until the boot refresh has answered. A private room waits; a public room does not. */
  restoring: boolean;
  mode: 'Personal' | 'Business';
  userId: string | null;
};
const Context = createContext<SessionContext | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(createSessionController);
  const { session, restoring } = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
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
  return (
    <Context.Provider
      value={{
        session,
        api,
        commit: controller.commit,
        clear: controller.clear,
        logout: controller.logout,
        restoring,
        mode: 'Personal',
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
