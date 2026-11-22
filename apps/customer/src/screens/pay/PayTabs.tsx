// volt-room: /pay/send
// volt-room: /pay/request
// volt-room: /pay/receive
// volt-room: /pay/bills
// volt-room: /pay/global
import { useMemo } from 'react';
import { FlowTemplate, Tabs, type RoomState } from '@intafaced/ui/lit/templates';
import type { ScreenProps } from '../../app/screen-types';
import { isHiddenPath, parseRequestSearch, useSession } from './deps';
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

/**
 * Pay: Send, Receive, Request, Bills and Global (UI-SPEC 5.10), on the flow template. The step holds the card with its
 * tabs; the summary holds what waits for the customer and their recent payments (signed in only).
 */
export function PayTabs({ path, search }: ScreenProps) {
  const { t } = payCopy.useCopy();
  const copy = personalCopy.useCopy();
  const { api, userId, session } = useSession();
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
  const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  // Signed out, the room is still drawn whole: the tabs, the other rooms and the one way in (log in).
  const state: RoomState = { kind: 'ready' };
  const tabs = [
    { label: t('Send'), href: ROUTES.send },
    { label: t('Receive'), href: ROUTES.receive },
    { label: copy.t('tabRequest'), href: ROUTES.request },
    { label: copy.t('tabBills'), href: ROUTES.bills },
    { label: copy.t('tabGlobal'), href: ROUTES.global },
  ];
  return (
    <div data-testid="if-pay">
      <FlowTemplate
        title={t('Pay')}
        description={tagline}
        state={state}
        step={
          <section data-testid="pay-card" aria-label={t('Pay')}>
            <Tabs items={tabs} current={ROUTES[tab]} label={t('Send or receive')} />
            {session ? (
              <>
                {/* The Send card stays mounted (hidden) while the other tabs show, so a payment on its way is never cut off by a tab change. */}
                <div hidden={tab !== 'send'} data-testid="send-panel">
                  <SendCard identity={identity} prefill={prefill} prefillKey={tab === 'send' ? search : ''} />
                </div>
                <div hidden={tab !== 'receive'} data-testid="receive-panel">
                  <ReceiveCard identity={identity} />
                </div>
                {tab === 'request' ? (
                  <div data-testid="request-panel">
                    <RequestCard identity={identity} />
                  </div>
                ) : null}
                {tab === 'bills' ? (
                  <div data-testid="bills-panel">
                    <BillsCard />
                  </div>
                ) : null}
                {tab === 'global' ? (
                  <div data-testid="global-panel">
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
            <nav aria-label={t('Pay rooms')} data-testid="pay-rooms">
              <p className="lt-hint">{t('Pay rooms')}</p>
              <div className="lt-actions">
                {otherRooms.map((room) => (
                  <a key={room.path} className="lt-link" href={room.path}>
                    {roomTitle(room)}
                  </a>
                ))}
              </div>
            </nav>
          </section>
        }
        summary={
          session ? (
            <div>
              <WaitingForYou />
              <RecentPanel />
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
