import { BrandLockup, BrandWordmark } from '@intafaced/ui';
import { useSession } from '../session/session';
import { Page, EmptyState } from '../../shared/ui';
import { AuthForm } from './AuthForm';
import { SignUp } from './SignUp';
import { CannotSignIn } from './CannotSignIn';
import { ConfirmEmail } from './ConfirmEmail';
import { RecoverAccount } from './RecoverAccount';
import { FreezeConfirm } from './FreezeConfirm';
import { AppealSignedOut } from './AppealSignedOut';
import { Invitation } from './Invitation';
import { DevelopersRoutes } from '../developers/DevelopersRoutes';
import { PublicHelp as Help } from './PublicHelp';
import { HelpLibrary } from './HelpLibrary';
import { helpLibraryPath } from './help-library';
import { findRoom, roomTitle } from '../../app/navigation';
import { publicAuthContext, publicAuthHref } from './auth-context';
import './public.css';
import { publicCopy } from './public-copy';
import { PasswordRecovery } from './PasswordRecovery';
import { AboutPage, AppPage, NoticePage, PartnerPage, RoomDirectory } from './PublicPages';
import { LabPage } from './LabPage';
import { FeesPage } from './FeesPage';
import { MyTierPage } from './MyTierPage';
import { pagesCopy } from './public-pages-copy';
import { StatusPage } from './StatusPage';
import { StatusSubscriptionPage } from './StatusSubscription';

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
  const { session, restoring, restoreFailed } = useSession();
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
          {t('Open your account')} <span aria-hidden="true">↗</span>
        </a>
      ) : restoring ? (
        // The boot refresh has not answered: say nothing rather than offering Sign in to someone who may already be signed in.
        <span className="public-signin" aria-hidden="true" />
      ) : (
        <a href={authHref} className="public-signin" data-session="signed-out">
          {path.startsWith('/login') ? t('Create account') : t('Sign in')} <span aria-hidden="true">↗</span>
        </a>
      )}
    </header>
  );
}
export function PublicRoutes({ path }: { path: string }) {
  const { t } = publicCopy.useCopy();
  const auth = path.startsWith('/login') || path === '/register';
  const library = helpLibraryPath(path);
  return (
    <div className="public-shell">
      <PublicHeader path={path} />
      <main id="main">
        {path === '/' ? (
          <Home />
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
        ) : path === '/help' || path === '/helpdetail' ? (
          <Help />
        ) : library ? (
          <HelpLibrary at={library} />
        ) : path === '/findPwd' ? (
          <PasswordRecovery />
        ) : path === '/about-us' ? (
          <AboutPage />
        ) : path === '/developers' || path.startsWith('/developers/') ? (
          <DevelopersRoutes path={path} />
        ) : path === '/status' ? (
          <StatusPage />
        ) : path === '/status/confirm' || path === '/status/manage' || path === '/status/unsubscribe' ? (
          <StatusSubscriptionPage mode={path.slice('/status/'.length) as 'confirm' | 'manage' | 'unsubscribe'} />
        ) : path === '/partner' ? (
          <PartnerPage />
        ) : path === '/notice' || path === '/announcement' ? (
          <NoticePage />
        ) : path.startsWith('/notice/') || path.startsWith('/announcement/') ? (
          <NoticePage detail id={path.split('/')[2] ?? null} />
        ) : path === '/fees' ? (
          <FeesPage />
        ) : path === '/fees/my-tier' ? (
          <MyTierPage />
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
function Home() {
  const { t } = publicCopy.useCopy();
  const pages = pagesCopy.useCopy();
  return (
    <>
      <section className="home-hero">
        <p className="eyebrow">{t('ONE ACCOUNT. YOUR NEXT MOVE.')}</p>
        <h1>
          {t('Money in view.')}
          <br />
          <span>{t('Possibility ahead.')}</span>
        </h1>
        <p className="hero-description">
          {t('Keep your money, trading and payments connected. A clear everyday account. A trading desk built for focus.')}
        </p>
        <div className="actions">
          <a className="button button--primary" href="/register">
            {t('Create your account')}
            <span aria-hidden="true">↗</span>
          </a>
          <a className="button button--secondary" href="/exchange">
            {t('Explore the desk')}
          </a>
        </div>
        <p className="hero-note">{t('Product availability depends on your account, region and connected services.')}</p>
        <div className="hero-doors" aria-label={t('Four connected experiences')}>
          <a href="/money">
            <span>01</span>
            <h2>{t('Money')}</h2>
            <p>
              {t('What you hold.')}
              <br />
              {t('What you can use.')}
            </p>
          </a>
          <a href="/exchange">
            <span>02</span>
            <h2>{t('Trade')}</h2>
            <p>
              {t('The full picture.')}
              <br />
              {t('A considered order.')}
            </p>
          </a>
          <a href="/pay">
            <span>03</span>
            <h2>{t('Pay')}</h2>
            <p>
              {t('Send and receive.')}
              <br />
              {t('Keep things moving.')}
            </p>
          </a>
          <a href="/more">
            <span>04</span>
            <h2>{t('More')}</h2>
            <p>
              {t('Learn. Research.')}
              <br />
              {t('Find your next step.')}
            </p>
          </a>
        </div>
      </section>
      <section className="home-detail">
        <div>
          <p className="eyebrow">{t('BUILT AROUND YOUR WORKFLOW')}</p>
          <h2>
            {t('A calm account.')}
            <br />
            {t('A capable desk.')}
          </h2>
        </div>
        <div className="home-detail-list">
          <article>
            <span>↗</span>
            <div>
              <h3>{t('See the funds behind the decision')}</h3>
              <p>{t('Available and held funds stay distinct, so you can see what is ready to use.')}</p>
            </div>
          </article>
          <article>
            <span>↗</span>
            <div>
              <h3>{t('Keep your market in context')}</h3>
              <p>{t('Chart, order book and ticket work together. Review the details before you place an order.')}</p>
            </div>
          </article>
          <article>
            <span>↗</span>
            <div>
              <h3>{t('Know when something is unavailable')}</h3>
              <p>{t('Check what is available to your account before you act. Unsupported actions explain what is missing.')}</p>
            </div>
          </article>
        </div>
      </section>
      <section className="pub-inside" aria-labelledby="home-inside">
        <h2 id="home-inside">{pages.t('insideTitle')}</h2>
        <p className="muted">{pages.t('insideIntro')}</p>
        <RoomDirectory />
      </section>
    </>
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
