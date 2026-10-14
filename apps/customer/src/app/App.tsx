import { Component, Suspense, useEffect, type MouseEvent, type ReactNode } from 'react';
import { Page, EmptyState, Button, Loading } from '../shared/ui';
import { deskPairLabel, findRoom, resolveAlias, roomTitle, safeReturnTo, type Room } from './navigation';
import { useLocation, useReturnLocation, currentReturnLocation, navigate } from './location';
import { Shell } from './Shell';
import { PublicRoutes } from '../features/public/PublicRoutes';
import { useSession } from '../features/session/session';
import { ApplyView } from '../features/account/View';
import { appCopy } from './app-copy';
import { useKeepKeyboardFocusVisible } from '../shared/keyboard-focus';
import { useCustomerRoomArrival } from './room-arrival';
import { hiddenFeatureFor, isDevBuild, tabHome, type Feature } from './feature-registry';
import { LegacyRoom, type LegacyArea } from './LegacyRoom';
import { matchPath } from './path-match';
import { screens } from './screens';
import { DevFeatures } from './DevFeatures';
import { shellCopy } from './shell-copy';

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
    <div className="legacy-room">
      <Page title={t('This room could not open')}>
        <EmptyState
          title={t('The interface encountered an error')}
          action={<Button onClick={() => location.reload()}>{t('Reload the app')}</Button>}
        >
          {t(
            'Reload to try again. You will need to sign in again. An unconfirmed financial request must still be checked before retrying.',
          )}
        </EmptyState>
      </Page>
    </div>
  );
}

/** Dev builds only: says why a hidden screen is open, above it. */
function DevRibbon({ feature }: { feature: Feature }) {
  const { t } = shellCopy.useCopy();
  return (
    <div className="dev-ribbon" role="note">
      {t('Hidden from customers: {reason}', { reason: feature.reason })}
    </div>
  );
}

function legacyArea(room: Room): LegacyArea | undefined {
  return room.area === 'money' || room.area === 'trade' || room.area === 'pay' || room.area === 'more' || room.area === 'person'
    ? room.area
    : undefined;
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
  const search = current.slice(path.length);
  const room = findRoom(path);
  const { session, restoring } = useSession();
  const dev = isDevBuild();
  const devFeatures = dev && path === '/dev/features';
  const hidden = hiddenFeatureFor(path, search);
  // One redirect rule per render, in this order: a hidden feature in a customer build, an alias row, signed-in `/`.
  const redirectTo =
    !devFeatures && hidden && !dev
      ? tabHome(hidden)
      : room?.alias
        ? resolveAlias(room, path, search)
        : path === '/' && session
          ? '/home'
          : undefined;
  useCustomerRoomArrival(path, devFeatures || !room || !['public', 'team', 'parked'].includes(room.area), Boolean(redirectTo));
  const teamHref = room?.area === 'team' ? configuredTeamHref(current) : undefined;
  useEffect(() => {
    if (redirectTo) navigate(redirectTo + location.hash, true);
  }, [redirectTo]);
  useEffect(() => {
    const pair = deskPairLabel(path);
    // Each desk market gets its own tab title ("ETH/USDT · Spot"), so several desk tabs can be told apart.
    // A coin page is named after its coin ("BTC price"), so several coin tabs can be told apart.
    const coin = /^\/coin\/([A-Za-z0-9]+)\/?$/.exec(path)?.[1];
    const page = devFeatures
      ? 'Hidden features'
      : pair
        ? `${pair} · Spot`
        : coin
          ? t('{name} price', { name: coin.toUpperCase() })
          : room
            ? roomTitle(room, requestedLocale)
            : t('Page not found');
    document.title = `${page} · INTAFACED`;
  }, [path, room, requestedLocale, devFeatures]);
  function followLink(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin) return;
    // A link to another place in the same page is the browser's job (it scrolls to the anchor). A link to
    // another route with a `#` stays inside the app: it needs no reload and no refresh round trip.
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  }
  const needsSession = room && ['home', 'money', 'pay', 'more', 'person'].includes(room.area) && path !== '/pay/checkout';
  const ribbon = dev && hidden && !devFeatures ? <DevRibbon feature={hidden} /> : null;
  const fallback = (
    <div className="legacy-room">
      <div className="page">
        <Loading label={t('Opening room')} />
      </div>
    </div>
  );
  const area = room ? legacyArea(room) : undefined;
  let body: ReactNode;
  if (devFeatures) body = <DevFeatures />;
  else if (needsSession && !session)
    body = (
      <div className="legacy-room">
        <Page title={room ? roomTitle(room, requestedLocale) : t('Sign in')}>
          <EmptyState title={t('Sign in to continue')} action={<RoomSignIn>{t('Sign in')}</RoomSignIn>}>
            {t('Your account context is needed before this room can show private information.')}
          </EmptyState>
        </Page>
      </div>
    );
  else if (room?.screen) {
    const Screen = screens[room.screen];
    body = (
      <Suspense fallback={fallback}>
        <Screen path={path} search={search} params={matchPath(room.path, path) ?? {}} />
      </Suspense>
    );
  } else if (area) body = <LegacyRoom area={area} path={current} />;
  else
    body = (
      <div className="legacy-room">
        <Page title={t('Page not found')}>
          <EmptyState title={t('This address is not available')}>{t('Return to one of the customer tabs.')}</EmptyState>
        </Page>
      </div>
    );
  // Until the edge has said whether a cookie session exists, paint neither private rooms nor the signed-out pages.
  const content =
    restoring && !devFeatures ? (
      fallback
    ) : redirectTo ? null : room?.area === 'public' ? (
      <div className="legacy-room">
        {ribbon}
        <PublicRoutes path={path} />
      </div>
    ) : room?.area === 'team' ? (
      <div className="legacy-room">
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
      </div>
    ) : room?.area === 'parked' ? (
      <div className="legacy-room">
        <Page title={t('This room is parked')}>
          <EmptyState title={t('Chain services are not active')}>
            {t('This room remains reserved until owner activation. It is not available from customer navigation or search.')}
          </EmptyState>
        </Page>
      </div>
    ) : (
      <Shell door={room?.door} path={path}>
        {ribbon}
        {body}
      </Shell>
    );
  return (
    <div onClick={followLink}>
      <ApplyView />
      <RoomBoundary key={path}>{content}</RoomBoundary>
    </div>
  );
}
