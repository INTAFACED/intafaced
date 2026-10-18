import { useState, type ReactNode } from 'react';
import { HideBalancesProvider, ToastProvider, TooltipProvider } from '@intafaced/ui';
import { useSession } from '../features/session/session';
import { usePreferences } from '../shared/preferences';
import type { Door } from './navigation';
import { shellCopy } from './shell-copy';
import { MobileTabs, TopBar } from './TopBar';
import { isMerchantArea } from '../features/pay/portal/chrome/model';
import { SessionNotice } from './SessionNotice';
import { Button } from '../shared/ui';

/** The signed-in frame (UI-SPEC 3.1): sticky top bar, content, phone tab bar. New screens render straight into `main`; old views are wrapped in `.legacy-room` by their caller. */
export function Shell({ door, path, children }: { door?: Door; path: string; children: ReactNode }) {
  const { t } = shellCopy.useCopy();
  const { language, hideBalances } = usePreferences();
  const { logout, retryLogout } = useSession();
  const [logoutNote, setLogoutNote] = useState<'confirmed' | 'not-confirmed' | null>(null);
  return (
    <HideBalancesProvider hidden={hideBalances}>
      <TooltipProvider>
        {/* The one toast host for the whole app: screens call useToast() and never mount their own. */}
        <ToastProvider>
          <div className={isMerchantArea(path) ? 'if-app pfo-app' : 'if-app'}>
            <a href="#main" className="skip-link">
              {t('Skip to content')}
            </a>
            <TopBar
              door={door}
              path={path}
              onSignOut={() => void logout().then((result) => setLogoutNote(result.ok ? 'confirmed' : 'not-confirmed'))}
            />
            <main id="main" tabIndex={-1}>
              {logoutNote === 'confirmed' && (
                <p className="tb-note" role="status">
                  {t('Signed out.')}
                </p>
              )}
              {logoutNote === 'not-confirmed' && (
                // The server did not confirm: its cookie still signs this browser in on reload, so do not say "signed out".
                <p className="tb-note" role="status">
                  {t('Not signed out yet. Reloading would sign you back in.')}{' '}
                  <Button
                    variant="secondary"
                    onClick={() => void retryLogout().then((result) => setLogoutNote(result.ok ? 'confirmed' : 'not-confirmed'))}
                  >
                    {t('Retry')}
                  </Button>
                </p>
              )}
              <SessionNotice />
              {children}
            </main>
            {!isMerchantArea(path) && <MobileTabs door={door} language={language} />}
          </div>
        </ToastProvider>
      </TooltipProvider>
    </HideBalancesProvider>
  );
}
