import { useState } from 'react';
import { z } from 'zod';
import { Button, Field, Failure, Page, EmptyState, Loading } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { useApi, useSession } from '../session/session';
import { AuthForm } from './AuthForm';
import { findRoom, roomTitle } from '../../app/navigation';
import { useResource } from '../../shared/resource';
import './public.css';
import { publicCopy } from './public-copy';
import { publishedCopy, publishedLanguageFor } from '../../shared/copy';

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
  const invitation = z.string().uuid().safeParse(new URLSearchParams(location.search).get('invite'));
  const alternateAuth = path.startsWith('/login') ? '/register' : '/login';
  const authHref = invitation.success ? `${alternateAuth}?invite=${encodeURIComponent(invitation.data)}` : alternateAuth;
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
function Invitation() {
  const { t } = publicCopy.useCopy();
  const { api, session } = useSession();
  const token = new URLSearchParams(location.search).get('token');
  const parsed = z.string().uuid().safeParse(token);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ApiResult<{ hits: number; attributed: boolean }> | null>(null);
  async function accept() {
    if (!parsed.success || pending) return;
    setPending(true);
    const response = await api.mutate(
      'identity',
      'affiliates.shareHits',
      { token: parsed.data },
      z.object({ hits: z.number().int().nonnegative(), attributed: z.boolean() }),
    );
    setPending(false);
    setResult(response);
  }
  return (
    <Page title={t('An invitation to Intafaced')} description={t('Money, trading and payments through one account.')}>
      {!parsed.success ? (
        <EmptyState
          title={token ? t('This invitation address is invalid') : t('Create an invitation from your account')}
          action={
            <a className="button button--primary" href="/uc/promotion">
              {t('Open invitations')}
            </a>
          }
        >
          {token ? t('Ask the sender for a complete invitation link.') : t('Your personal invitation tools are available after sign-in.')}
        </EmptyState>
      ) : (
        <section className="public-prose">
          <h2>{t('Your account comes first.')}</h2>
          <p>
            {t(
              'Sign in or create your account, then accept this invitation. The service checks whether the link is active and whether a referral can be attached. Rewards are not promised by this link.',
            )}
          </p>
          {session ? (
            <Button
              disabled={pending || result?.ok === true || (result?.ok === false && result.reason === 'uncertain')}
              onClick={() => void accept()}
            >
              {pending ? t('Checking invitation…') : t('Accept invitation')}
            </Button>
          ) : (
            <div className="actions">
              <a className="button button--primary" href={`/register?invite=${encodeURIComponent(parsed.data)}`}>
                {t('Create account')}
              </a>
              <a className="button button--secondary" href={`/login?invite=${encodeURIComponent(parsed.data)}`}>
                {t('Sign in')}
              </a>
            </div>
          )}
          {result &&
            (result.ok ? (
              <p className="notice" role="status">
                {result.data.attributed
                  ? t('Your referral status is recorded by the service.')
                  : t('The invitation was checked. No referral relationship was attached.')}
              </p>
            ) : (
              <Failure result={result} />
            ))}
          {result?.ok && (
            <a className="text-link" href="/money">
              {t('Continue to Money ↗')}
            </a>
          )}
        </section>
      )}
    </Page>
  );
}

const kbSchema = z.object({
  id: z.string(),
  titleKey: z.string(),
  bodyKey: z.string(),
  published: z.boolean().optional(),
  version: z.number().optional(),
  revision: z.number().optional(),
});
function Help() {
  const { t, requestedLocale } = publicCopy.useCopy();
  const api = useApi();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const { resource, reload } = useResource(
    (signal) => api.query('support', 'searchKb', { q: submitted, limit: 100 }, z.array(kbSchema), { signal }),
    `kb:${submitted}`,
  );
  const articleId = new URLSearchParams(location.search).get('id');
  return (
    <Page title={t('How can we help?')} description={t('Search published answers, or open a support ticket for your account.')}>
      <form
        className="help-search"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <Field
          label={t('Search help')}
          name="help-search"
          placeholder={t('Account access, orders, payments…')}
          maxLength={200}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit">{t('Search')}</Button>
      </form>
      {resource.status === 'loading' ? (
        <Loading label={t('Loading published answers')} />
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={reload} />
      ) : resource.data.filter((article) => article.published !== false && (!articleId || article.id === articleId)).length === 0 ? (
        <EmptyState
          title={t('No published answers found')}
          action={
            <a href="/support" className="text-link">
              {t('Open support')}
            </a>
          }
        >
          {t('Try another search, or contact support about your account.')}
        </EmptyState>
      ) : (
        <div className="help-articles">
          {resource.data
            .filter((article) => article.published !== false && (!articleId || article.id === articleId))
            .map((article) => (
              <article key={article.id}>
                <h2 lang={publishedLanguageFor(article.titleKey, requestedLocale) ?? requestedLocale}>
                  {publishedCopy(article.titleKey, requestedLocale) ?? t('Article text unavailable')}
                </h2>
                <p lang={publishedLanguageFor(article.bodyKey, requestedLocale) ?? requestedLocale}>
                  {publishedCopy(article.bodyKey, requestedLocale) ??
                    t('The published article has no readable text in the available language catalogue.')}
                </p>
              </article>
            ))}
        </div>
      )}
      <a className="text-link" href="/support">
        {t('View your support tickets ↗')}
      </a>
    </Page>
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
