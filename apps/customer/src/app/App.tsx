import { Component, lazy, Suspense, useEffect, type MouseEvent, type ReactNode } from 'react';
import { Page, EmptyState, Button, Loading } from '../shared/ui';
import { findRoom } from './navigation';
import { useLocation, navigate } from './location';
import { Shell } from './Shell';
import { PublicRoutes } from '../features/public/PublicRoutes';
import { useSession } from '../features/session/session';
import { AccountRoutes } from '../features/account/AccountRoutes';
import { ApplyView } from '../features/account/View';

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
    return this.state.failed ? (
      <Page title="This room could not open">
        <EmptyState title="The interface encountered an error" action={<Button onClick={() => location.reload()}>Reload the app</Button>}>
          Reload to try again. You will need to sign in again. An unconfirmed financial request must still be checked before retrying.
        </EmptyState>
      </Page>
    ) : (
      this.props.children
    );
  }
}

export function App() {
  const current = useLocation();
  const path = current.split('?')[0] ?? '/';
  const room = findRoom(path);
  const { session } = useSession();
  const teamHref = room?.area === 'team' ? configuredTeamHref(current) : undefined;
  useEffect(() => {
    if (room?.alias) navigate(room.alias + location.search, true);
    document.title = `${room?.title ?? 'Page not found'} · Intafaced`;
  }, [path, room]);
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
      <Page title="Page not found">
        <EmptyState title="This address is not available">
          Return to one of the four customer doors.
        </EmptyState>
      </Page>
    );
  const content =
    room?.area === 'public' ? (
      <PublicRoutes path={path} />
    ) : room?.area === 'team' ? (
      <Page title="Separate team desk">
        <EmptyState
          title="Open the operator console"
          action={
            teamHref ? (
              <a className="button button--primary" href={teamHref}>
                Open Team
              </a>
            ) : undefined
          }
        >
          {teamHref
            ? 'The team desk uses separate operator authentication.'
            : 'The Team deployment address is not configured. Ask your operator for the verified console address.'}
        </EmptyState>
      </Page>
    ) : room?.area === 'parked' ? (
      <Page title="This room is parked">
        <EmptyState title="Chain services are not active">
          This room remains reserved until owner activation. It is not available from customer navigation or search.
        </EmptyState>
      </Page>
    ) : (
      <Shell door={room?.door}>
        {needsSession && !session ? (
          <Page title={room?.title ?? 'Sign in'}>
            <EmptyState
              title="Sign in to continue"
              action={
                <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(current)}`}>
                  Sign in
                </a>
              }
            >
              Your account context is needed before this room can show private information.
            </EmptyState>
          </Page>
        ) : (
          <Suspense
            fallback={
              <div className="page">
                <Loading label="Opening room" />
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
