// volt-room: /pay
// volt-room: /pay/send
// volt-room: /pay/receive
// volt-room: /pay/request
// volt-room: /pay/bills
// volt-room: /pay/global
import { useMemo } from 'react';
import { ToastProvider } from '@intafaced/ui/lit';
import { FlowTemplate, OverviewTemplate, TabList } from '@intafaced/ui/lit/templates';
import type { ScreenProps } from '../../app/screen-types';
import { isHiddenPath, navigate, parseRequestSearch, PersonalRoom, personalRoomFor, useSession } from './deps';
import { payCopy } from './copy';
import { personalCopy } from './personal-copy';
import { useIdentity } from './identity-state';
import { SendCard } from './SendCard';
import { ReceiveCard } from './ReceiveCard';
import { RequestCard } from './RequestCard';
import { BillsCard } from './BillsCard';
import { GlobalCard } from './GlobalCard';
import { RecentPanel } from './RecentPanel';
import { WaitingForYou } from './WaitingForYou';
import { rooms, roomTitle } from '../../app/navigation';
import { usePreferences } from '../../shared/preferences';

/**
 * The other personal Pay rooms beyond the card's own tabs (J-pay-01 #1), read from the one route table so a new room is
 * listed where it is routed. Pay's own address and the tabs are already on the page; a parameter room, a business room
 * and a hidden one are not listed.
 */
export const payRooms = () =>
  rooms.filter(
    (room) =>
      room.area === 'pay' &&
      room.screen === 'pay' &&
      !room.business &&
      !room.hidden &&
      !room.path.includes(':') &&
      room.path !== '/pay' &&
      !Object.values(ROUTES).includes(room.path) &&
      !isHiddenPath(room.path),
  );

type Tab = 'send' | 'receive' | 'request' | 'bills' | 'global';
const ROUTES: Record<Tab, string> = {
  send: '/pay/send',
  receive: '/pay/receive',
  request: '/pay/request',
  bills: '/pay/bills',
  global: '/pay/global',
};
export const tabOf = (path: string): Tab => {
  const clean = path.split('?')[0]!.replace(/\/+$/, '');
  return (Object.keys(ROUTES) as Tab[]).find((tab) => ROUTES[tab] === clean) ?? 'send';
};
/** The id of a tab's panel, for the tab that names it. */
const panelId = (tab: Tab) => `pay-panel-${tab}`;

/**
 * Pay: Send, Receive, Request, Bills and Global (UI-SPEC 5.10), on the Volt kit's overview template: the card with its
 * tabs is the room's lead, what waits for the person under it, and recent payments beside it. Every Pay room, the
 * personal record rooms included, raises its confirmations through the kit's one toast host here.
 */
export default function PayScreen(props: ScreenProps) {
  const { t } = payCopy.useCopy();
  const room = personalRoomFor(props.path);
  return <ToastProvider closeLabel={t('Dismiss')}>{room ? <PersonalRoom match={room} /> : <PayTabs {...props} />}</ToastProvider>;
}

function PayTabs({ path, search }: ScreenProps) {
  const { t } = payCopy.useCopy();
  const copy = personalCopy.useCopy();
  const { api, userId, session } = useSession();
  const { layoutMode } = usePreferences();
  const identity = useIdentity(api, userId);
  const tab = tabOf(path);
  const otherRooms = useMemo(payRooms, []);
  // A payment link opens Send already filled in. It is only a suggestion: Send still reviews every field.
  const prefill = useMemo(() => (tab === 'send' ? parseRequestSearch(search) : null), [tab, search]);
  const tagline =
    tab === 'request'
      ? copy.t('taglineRequest')
      : tab === 'bills'
        ? copy.t('taglineBills')
        : tab === 'global'
          ? copy.t('taglineGlobal')
          : t('Pay tagline');
  const tabs: readonly { value: Tab; label: string }[] = [
    { value: 'send', label: t('Send') },
    { value: 'receive', label: t('Receive') },
    { value: 'request', label: copy.t('tabRequest') },
    { value: 'bills', label: copy.t('tabBills') },
    { value: 'global', label: copy.t('tabGlobal') },
  ];
  const label = (value: Tab) => tabs.find((item) => item.value === value)!.label;
  // Send and Receive stay drawn (hidden) while another tab shows; the others are drawn only while chosen.
  const drawn = (value: Tab) => Boolean(session) && (value === 'send' || value === 'receive' || value === tab);
  // The Send card stays mounted (hidden) while the other tabs show, so a payment on its way is never cut off by a tab change.
  const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  const card = (
    <section data-testid="pay-card" aria-label={t('Pay')} className="lt-stack">
      <TabList
        label={t('Send or receive')}
        items={tabs}
        value={tab}
        onChange={(next) => navigate(ROUTES[next] ?? ROUTES.send)}
        panelOf={(value) => (drawn(value) ? panelId(value) : undefined)}
      />
      {session ? (
        <>
          <div hidden={tab !== 'send'} data-testid="send-panel" id={panelId('send')} role="tabpanel" aria-label={label('send')}>
            <SendCard identity={identity} prefill={prefill} prefillKey={tab === 'send' ? search : ''} />
          </div>
          <div hidden={tab !== 'receive'} data-testid="receive-panel" id={panelId('receive')} role="tabpanel" aria-label={label('receive')}>
            <ReceiveCard identity={identity} />
          </div>
          {tab === 'request' ? (
            <div data-testid="request-panel" id={panelId('request')} role="tabpanel" aria-label={label('request')}>
              <RequestCard identity={identity} />
            </div>
          ) : null}
          {tab === 'bills' ? (
            <div data-testid="bills-panel" id={panelId('bills')} role="tabpanel" aria-label={label('bills')}>
              <BillsCard />
            </div>
          ) : null}
          {tab === 'global' ? (
            <div data-testid="global-panel" id={panelId('global')} role="tabpanel" aria-label={label('global')}>
              <GlobalCard />
            </div>
          ) : null}
        </>
      ) : (
        <div className="lt-actions">
          <a className="lt-button lt-button-primary" href={loginHref}>
            {tab === 'receive' ? t('Log in to receive') : t('Log in to send')}
          </a>
        </div>
      )}
      <nav className="lt-stack" aria-label={t('Pay rooms')} data-testid="pay-rooms">
        <p className="lt-hint">{t('Pay rooms')}</p>
        <div className="lt-actions">
          {otherRooms.map((room) => (
            <a key={room.path} className="lt-button lt-button-secondary" href={room.path}>
              {roomTitle(room)}
            </a>
          ))}
        </div>
      </nav>
    </section>
  );
  const mode = layoutMode === 'pro' ? 'pro' : 'simple';
  // Pay's own address is the door's overview; each tab's address is that one task, on the flow template, with the same
  // card leading it, what waits for the person above it and recent payments beside it.
  const own = path.split('?')[0]!.replace(/\/+$/, '') === '/pay';
  return (
    <div data-testid="if-pay">
      {own ? (
        <OverviewTemplate
          title={t('Pay')}
          description={tagline}
          state={{ kind: 'ready' }}
          mode={mode}
          hero={card}
          needsYou={session ? <WaitingForYou /> : undefined}
          watching={session ? <RecentPanel /> : undefined}
        />
      ) : (
        <FlowTemplate
          title={t('Pay')}
          description={tagline}
          state={{ kind: 'ready' }}
          mode={mode}
          step={
            <div className="lt-stack">
              {session ? <WaitingForYou /> : null}
              {card}
            </div>
          }
          summary={session ? <RecentPanel /> : undefined}
        />
      )}
    </div>
  );
}
