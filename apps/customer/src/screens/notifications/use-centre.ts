import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../features/session/session';
import { channelStatus, mutePrefs, setMute, targets, type MutePref, type OutOfAppChannel, type TargetRow } from './notify-api';
import { OUT_OF_APP, type ChannelFacts, type OutOfApp } from './prefs';

export interface ChannelView {
  facts: ChannelFacts;
  /** The address (or, for a phone, the fact that a device is registered) as the service holds it. */
  address: string | null;
  verifiedAt: string | null;
}

export type CentreLoad = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; channels: Record<OutOfApp, ChannelView> };

/** Join the three reads (what the platform can send, the person's pauses, the saved addresses) into one view per channel. */
export function buildChannels(
  statuses: readonly { channel: string; configured: boolean; available: boolean }[],
  prefs: readonly MutePref[],
  rows: readonly TargetRow[],
): Record<OutOfApp, ChannelView> {
  const view = (channel: OutOfApp): ChannelView => {
    const status = statuses.find((row) => row.channel === channel);
    const pref = prefs.find((row) => row.channel === channel);
    const target = rows.find((row) => row.channel === channel);
    return {
      facts: {
        ready: Boolean(status?.configured && status.available),
        muted: pref ? pref.muted : null,
        target: target ? { verified: target.verifiedAt !== null } : null,
      },
      address: target ? target.address : null,
      verifiedAt: target ? target.verifiedAt : null,
    };
  };
  return { email: view('email'), push: view('push'), sms: view('sms') };
}

export function useCentre() {
  const { api, userId } = useSession();
  const [load, setLoad] = useState<CentreLoad>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void Promise.all([channelStatus(api, controller.signal), mutePrefs(api, controller.signal), targets(api, controller.signal)]).then(
      ([channels, prefs, rows]) => {
        if (controller.signal.aborted) return;
        if (!channels.ok || !prefs.ok || !rows.ok) return setLoad({ status: 'failed' });
        setLoad({ status: 'ready', channels: buildChannels(channels.data, prefs.data, rows.data) });
      },
    );
    return () => controller.abort();
  }, [api, userId, revision]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  /** Pause or resume one way of reaching the person; the service's answer replaces what is shown. */
  const mute = useCallback(
    async (channel: OutOfAppChannel, muted: boolean) => {
      const result = await setMute(api, channel, muted);
      if (result.ok)
        setLoad((current) =>
          current.status === 'ready'
            ? {
                status: 'ready',
                channels: Object.fromEntries(
                  OUT_OF_APP.map((id) => {
                    const pref = result.data.find((row) => row.channel === id);
                    const old = current.channels[id];
                    return [id, pref ? { ...old, facts: { ...old.facts, muted: pref.muted } } : old];
                  }),
                ) as Record<OutOfApp, ChannelView>,
              }
            : current,
        );
      return result.ok;
    },
    [api],
  );
  return { load, reload, mute };
}
