import './notifications.css';
import { Button, StateBlock, Switch } from './deps';
import { centreCopy } from './centre-copy';
import { ChannelCard } from './ChannelCard';
import { NotifyNav } from './NotifyNav';
import { CategoryGrid } from './CategoryGrid';
import { OUT_OF_APP } from './prefs';
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
    <div data-testid="if-notify" className="if-notify">
      <div className="nf-head">
        <h1 data-testid="nf-h1" className="nf-h1">
          {copy.t('prefsTitle')}
        </h1>
      </div>
      <NotifyNav current="settings" />
      <p className="nf-intro">{copy.t('prefsIntro')}</p>
      {load.status === 'loading' ? (
        <StateBlock kind="loading" rows={3} rowHeight={72} label={copy.t('waysTitle')} />
      ) : load.status === 'failed' ? (
        <StateBlock kind="error" title={copy.t('loadFailed')} onRetry={reload} retryLabel={copy.t('tryAgain')} />
      ) : (
        <>
          <h2 className="nf-h2">{copy.t('waysTitle')}</h2>
          <ul data-testid="nf-card" className="nf-card nf-channels">
            <li data-testid="nf-channelcard" className="nf-channelcard">
              <div className="nf-channelcard__head">
                <span className="nf-text">
                  <span data-testid="nf-title" className="nf-title">
                    {copy.t('channelInbox')}
                  </span>
                  <span data-testid="nf-body" className="nf-body nf-body--wrap">
                    {copy.t('inboxState')}
                  </span>
                </span>
                <span />
                <Switch aria-label={copy.t('channelInbox')} checked disabled />
              </div>
            </li>
            {OUT_OF_APP.map((channel) => (
              <ChannelCard key={channel} channel={channel} view={load.channels[channel]} onMute={mute} onChanged={reload} />
            ))}
          </ul>
          <p className="nf-note">{copy.t('urgentNote')}</p>
          <CategoryGrid />
          <section aria-labelledby="nf-quiet">
            <h2 className="nf-h2" id="nf-quiet">
              {copy.t('quietTitle')}
            </h2>
            <div className="nf-offrow">
              <span className="nf-text">
                <span data-testid="nf-title" className="nf-title">
                  {copy.t('quietLabel')}
                </span>
                <span data-testid="nf-body" className="nf-body nf-body--wrap" id="nf-quiet-why">
                  {copy.t('quietReason')}
                </span>
              </span>
              <Button variant="secondary" size={32} disabled aria-describedby="nf-quiet-why">
                {copy.t('quietValue')}
              </Button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
