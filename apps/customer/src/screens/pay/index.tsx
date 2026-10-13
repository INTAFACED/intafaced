import './pay-screen.css';
import '../trade/buy/buy.css';
import type { ScreenProps } from '../../app/screen-types';
import { Button, navigate, Tabs, TabsList, TabsTab, useSession } from './deps';
import { payCopy } from './copy';
import { useIdentity } from './identity-state';
import { SendCard } from './SendCard';
import { ReceiveCard } from './ReceiveCard';

type Tab = 'send' | 'receive';
const tabOf = (path: string): Tab => (path.split('?')[0]!.replace(/\/+$/, '') === '/pay/receive' ? 'receive' : 'send');

/** Pay, Send and Receive (UI-SPEC 5.10): headline left, one card right with two tabs. */
export default function PayScreen({ path }: ScreenProps) {
  const { t } = payCopy.useCopy();
  const { api, userId, session } = useSession();
  const identity = useIdentity(api, userId);
  const tab = tabOf(path);
  // The Send card stays mounted (hidden) while Receive shows, so a payment on its way is never cut off by a tab change.
  const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  return (
    <div className="if-pay">
      <div className="pay-grid">
        <header className="pay-hero">
          <h1>{t('Pay')}</h1>
          <p>{t('Pay tagline')}</p>
        </header>
        <section className="pay-card" aria-label={t('Pay')}>
          <Tabs value={tab} onValueChange={(next) => navigate(next === 'receive' ? '/pay/receive' : '/pay/send')}>
            <TabsList divider aria-label={t('Send or receive')}>
              <TabsTab value="send">{t('Send')}</TabsTab>
              <TabsTab value="receive">{t('Receive')}</TabsTab>
            </TabsList>
          </Tabs>
          {session ? (
            <>
              <div hidden={tab !== 'send'} data-testid="send-panel">
                <SendCard identity={identity} />
              </div>
              <div hidden={tab !== 'receive'} data-testid="receive-panel">
                <ReceiveCard identity={identity} />
              </div>
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
