import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button, Field, Failure, Page, EmptyState, Loading } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { useApi, useSession, sessionSchema, type Session } from '../session/session';
import { signInWithPasskey } from '../session/webauthn';
import { safeReturnTo, findRoom } from '../../app/navigation';
import { navigate } from '../../app/location';
import { useResource } from '../../shared/resource';
import './public.css';
import { publishedCopy } from '../../shared/copy';

function Brand() {
  return (
    <a href="/" className="brand">
      intafaced<span aria-hidden="true">·</span>
    </a>
  );
}
export function PublicRoutes({ path }: { path: string }) {
  const auth = path.startsWith('/login') || path === '/register';
  const invitation = z.string().uuid().safeParse(new URLSearchParams(location.search).get('invite'));
  const alternateAuth = path.startsWith('/login') ? '/register' : '/login';
  const authHref = invitation.success ? `${alternateAuth}?invite=${encodeURIComponent(invitation.data)}` : alternateAuth;
  return (
    <div className="public-shell">
      <header className="public-header">
        <Brand />
        <nav aria-label="Public navigation">
          <a href="/exchange">Trade</a>
          <a href="/help">Help</a>
          <a href="/about-us">About</a>
        </nav>
        <a href={authHref} className="public-signin">
          {path.startsWith('/login') ? 'Create account' : 'Sign in'} <span aria-hidden="true">↗</span>
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
          <a href="/help">Help</a>
          <a href="/notice">Notices</a>
          <a href="/partner">Partners</a>
        </div>
        <p>Your money. Your decisions.</p>
      </footer>
    </div>
  );
}
function Home() {
  return (
    <>
      <section className="home-hero">
        <p className="eyebrow">ONE ACCOUNT. YOUR NEXT MOVE.</p>
        <h1>
          Money in view.
          <br />
          <span>Possibility ahead.</span>
        </h1>
        <p className="hero-description">
          Keep your money, trading and payments connected. A clear everyday account. A trading desk built for focus.
        </p>
        <div className="actions">
          <a className="button button--primary" href="/register">
            Create your account <span aria-hidden="true">↗</span>
          </a>
          <a className="button button--secondary" href="/exchange">
            Explore the desk
          </a>
        </div>
        <p className="hero-note">Product availability depends on your account, region and connected services.</p>
        <div className="hero-doors" aria-label="Four connected experiences">
          <a href="/money">
            <span>01</span>
            <h2>Money</h2>
            <p>
              What you hold.
              <br />
              What you can use.
            </p>
          </a>
          <a href="/exchange">
            <span>02</span>
            <h2>Trade</h2>
            <p>
              The full picture.
              <br />A considered order.
            </p>
          </a>
          <a href="/pay">
            <span>03</span>
            <h2>Pay</h2>
            <p>
              Send and receive.
              <br />
              Keep things moving.
            </p>
          </a>
          <a href="/more">
            <span>04</span>
            <h2>More</h2>
            <p>
              Learn. Research.
              <br />
              Find your next step.
            </p>
          </a>
        </div>
      </section>
      <section className="home-detail">
        <div>
          <p className="eyebrow">BUILT AROUND YOUR WORKFLOW</p>
          <h2>
            A calm account.
            <br />A capable desk.
          </h2>
        </div>
        <div className="home-detail-list">
          <article>
            <span>↗</span>
            <div>
              <h3>See the funds behind the decision</h3>
              <p>Available and held funds stay distinct, so you can see what is ready to use.</p>
            </div>
          </article>
          <article>
            <span>↗</span>
            <div>
              <h3>Keep your market in context</h3>
              <p>Chart, order book and ticket work together. Review the details before you place an order.</p>
            </div>
          </article>
          <article>
            <span>↗</span>
            <div>
              <h3>Know when something is unavailable</h3>
              <p>Check what is available to your account before you act. Unsupported actions explain what is missing.</p>
            </div>
          </article>
        </div>
      </section>
    </>
  );
}
function Invitation() {
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
    <Page title="An invitation to Intafaced" description="Money, trading and payments through one account.">
      {!parsed.success ? (
        <EmptyState
          title={token ? 'This invitation address is invalid' : 'Create an invitation from your account'}
          action={
            <a className="button button--primary" href="/uc/promotion">
              Open invitations
            </a>
          }
        >
          {token ? 'Ask the sender for a complete invitation link.' : 'Your personal invitation tools are available after sign-in.'}
        </EmptyState>
      ) : (
        <section className="public-prose">
          <h2>Your account comes first.</h2>
          <p>
            Sign in or create your account, then accept this invitation. The service checks whether the link is active and whether a
            referral can be attached. Rewards are not promised by this link.
          </p>
          {session ? (
            <Button
              disabled={pending || result?.ok === true || (result?.ok === false && result.reason === 'uncertain')}
              onClick={() => void accept()}
            >
              {pending ? 'Checking invitation…' : 'Accept invitation'}
            </Button>
          ) : (
            <div className="actions">
              <a className="button button--primary" href={`/register?invite=${encodeURIComponent(parsed.data)}`}>
                Create account
              </a>
              <a className="button button--secondary" href={`/login?invite=${encodeURIComponent(parsed.data)}`}>
                Sign in
              </a>
            </div>
          )}
          {result &&
            (result.ok ? (
              <p className="notice" role="status">
                {result.data.attributed
                  ? 'Your referral status is recorded by the service.'
                  : 'The invitation was checked. No referral relationship was attached.'}
              </p>
            ) : (
              <Failure result={result} />
            ))}
          {result?.ok && (
            <a className="text-link" href="/money">
              Continue to Money ↗
            </a>
          )}
        </section>
      )}
    </Page>
  );
}

