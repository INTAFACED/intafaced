import { Suspense, type ComponentType } from 'react';
import { BrandLockup, BrandWordmark } from '@intafaced/ui';
import { useSession } from '../session';
import { Page, EmptyState } from '../../shared/ui';
import { AuthForm } from './AuthForm';
import { SignUp } from './SignUp';
import { CannotSignIn } from './CannotSignIn';
import { ConfirmEmail } from './ConfirmEmail';
import { RecoverAccount } from './RecoverAccount';
import { FreezeConfirm } from './FreezeConfirm';
import { AppealSignedOut } from './AppealSignedOut';
import { Invitation } from './Invitation';
import { DevelopersRoutes } from '../developers';
import { PublicHelp as Help } from './PublicHelp';
import { HelpLibrary } from './HelpLibrary';
import { helpLibraryPath } from './help-library';
import { findRoom, roomTitle } from '../../app/navigation';
import { publicAuthContext, publicAuthHref } from './auth-context';
import './public.css';
import { publicCopy } from './public-copy';
import { PasswordRecovery } from './PasswordRecovery';
import { NoticePage } from './PublicPages';
import { AboutPage } from './AboutPage';
import { AppPage } from './AppPage';
import { PartnerPage } from './PartnerPage';
import { HomePage } from './HomePage';
import { LabPage } from './LabPage';
import { OfficialChannels } from './OfficialChannels';
import { MulePolicy } from './MulePolicy';
import { FeesPage } from './FeesPage';
import { MyTierPage } from './MyTierPage';
import { RulebookRoom } from './rulebook/RulebookRoom';
import { StatusPage } from './StatusPage';
import { StatusSubscriptionPage } from './StatusSubscription';
import { GuestChat, GuestNewRequest, GuestRequest, GuestVerify } from '../more';

/** The public header carries the horizontal lockup (mark 28 pixels, small drawing); the footer line the wordmark alone. */
function Brand({ footer }: { footer?: boolean }) {
  return (
    <a href="/" className="brand" aria-label="INTAFACED">
      {footer ? <BrandWordmark width={150} /> : <BrandLockup size={28} title="" />}
    </a>
  );
}
/** The public header follows the session: a signed-in visitor gets a way back into the app, a signed-out one gets Sign in. */
export function PublicHeader({ path }: { path: string }) {
  const { t } = publicCopy.useCopy();
  const { session, restoreFailed } = useSession();
  const alternateAuth = path.startsWith('/login') ? '/register' : '/login';
  const authHref = publicAuthHref(publicAuthContext(path, location.search), alternateAuth);
  return (
    <header className="public-header">
      <Brand />
      <nav aria-label={t('Public navigation')}>
        <a href="/exchange">{t('Trade')}</a>
        <a href="/help">{t('Help')}</a>
        <a href="/about-us">{t('About')}</a>
      </nav>
      {session || restoreFailed ? (
        // When the service did not answer, /home is where the Retry screen lives; Sign in would wrongly say the person is signed out.
        <a href="/home" className="public-signin" data-session="signed-in">
          {t('Open your account')} <span className="lt-arrow lt-arrow-out" aria-hidden="true" />
        </a>
      ) : (
        <a href={authHref} className="public-signin" data-session="signed-out">
          {path.startsWith('/login') ? t('Create account') : t('Sign in')} <span className="lt-arrow lt-arrow-out" aria-hidden="true" />
        </a>
      )}
    </header>
  );
}
/**
 * `SharedResult` is the quant room a backtest result shared by link opens (AL-report-03). The app passes it in, lazily
 * loaded, so the public rooms neither reach inside quant nor load its entry.
 */
export function PublicRoutes({ path, SharedResult }: { path: string; SharedResult: ComponentType<{ path: string }> }) {
  const { t } = publicCopy.useCopy();
  const auth = path.startsWith('/login') || path === '/register';
  const library = helpLibraryPath(path);
  return (
    <div className="public-shell">
      <PublicHeader path={path} />
      <main id="main">
        {path === '/' ? (
          <HomePage />
        ) : path === '/register' ? (
          <SignUp />
        ) : path === '/confirm-email' ? (
          <ConfirmEmail />
        ) : path === '/cannot-sign-in' ? (
          <CannotSignIn />
        ) : path === '/recover-account' ? (
          <RecoverAccount />
        ) : path === '/freeze/confirm' ? (
          <FreezeConfirm />
        ) : path === '/appeal' ? (
          <AppealSignedOut />
        ) : auth ? (
          <AuthForm register={false} />
        ) : path === '/invite' ? (
          <Invitation />
        ) : path === '/help/official-channels' ? (
          <OfficialChannels />
        ) : path === '/help/mule-policy' ? (
          <MulePolicy />
        ) : path === '/help' || path === '/helpdetail' ? (
          <Help />
        ) : library ? (
          <HelpLibrary at={library} />
        ) : path === '/findPwd' ? (
          <PasswordRecovery />
        ) : path === '/completePasswordReset' ? (
          // The mailed reset link (J-identity-03 #2): its code opens the code step.
          <PasswordRecovery linkCode={new URLSearchParams(window.location.search).get('code') ?? undefined} />
        ) : path === '/about-us' ? (
          <AboutPage />
        ) : path === '/developers' || path.startsWith('/developers/') ? (
          <DevelopersRoutes path={path} />
        ) : path === '/status' ? (
          <StatusPage />
        ) : path === '/status/confirm' || path === '/status/manage' || path === '/status/unsubscribe' ? (
          <StatusSubscriptionPage mode={path.slice('/status/'.length) as 'confirm' | 'manage' | 'unsubscribe'} />
        ) : path === '/support/guest/verify' ? (
          <GuestVerify />
        ) : path === '/support/guest/request' ? (
          <GuestRequest />
        ) : path === '/support/chat' ? (
          <GuestChat />
        ) : path === '/support/new' ? (
          <GuestNewRequest />
        ) : path === '/partner' ? (
          <PartnerPage />
        ) : path === '/notice' || path === '/announcement' ? (
          <NoticePage />
        ) : path.startsWith('/notice/') || path.startsWith('/announcement/') ? (
          <NoticePage detail id={path.split('/')[2] ?? null} />
        ) : path.startsWith('/quant/share/') ? (
          <Suspense fallback={null}>
            <SharedResult path={path} />
          </Suspense>
        ) : path === '/fees' ? (
          <FeesPage />
        ) : path === '/fees/my-tier' ? (
          <MyTierPage />
        ) : path === '/rulebook' ? (
          <RulebookRoom />
        ) : path === '/app' ? (
          <AppPage />
        ) : path === '/lab' ? (
          <LabPage />
        ) : path.startsWith('/lab/detail/') ? (
          <LabPage detail />
        ) : (
          <PublicInformation path={path} />
        )}
      </main>
      <footer className="public-footer">
        <Brand footer />
        <div>
          <a href="/help">{t('Help')}</a>
          <a href="/status">{t('Status')}</a>
          <a href="/fees">{t('Fees')}</a>
          <a href="/notice">{t('Notices')}</a>
          <a href="/partner">{t('Partners')}</a>
        </div>
        <p>{t('Your money. Your decisions.')}</p>
      </footer>
    </div>
  );
}
/** Any public address that has no page of its own. */
function PublicInformation({ path }: { path: string }) {
  const { t, requestedLocale } = publicCopy.useCopy();
  const room = findRoom(path);
  return (
    <Page title={room ? roomTitle(room, requestedLocale) : t('Page unavailable')}>
      <EmptyState title={t('This page is not published')}>{t('There is no published content available for this address.')}</EmptyState>
    </Page>
  );
}
