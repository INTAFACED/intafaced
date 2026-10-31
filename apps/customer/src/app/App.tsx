import { Component, Suspense, lazy, useEffect, type MouseEvent, type ReactNode } from 'react';
import { Page, EmptyState, Button, Loading } from '../shared/ui';
import { deskPairLabel, findRoom, resolveAlias, roomTitle, type Room } from './navigation';
import { useLocation, navigate } from './location';
import { Shell } from './Shell';
import { preloadMerchantChrome } from './TopBar';
import { useSession } from '../features/session/session';
import { ApplyView } from '../features/account/View';
import { AccountViewSync } from '../features/account/ViewSync';
import { appCopy } from './app-copy';
import { useKeepKeyboardFocusVisible } from '../shared/keyboard-focus';
import { useCustomerRoomArrival } from './room-arrival';
import { hiddenFeatureFor, isDevBuild, type Feature } from './feature-registry';
import { LegacyRoom, preloadAccountRoutes, type LegacyArea } from './LegacyRoom';
import { matchPath } from './path-match';
import { preloadScreen, screens } from './screens';
import { shellCopy } from './shell-copy';
import { isMerchantArea } from '../features/pay/portal/chrome/model';
import { SessionNotice } from './SessionNotice';
import { rememberShellRoute } from '../features/protocol/shell-state';
import { TeamDesk, teamConsoleHref } from './TeamDesk';
import { SessionRetryPanel, SignInPanel } from './SignInPanel';
import { matchMoreRoute } from '../features/more/more-room-routes';

// Rooms outside the customer doors load on demand, so a first visit to Home does not download them.
const loadPublic = () => import('../features/public/PublicRoutes').then((m) => ({ default: m.PublicRoutes }));
const loadProtocol = () => import('../features/protocol/ProtocolRoutes').then((m) => ({ default: m.ProtocolRoutes }));
const loadWeb3Shell = () => import('./Web3Shell').then((m) => ({ default: m.Web3Shell }));
const PublicRoutes = lazy(loadPublic);
const ProtocolRoutes = lazy(loadProtocol);
const Web3Shell = lazy(loadWeb3Shell);
const DevFeatures = lazy(() => import('./DevFeatures').then((m) => ({ default: m.DevFeatures })));

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

const isAcademyPath = (path: string) => path === '/academy' || path.startsWith('/academy/');
// The launch catalogue and a launch's page open signed out too (J-more-catalogue-11): they read only published events.
// Eligibility and basis inside them still ask the visitor to sign in. The issuer forms under /launch stay private.
const isLaunchCataloguePath = (path: string) => {
  if (path === '/launch') return true;
  const hit = matchMoreRoute(path);
  return hit?.route.room === 'launch' && hit.route.kind === 'detail' && hit.id !== undefined;
};

function legacyArea(room: Room): LegacyArea | undefined {
  return room.area === 'money' || room.area === 'trade' || room.area === 'pay' || room.area === 'more' || room.area === 'person'
    ? room.area
    : undefined;
}

