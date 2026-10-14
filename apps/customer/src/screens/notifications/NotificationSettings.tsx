import { useCallback, useEffect, useState } from 'react';
import './notifications.css';
import { useSession } from '../../features/session/session';
import { StateBlock, Switch, navigate } from './deps';
import { notifyCopy } from './copy';
import {
  availableChannels,
  channelStatus,
  mutePrefs,
  setMute,
  targets,
  type MutePref,
  type OutOfAppChannel,
  type TargetRow,
} from './notify-api';

type Load =
  { status: 'loading' } | { status: 'failed' } | { status: 'ready'; channels: OutOfAppChannel[]; prefs: MutePref[]; targets: TargetRow[] };

const LABEL = { email: 'Email', push: 'Phone notifications', sms: 'Text message' } as const;

/**
 * Notification settings (`/notifications?view=settings`): for each way we can really reach the person outside the app, one switch.
 * A way that isn't set up on the service isn't listed at all; when none is, the page sends the person back to their inbox (and the inbox
 * hides the link to this page). Adding or confirming an address is not rebuilt here: the old component lists every way, set up or not,
 * so it waits for the first live channel.
 */
export default function NotificationSettings() {
  const copy = notifyCopy.useCopy();
  const { api, userId } = useSession();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<OutOfAppChannel | null>(null);
  const [saved, setSaved] = useState<OutOfAppChannel | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void Promise.all([channelStatus(api, controller.signal), mutePrefs(api, controller.signal), targets(api, controller.signal)]).then(
      ([channels, prefs, rows]) => {
        if (controller.signal.aborted) return;
        if (!channels.ok || !prefs.ok || !rows.ok) return setLoad({ status: 'failed' });
        setLoad({ status: 'ready', channels: availableChannels(channels.data), prefs: prefs.data, targets: rows.data });
      },
    );
    return () => controller.abort();
  }, [api, userId, revision]);

  // Nothing is set up, so there is nothing to change here.
  useEffect(() => {
    if (load.status === 'ready' && load.channels.length === 0) navigate('/notifications', true);
  }, [load]);

  const change = useCallback(
    async (channel: OutOfAppChannel, muted: boolean) => {
      setBusy(channel);
      setFailed(false);
      setSaved(null);
      const result = await setMute(api, channel, muted);
      setBusy(null);
      if (!result.ok) return setFailed(true);
      setSaved(channel);
      setLoad((current) => (current.status === 'ready' ? { ...current, prefs: result.data } : current));
    },
    [api],
  );

  return (
    <div className="if-notify if-notify--narrow">
      <a className="nf-back" href="/notifications">
        {copy.t('Back')}
      </a>
      <h1 className="nf-h1">{copy.t('Notification settings')}</h1>
      <p className="nf-intro">{copy.t('Settings intro')}</p>
      {load.status === 'loading' ? (
        <StateBlock kind="loading" rows={2} rowHeight={72} label={copy.t('Where we reach you')} />
      ) : load.status === 'failed' ? (
        <StateBlock
          kind="error"
          title={copy.t('Couldn’t load your settings.')}
          onRetry={() => setRevision((value) => value + 1)}
          retryLabel={copy.t('Try again')}
        />
      ) : load.channels.length === 0 ? null : (
        <>
          <h2 className="nf-h2">{copy.t('Where we reach you')}</h2>
          <ul className="nf-card nf-channels">
            {load.channels.map((channel) => {
              const pref = load.prefs.find((row) => row.channel === channel);
              const target = load.targets.find((row) => row.channel === channel);
              const detail = !target
                ? copy.t('Nothing on file')
                : channel === 'push'
                  ? copy.t('Device registered')
                  : `${target.address} · ${target.verifiedAt ? copy.t('Confirmed') : copy.t('Not confirmed yet')}`;
              return (
                <li key={channel} className="nf-channel">
                  <span className="nf-text">
                    <span className="nf-title">{copy.t(LABEL[channel])}</span>
                    <span className="nf-body">{detail}</span>
                  </span>
                  <span className="nf-channel__state" aria-live="polite">
                    {saved === channel ? copy.t('Saved') : ''}
                  </span>
                  <Switch
                    aria-label={`${copy.t('Send me these')}: ${copy.t(LABEL[channel])}`}
                    checked={pref ? !pref.muted : false}
                    disabled={!pref || busy !== null}
                    onCheckedChange={(on) => void change(channel, !on)}
                  />
                </li>
              );
            })}
          </ul>
          {failed ? (
            <p className="nf-note" role="alert">
              {copy.t('Couldn’t save that change.')}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
