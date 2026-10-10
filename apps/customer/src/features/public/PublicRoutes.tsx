import { z } from 'zod';
import { Page, EmptyState } from '../../shared/ui';
import { AuthForm } from './AuthForm';
import { Invitation } from './Invitation';
import { PublicHelp as Help } from './PublicHelp';
import { findRoom, roomTitle, safeReturnTo } from '../../app/navigation';
import './public.css';
import { publicCopy } from './public-copy';

function Brand() {
  return (
    <a href="/" className="brand">
      intafaced<span aria-hidden="true">·</span>
    </a>
  );
}
export function PublicRoutes({ path }: { path: string }) {
  const { t } = publicCopy.useCopy();
  const auth = path.startsWith('/login') || path === '/register';
  const search = new URLSearchParams(location.search);
  const invitation = z
    .string()
    .uuid()
    .safeParse(search.get(path === '/invite' ? 'token' : 'invite'));
  const alternateAuth = path.startsWith('/login') ? '/register' : '/login';
  let requested = search.get('redirect');
  if (auth && !requested && path.startsWith('/login/returnUrl/')) {
    try {
      requested = decodeURIComponent(path.slice('/login/returnUrl/'.length));
    } catch {
      requested = null;
    }
  }
  const authSearch = new URLSearchParams();
  if (invitation.success) authSearch.set('invite', invitation.data);
  if (auth && requested) authSearch.set('redirect', safeReturnTo(requested));
  const authHref = `${alternateAuth}${authSearch.size ? `?${authSearch}` : ''}`;
  return (
    <div className="public-shell">
      <header className="public-header">
        <Brand />
        <nav aria-label={t('Public navigation')}>
          <a href="/exchange">{t('Trade')}</a>
          <a href="/help">{t('Help')}</a>
          <a href="/about-us">{t('About')}</a>
        </nav>
        <a href={authHref} className="public-signin">
          {path.startsWith('/login') ? t('Create account') : t('Sign in')} <span aria-hidden="true">↗</span>
        </a>
      </header>
      <main id="main">
        {path === '/' ? (
          <Home />
        ) : auth ? (
          <AuthForm register={path === '/register'} />
        ) : path === '/invite' ? (
          <Invitation />
        ) : path === '/help' || path === '/helpdetail' ? (
          <Help />
        ) : (
          <PublicInformation path={path} />
        )}
      </main>
      <footer className="public-footer">
        <Brand />
        <div>
          <a href="/help">{t('Help')}</a>
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
    </>
  );
}
function PublicInformation({ path }: { path: string }) {
  const { t, requestedLocale } = publicCopy.useCopy();
  const room = findRoom(path);
  if (path === '/about-us')
    return (
      <Page
        title={t('A connected view of your money.')}
        description={t('Intafaced brings money, trading, payments and product tools into one account.')}
      >
        <div className="public-prose">
          <h2>{t('Four doors. One account.')}</h2>
          <p>
            {t(
              'Money is your everyday starting point. Trade gives you the market and the order details. Pay keeps your payments in context. More brings together learning, research and the rest of the product.',
            )}
          </p>
          <h2>{t('Clear information comes first.')}</h2>
          <p>
            {t(
              'Available funds stay distinct from funds on hold. Missing prices stay missing. Where a service or rail is not connected, the product explains the limitation before you act.',
            )}
          </p>
          <a className="text-link" href="/register">
            {t('Create an account ↗')}
          </a>
        </div>
      </Page>
    );
  const details: Record<string, { title: string; body: string; action?: string }> = {
    '/findPwd': {
      title: t('Password recovery is not connected'),
      body: t(
        'The identity service has sign-in, refresh and security procedures, but no customer password-reset contract. No reset email can be requested here yet.',
      ),
      action: t('Contact support'),
    },
    '/notice': {
      title: t('No public announcements service is connected'),
      body: t('Account notifications belong to your private inbox. They are not public announcements.'),
      action: t('Open account inbox'),
    },
    '/app': {
      title: t('Mobile download links are not published'),
      body: t('No verified App Store or Google Play release has been provided. You can use the responsive web app on your phone.'),
      action: t('Open the web app'),
    },
    '/partner': {
      title: t('Partner intake is not connected'),
      body: t('A published partner contact or intake form is not available. This screen does not submit an application.'),
      action: t('Contact support'),
    },
    '/lab': {
      title: t('Campaign catalogue is not connected'),
      body: t('No public campaign contract or published campaign list is available. There are no invented promotions here.'),
    },
    '/invite': {
      title: t('Invite from your account'),
      body: t(
        'Referral relationships and invitation activity belong to the signed-in account. Sign in to view the supported referral tools.',
      ),
      action: t('Open invitations'),
    },
  };
  const info =
    details[path] ??
    (path.startsWith('/notice/') || path.startsWith('/announcement/')
      ? details['/notice']
      : path.startsWith('/lab/detail/')
        ? details['/lab']
        : undefined);
  const href =
    path === '/notice' || path.startsWith('/notice/')
      ? '/notifications'
      : path === '/app'
        ? '/money'
        : path === '/invite'
          ? '/uc/promotion'
          : '/support';
  return (
    <Page title={room ? roomTitle(room, requestedLocale) : t('Page unavailable')}>
      <EmptyState
        title={info?.title ?? t('This page is not published')}
        action={
          info?.action ? (
            <a className="text-link" href={href}>
              {info.action} ↗
            </a>
          ) : undefined
        }
      >
        {info?.body ?? t('There is no published content available for this address.')}
      </EmptyState>
    </Page>
  );
}