function AuthForm({ register }: { register: boolean }) {
  const { api, commit } = useSession();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const invitation = z.string().uuid().safeParse(new URLSearchParams(location.search).get('invite'));
  const inviteToken = invitation.success ? invitation.data : undefined;
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ApiResult<Session> | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [handle, setHandle] = useState('');
  const [totp, setTotp] = useState('');
  const [region, setRegion] = useState('');
  async function finish(operation: () => Promise<ApiResult<Session>>) {
    if (pending) return;
    setPending(true);
    setResult(null);
    const next = await operation();
    if (!active.current) return;
    setPending(false);
    if (next.ok) {
      commit(next.data);
      const params = new URLSearchParams(location.search);
      let requested = params.get('redirect');
      if (!requested && location.pathname.startsWith('/login/returnUrl/')) {
        try {
          requested = decodeURIComponent(location.pathname.slice('/login/returnUrl/'.length));
        } catch {
          requested = null;
        }
      }
      navigate(inviteToken ? `/invite?token=${encodeURIComponent(inviteToken)}` : safeReturnTo(requested), true);
    } else setResult(next);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void finish(() =>
      register
        ? api.mutate(
            'identity',
            'auth.register',
            { handle: handle.trim(), email: identifier.trim(), password, ...(region ? { region: region.toUpperCase() } : {}) },
            sessionSchema,
          )
        : api.mutate(
            'identity',
            'auth.login',
            { identifier: identifier.trim(), password, ...(totp ? { totpCode: totp } : {}) },
            sessionSchema,
          ),
    );
  }
  return (
    <section className="auth-layout">
      <div className="auth-story">
        <p className="eyebrow">YOUR ACCOUNT, CONNECTED</p>
        <p className="auth-story-title">
          {register ? (
            <>
              Make your
              <br />
              next move.
            </>
          ) : (
            <>
              Welcome
              <br />
              <span>back.</span>
            </>
          )}
        </p>
        <p>
          Money, trading and payments.
          <br />
          One place to keep perspective.
        </p>
        <div className="auth-story-line" />
      </div>
      <div className="auth-form">
        <p className="eyebrow">{register ? 'GET STARTED' : 'SIGN IN'}</p>
        <h1>{register ? 'Create your account' : 'Sign in to your account'}</h1>
        <form className="form-stack" onSubmit={submit}>
          {register && (
            <Field
              label="Handle"
              name="handle"
              autoComplete="username"
              required
              minLength={3}
              maxLength={32}
              pattern="[a-zA-Z0-9_]+"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
            />
          )}
          <Field
            label={register ? 'Email' : 'Email or handle'}
            name="identifier"
            type={register ? 'email' : 'text'}
            autoComplete={register ? 'email' : 'username'}
            required
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
          />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            minLength={register ? 12 : 1}
            maxLength={200}
            hint={register ? 'At least 12 characters.' : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {register ? (
            <Field
              label="Country code (optional)"
              name="region"
              maxLength={2}
              minLength={2}
              placeholder="ISO two-letter code"
              value={region}
              onChange={(event) => setRegion(event.target.value)}
            />
          ) : (
            <Field
              label="Two-factor or recovery code (if enabled)"
              name="totp"
              autoComplete="one-time-code"
              value={totp}
              onChange={(event) => setTotp(event.target.value)}
            />
          )}
          <Button type="submit" disabled={pending}>
            {pending ? 'Connecting…' : register ? 'Create account' : 'Sign in'}
          </Button>
          {!register && (
            <Button variant="secondary" disabled={pending} onClick={() => void finish(() => signInWithPasskey(api, identifier.trim()))}>
              Use a passkey
            </Button>
          )}
          {result && !result.ok && <Failure result={result} />}
          <p className="muted">
            {register ? (
              <>
                Already have an account?{' '}
                <a className="text-link" href={inviteToken ? `/login?invite=${encodeURIComponent(inviteToken)}` : '/login'}>
                  Sign in
                </a>
              </>
            ) : (
              <>
                Need an account?{' '}
                <a className="text-link" href={inviteToken ? `/register?invite=${encodeURIComponent(inviteToken)}` : '/register'}>
                  Create one
                </a>
              </>
            )}
          </p>
          {!register && (
            <a className="text-link" href="/findPwd">
              Recover account access
            </a>
          )}
        </form>
      </div>
    </section>
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
  const api = useApi();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const { resource, reload } = useResource(
    (signal) => api.query('support', 'searchKb', { q: submitted, limit: 100 }, z.array(kbSchema), { signal }),
    `kb:${submitted}`,
  );
  const articleId = new URLSearchParams(location.search).get('id');
  return (
    <Page title="How can we help?" description="Search published answers, or open a support ticket for your account.">
      <form
        className="help-search"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <Field
          label="Search help"
          name="help-search"
          placeholder="Account access, orders, payments…"
          maxLength={200}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit">Search</Button>
      </form>
      {resource.status === 'loading' ? (
        <Loading label="Loading published answers" />
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={reload} />
      ) : resource.data.filter((article) => article.published !== false && (!articleId || article.id === articleId)).length === 0 ? (
        <EmptyState
          title="No published answers found"
          action={
            <a href="/support" className="text-link">
              Open support
            </a>
          }
        >
          Try another search, or contact support about your account.
        </EmptyState>
      ) : (
        <div className="help-articles">
          {resource.data
            .filter((article) => article.published !== false && (!articleId || article.id === articleId))
            .map((article) => (
              <article key={article.id}>
                <h2>{publishedCopy(article.titleKey) ?? 'Article text unavailable'}</h2>
                <p>{publishedCopy(article.bodyKey) ?? 'The published article has no readable text in the available language catalogue.'}</p>
              </article>
            ))}
        </div>
      )}
      <a className="text-link" href="/support">
        View your support tickets ↗
      </a>
    </Page>
  );
}
function PublicInformation({ path }: { path: string }) {
  const room = findRoom(path);
  if (path === '/about-us')
    return (
      <Page
        title="A connected view of your money."
        description="Intafaced brings money, trading, payments and product tools into one account."
      >
        <div className="public-prose">
          <h2>Four doors. One account.</h2>
          <p>
            Money is your everyday starting point. Trade gives you the market and the order details. Pay keeps your payments in context.
            More brings together learning, research and the rest of the product.
          </p>
          <h2>Clear information comes first.</h2>
          <p>
            Available funds stay distinct from funds on hold. Missing prices stay missing. Where a service or rail is not connected, the
            product explains the limitation before you act.
          </p>
          <a className="text-link" href="/register">
            Create an account ↗
          </a>
        </div>
      </Page>
    );
  const details: Record<string, { title: string; body: string; action?: string }> = {
    '/findPwd': {
      title: 'Password recovery is not connected',
      body: 'The identity service has sign-in, refresh and security procedures, but no customer password-reset contract. No reset email can be requested here yet.',
      action: 'Contact support',
    },
    '/notice': {
      title: 'No public announcements service is connected',
      body: 'Account notifications belong to your private inbox. They are not public announcements.',
      action: 'Open account inbox',
    },
    '/app': {
      title: 'Mobile download links are not published',
      body: 'No verified App Store or Google Play release has been provided. You can use the responsive web app on your phone.',
      action: 'Open the web app',
    },
    '/partner': {
      title: 'Partner intake is not connected',
      body: 'A published partner contact or intake form is not available. This screen does not submit an application.',
      action: 'Contact support',
    },
    '/lab': {
      title: 'Campaign catalogue is not connected',
      body: 'No public campaign contract or published campaign list is available. There are no invented promotions here.',
    },
    '/invite': {
      title: 'Invite from your account',
      body: 'Referral relationships and invitation activity belong to the signed-in account. Sign in to view the supported referral tools.',
      action: 'Open invitations',
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
    <Page title={room?.title ?? 'Page unavailable'}>
      <EmptyState
        title={info?.title ?? 'This page is not published'}
        action={
          info?.action ? (
            <a className="text-link" href={href}>
              {info.action} ↗
            </a>
          ) : undefined
        }
      >
        {info?.body ?? 'There is no published content available for this address.'}
      </EmptyState>
    </Page>
  );
}
