import { useState, type ReactNode } from 'react';
import { HideBalancesProvider, ToastProvider, TooltipProvider } from '@intafaced/ui';
import { useSession } from '../features/session/session';
import { usePreferences } from '../shared/preferences';
import type { Door } from './navigation';
import { shellCopy } from './shell-copy';
import { MobileTabs, TopBar } from './TopBar';

/** The signed-in frame (UI-SPEC 3.1): sticky top bar, content, phone tab bar. New screens render straight into `main`; old views are wrapped in `.legacy-room` by their caller. */
export function Shell({ door, path, children }: { door?: Door; path: string; children: ReactNode }) {
  const { t } = shellCopy.useCopy();
  const { language, hideBalances } = usePreferences();
  const { logout } = useSession();
  const [logoutNote, setLogoutNote] = useState<'confirmed' | 'local-only' | null>(null);
  return (
    <HideBalancesProvider hidden={hideBalances}>
      <TooltipProvider>
        {/* The one toast host for the whole app: screens call useToast() and never mount their own. */}
        <ToastProvider>
          <div className="if-app">
            <a href="#main" className="skip-link">
              {t('Skip to content')}
            </a>
            <TopBar
              door={door}
              path={path}
              onSignOut={() => void logout().then((result) => setLogoutNote(result.ok ? 'confirmed' : 'local-only'))}
            />
            <main id="main" tabIndex={-1}>
              {logoutNote && (
                <p className="tb-note" role="status">
                  {logoutNote === 'confirmed'
                    ? t('Signed out.')
                    : t(
                        'Signed out on this device. The server could not confirm session revocation; use Sign out everywhere after reconnecting.',
                      )}
                </p>
              )}
              {children}
            </main>
            <MobileTabs door={door} language={language} />
          </div>
        </ToastProvider>
      </TooltipProvider>
    </HideBalancesProvider>
  );
}
