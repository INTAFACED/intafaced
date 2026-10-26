import './pay-screen.css';
import './personal.css';
import '../trade/buy/buy.css';
import { useMemo } from 'react';
import type { ScreenProps } from '../../app/screen-types';
import { Button, navigate, parseRequestSearch, PersonalRoom, personalRoomFor, Tabs, TabsList, TabsTab, useSession } from './deps';
import { payCopy } from './copy';
import { personalCopy } from './personal-copy';
import { useIdentity } from './identity-state';
import { SendCard } from './SendCard';
import { ReceiveCard } from './ReceiveCard';
import { RequestCard } from './RequestCard';
import { BillsCard } from './BillsCard';
import { GlobalCard } from './GlobalCard';
import { RecentPanel } from './RecentPanel';

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

/** Pay: Send, Receive, Request, Bills and Global (UI-SPEC 5.10). Headline left, one card right with the tabs. */
export default function PayScreen(props: ScreenProps) {
  const room = personalRoomFor(props.path);
  return room ? <PersonalRoom match={room} /> : <PayTabs {...props} />;
}

function PayTabs({ path, search }: ScreenProps) {
  const { t } = payCopy.useCopy();
  const copy = personalCopy.useCopy();
  const { api, userId, session } = useSession();
  const identity = useIdentity(api, userId);
  const tab = tabOf(path);
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
  // The Send card stays mounted (hidden) while the other tabs show, so a payment on its way is never cut off by a tab change.
  const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  return (
    <div data-testid="if-pay" className="if-pay">
      <div className="pay-grid">
        <header data-testid="pay-hero" className="pay-hero">
          <h1>{t('Pay')}</h1>
          <p>{tagline}</p>
        </header>
        {session ? (
          <div className="pay-side">
            <RecentPanel />
          </div>
        ) : null}
        <section data-testid="pay-card" className="pay-card" aria-label={t('Pay')}>
          <Tabs value={tab} onValueChange={(next) => typeof next === 'string' && navigate(ROUTES[next as Tab] ?? ROUTES.send)}>
            <TabsList divider aria-label={t('Send or receive')} className="pay-tabs">
              <TabsTab value="send">{t('Send')}</TabsTab>
              <TabsTab value="receive">{t('Receive')}</TabsTab>
              <TabsTab value="request">{copy.t('tabRequest')}</TabsTab>
              <TabsTab value="bills">{copy.t('tabBills')}</TabsTab>
              <TabsTab value="global">{copy.t('tabGlobal')}</TabsTab>
            </TabsList>
          </Tabs>
          {session ? (
            <>
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
            <div className="pay-body">
              <Button variant="primary" size={56} fullWidth nativeButton={false} render={<a href={loginHref} role="link" />}>
                {tab === 'receive' ? t('Log in to receive') : t('Log in to send')}
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
