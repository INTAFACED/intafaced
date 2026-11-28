import { Button, Switch } from '@intafaced/ui/lit';
import { centreCopy } from './centre-copy';
import { ChannelCard } from './ChannelCard';
import { CategoryGrid } from './CategoryGrid';
import { OUT_OF_APP } from './prefs';
import { TelegramCard } from './TelegramCard';
import { LoadFailed, Loading } from './parts';
import { useCentre } from './use-centre';

/**
 * Notification preferences (`/notifications?view=settings`). Always reachable: every way of reaching the person is listed, with
 * its real state, a pause switch, and the steps to add, confirm or remove an address. What the platform cannot send yet is shown
 * as such, with the reason, instead of being hidden.
 */
export default function NotificationSettings() {
  const copy = centreCopy.useCopy();
  const { load, reload, mute } = useCentre();
  return (
    <>
      <p className="lt-hint">{copy.t('prefsIntro')}</p>
      {load.status === 'loading' ? (
        <Loading label={copy.t('waysTitle')} rows={3} />
      ) : load.status === 'failed' ? (
        <LoadFailed title={copy.t('loadFailed')} onRetry={reload} retryLabel={copy.t('tryAgain')} />
      ) : (
        <>
          <h2>{copy.t('waysTitle')}</h2>
          <ul data-testid="nf-card" className="lt-rows">
            <li data-testid="nf-channelcard">
              <div className="lt-actions">
                <span className="lt-lines">
                  <span data-testid="nf-title">{copy.t('channelInbox')}</span>
                  <span data-testid="nf-body">{copy.t('inboxState')}</span>
                </span>
                <span />
                <Switch label={copy.t('channelInbox')} checked disabled onChange={() => undefined} />
              </div>
            </li>
            {OUT_OF_APP.map((channel) => (
              <ChannelCard key={channel} channel={channel} view={load.channels[channel]} onMute={mute} onChanged={reload} />
            ))}
          </ul>
          <p className="lt-hint">{copy.t('urgentNote')}</p>
          <TelegramCard />
          <CategoryGrid />
          <section aria-labelledby="nf-quiet">
            <h2 id="nf-quiet">{copy.t('quietTitle')}</h2>
            <div className="lt-actions">
              <span className="lt-lines">
                <span data-testid="nf-title">{copy.t('quietLabel')}</span>
                <span data-testid="nf-body" id="nf-quiet-why">
                  {copy.t('quietReason')}
                </span>
              </span>
              <Button tone="secondary" disabled aria-describedby="nf-quiet-why">
                {copy.t('quietValue')}
              </Button>
            </div>
          </section>
        </>
      )}
    </>
  );
}
