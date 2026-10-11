import { Component, lazy, Suspense, useEffect, type MouseEvent, type ReactNode } from 'react';
import { Page, EmptyState, Button, Loading } from '../shared/ui';
import { findRoom, roomTitle, safeReturnTo } from './navigation';
import { useLocation, useReturnLocation, currentReturnLocation, navigate } from './location';
import { Shell } from './Shell';
import { PublicRoutes } from '../features/public/PublicRoutes';
import { useSession } from '../features/session/session';
import { AccountRoutes } from '../features/account/AccountRoutes';
import { ApplyView } from '../features/account/View';
import { appCopy } from './app-copy';
import { useKeepKeyboardFocusVisible } from '../shared/keyboard-focus';
import { useCustomerRoomArrival } from './room-arrival';

function configuredTeamHref(path: string): string | undefined {
  const configured: string | undefined = import.meta.env.VITE_TEAM_URL;
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    const local = import.meta.env.DEV && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash)
      return undefined;
    return new URL(path.replace(/^\//, ''), `${url.href.replace(/\/$/, '')}/`).href;
  } catch {
    return undefined;
  }
}

const TradeRoutes = lazy(() => import('../features/trade').then((module) => ({ default: module.TradeRoutes })));
const PayRoutes = lazy(() => import('../features/pay').then((module) => ({ default: module.PayRoutes })));
const MoneyRoutes = lazy(() => import('../features/money').then((module) => ({ default: module.MoneyRoutes })));
const MoreRoutes = lazy(() => import('../features/more').then((module) => ({ default: module.MoreRoutes })));

class RoomBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <RoomFailure /> : this.props.children;
  }
}
function RoomFailure() {
  const { t } = appCopy.useCopy();
  return (
    <Page title={t('This room could not open')}>
      <EmptyState
        title={t('The interface encountered an error')}
        action={<Button onClick={() => location.reload()}>{t('Reload the app')}</Button>}
      >
        {t('Reload to try again. You will need to sign in again. An unconfirmed financial request must still be checked before retrying.')}
      </EmptyState>
    </Page>
  );
}

function RoomSignIn({ children }: { children: ReactNode }) {
  const current = useReturnLocation();
  return (
    <a
      className="button button--primary"
      href={`/login?redirect=${encodeURIComponent(safeReturnTo(current))}`}
      onClick={(event) => {
        // Native hashchange is queued; capture again at link activation.
        event.currentTarget.href = `/login?redirect=${encodeURIComponent(safeReturnTo(currentReturnLocation()))}`;
      }}
    >
      {children}
    </a>
  );
}

export function App() {
  useKeepKeyboardFocusVisible();
  const { t, requestedLocale } = appCopy.useCopy();
  const current = useLocation();
  const path = current.split('?')[0] ?? '/';
  const room = findRoom(path);
  const { session } = useSession();
  useCustomerRoomArrival(path, !room || !['public', 'team', 'parked'].includes(room.area), Boolean(room?.alias));
  const teamHref = room?.area === 'team' ? configuredTeamHref(current) : undefined;
  useEffect(() => {
    if (room?.alias) navigate(room.alias + location.search, true);
    document.title = `${room ? roomTitle(room, requestedLocale) : t('Page not found')} · Intafaced`;
  }, [path, room, requestedLocale]);
  function followLink(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || url.hash) return;
    event.preventDefault();
    navigate(url.pathname + url.search);
  }
  const needsSession = room && ['money', 'pay', 'more', 'person'].includes(room.area) && path !== '/pay/checkout';
  const feature =
    room?.area === 'money' ? (
      <MoneyRoutes path={current} />
    ) : room?.area === 'trade' ? (
      <TradeRoutes path={current} />
    ) : room?.area === 'pay' ? (
      <PayRoutes path={current} />
    ) : room?.area === 'person' ? (
      <AccountRoutes path={current} />
    ) : room?.area === 'more' ? (
      <MoreRoutes path={current} />
    ) : (
      <Page title={t('Page not found')}>
        <EmptyState title={t('This address is not available')}>{t('Return to one of the four customer doors.')}</EmptyState>
      </Page>
    );
  const content =
    room?.area === 'public' ? (
      <PublicRoutes path={path} />
    ) : room?.area === 'team' ? (
      <Page title={t('Separate team desk')}>
        <EmptyState
          title={t('Open the operator console')}
          action={
            teamHref ? (
              <a className="button button--primary" href={teamHref}>
                {t('Open Team')}
              </a>
            ) : undefined
          }
        >
          {teamHref
            ? t('The team desk uses separate operator authentication.')
            : t('The Team deployment address is not configured. Ask your operator for the verified console address.')}
        </EmptyState>
      </Page>
    ) : room?.area === 'parked' ? (
      <Page title={t('This room is parked')}>
        <EmptyState title={t('Chain services are not active')}>
          {t('This room remains reserved until owner activation. It is not available from customer navigation or search.')}
        </EmptyState>
      </Page>
    ) : (
      <Shell door={room?.door}>
        {needsSession && !session ? (
          <Page title={room ? roomTitle(room, requestedLocale) : t('Sign in')}>
            <EmptyState title={t('Sign in to continue')} action={<RoomSignIn>{t('Sign in')}</RoomSignIn>}>
              {t('Your account context is needed before this room can show private information.')}
            </EmptyState>
          </Page>
        ) : (
          <Suspense
            fallback={
              <div className="page">
                <Loading label={t('Opening room')} />
              </div>
            }
          >
            {feature}
          </Suspense>
        )}
      </Shell>
    );
  return (
    <div onClick={followLink}>
      <ApplyView />
      <RoomBoundary key={path}>{content}</RoomBoundary>
    </div>
  );
}