export function App() {
  useKeepKeyboardFocusVisible();
  const { t, requestedLocale } = appCopy.useCopy();
  const current = useLocation();
  const path = current.split('?')[0] ?? '/';
  const search = current.slice(path.length);
  const room = findRoom(path);
  const { session, restoring, restoreFailed, retryRestore } = useSession();
  const dev = isDevBuild();
  const devFeatures = dev && path === '/dev/features';
  const hidden = hiddenFeatureFor(path, search);
  // One redirect rule per render, in this order: an alias row, signed-in `/`. No path is redirected for being hidden, in any
  // build, so the Docker image opens exactly what `vite dev` opens.
  const redirectTo = room?.alias ? resolveAlias(room, path, search) : path === '/' && session ? '/home' : undefined;
  useCustomerRoomArrival(path, devFeatures || !room || !['public', 'team', 'web3'].includes(room.area), Boolean(redirectTo));
  const teamHref = room?.area === 'team' ? teamConsoleHref(current, import.meta.env.VITE_TEAM_URL, import.meta.env.DEV) : undefined;
  useEffect(() => {
    if (redirectTo) navigate(redirectTo + location.hash, true);
  }, [redirectTo]);
  // The Exchange | Web3 switch returns to the last route of each shell. Public pages and the team desk belong to neither.
  useEffect(() => {
    if (room && !redirectTo && !['public', 'team'].includes(room.area)) rememberShellRoute(path);
  }, [path, room, redirectTo]);
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
    // another route with a `#` stays inside the app: a full reload would re-run the boot refresh and flash the loading state.
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  }
  // The Academy opens for a visitor with no account too (J-academy-01): its signed-out view reads only published content.
  const needsSession =
    room &&
    ['home', 'money', 'pay', 'more', 'person'].includes(room.area) &&
    path !== '/pay/checkout' &&
    !isAcademyPath(path) &&
    !isLaunchCataloguePath(path);
  // Start downloading the room's code before it can render: a signed-in room waits for the boot refresh, and the
  // Web3 frame and its rooms are two chunks that would otherwise load one after the other. A signed-out visitor to
  // a private room only sees "Sign in", so nothing is fetched for it.
  const willRender = !needsSession || Boolean(session) || restoring;
  useEffect(() => {
    if (!room || !willRender) return;
    const quiet = (load: () => Promise<unknown>) => void load().catch(() => undefined);
    if (room.screen) preloadScreen(room.screen);
    else if (room.area === 'public') quiet(loadPublic);
    else if (room.area === 'web3') [loadWeb3Shell, loadProtocol].forEach(quiet);
    else if (room.area === 'person') quiet(preloadAccountRoutes);
    if (isMerchantArea(path)) quiet(preloadMerchantChrome);
  }, [room, path, willRender]);
  const ribbon = dev && hidden && !devFeatures && !isMerchantArea(path) ? <DevRibbon feature={hidden} /> : null;
  const fallback = (
    <div className="legacy-room">
      <div data-testid="page" className="page">
        <Loading room label={t('Opening room')} />
      </div>
    </div>
  );
  const area = room ? legacyArea(room) : undefined;
  let body: ReactNode;
  if (devFeatures)
    body = (
      <Suspense fallback={fallback}>
        <DevFeatures />
      </Suspense>
    );
  // A private room never paints, and never shows "Sign in to continue", until the boot refresh has answered.
  else if (needsSession && !session && restoring) body = fallback;
  // The service did not answer: the cookie is untouched, so offer Retry instead of pretending the person is signed out.
  else if (needsSession && !session && restoreFailed)
    body = (
      <div className="legacy-room">
        <Page title={room ? roomTitle(room, requestedLocale) : t('Sign in')}>
          <SessionRetryPanel retry={retryRestore} />
        </Page>
      </div>
    );
  else if (needsSession && !session)
    body = (
      <div className="legacy-room">
        <Page title={room ? roomTitle(room, requestedLocale) : t('Sign in')}>
          <SignInPanel />
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
  // `/` sends a signed-in person to /home, so it waits for the boot refresh instead of flashing the signed-out landing page.
  const content = redirectTo ? null : path === '/' && restoring && !session ? (
    fallback
  ) : room?.area === 'public' ? (
    <div className="legacy-room">
      {ribbon}
      <SessionNotice />
      <Suspense fallback={fallback}>
        <PublicRoutes path={path} />
      </Suspense>
    </div>
  ) : room?.area === 'team' ? (
    // The app header stays so a founder who landed here can get back; the console itself is a separate deployment.
    <Shell door={undefined} path={path}>
      {ribbon}
      <TeamDesk href={teamHref} />
    </Shell>
  ) : room?.area === 'web3' ? (
    // Web3 rooms have their own frame and stay out of customerRoomHref, so they are never a sign-in return target. The
    // frame, and the wallet connection in it, outlast a move between Web3 rooms; only the room inside remounts.
    <Suspense fallback={fallback}>
      <Web3Shell path={path}>
        <RoomBoundary key={path}>
          {ribbon}
          <ProtocolRoutes path={path} />
        </RoomBoundary>
      </Web3Shell>
    </Suspense>
  ) : (
    <Shell door={room?.door} path={path}>
      {ribbon}
      {body}
    </Shell>
  );
  return (
    <div onClick={followLink}>
      <ApplyView />
      <AccountViewSync />
      <RoomBoundary key={room?.area === 'web3' ? 'web3' : path}>{content}</RoomBoundary>
    </div>
  );
}
