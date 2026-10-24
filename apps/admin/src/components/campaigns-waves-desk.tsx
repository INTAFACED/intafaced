'use client';

import { useCallback, useRef, useState } from 'react';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchWaves, type WavesDeskView } from '@/lib/campaigns-ops/waves-browser';
import { releaseBlocked, type WavesState } from '@/lib/campaigns-ops/waves-model';
import './desk.css';

/**
 * WAITLIST WAVES (RC-campaigns-03).
 *
 * The owner's wave size, how many people still wait, the waves already released and the two-person release of the next one.
 * A wave invites the top people in the queue (most friends first, ties by who joined first) once. The size is the owner's
 * setting on the identity host and is never typed here; while it is blank the desk says so and offers no release.
 */

const RELEASE_NOTE =
  'The top people still waiting are invited at once and leave the queue; this cannot be undone. Releasing the same wave again invites nobody new. A second person must approve it: identity refuses an approval from the person who asked.';

export function WavesPanel({ state }: { state: WavesState }) {
  return (
    <div className="dk-stack" data-testid="waves-state">
      <dl className="dk-kv">
        <dt>Wave size</dt>
        <dd data-testid="waves-size">{state.waveSize === null ? 'Not set by the owner (IDENTITY_WAITLIST_WAVE_SIZE)' : state.waveSize}</dd>
        <dt>Next wave</dt>
        <dd data-testid="waves-next">{state.nextWave}</dd>
        <dt>Still waiting</dt>
        <dd data-testid="waves-waiting">{state.waiting}</dd>
      </dl>
      {state.waves.length === 0 ? (
        <p className="dk-muted">No wave has been released yet.</p>
      ) : (
        <table className="adm-table" data-testid="waves-released">
          <caption>Released waves</caption>
          <thead>
            <tr>
              <th scope="col">Wave</th>
              <th scope="col">Released</th>
              <th scope="col">Invited</th>
              <th scope="col">Requested by</th>
              <th scope="col">Approved by</th>
            </tr>
          </thead>
          <tbody>
            {state.waves.map((w) => (
              <tr key={w.waveNumber}>
                <td>{w.waveNumber}</td>
                <td>{formatWhen(w.releasedAt)}</td>
                <td>
                  {w.releasedCount} of {w.size}
                </td>
                <td className="dk-packet">{w.releasedBy}</td>
                <td className="dk-packet">{w.approvedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function WaveControls({ state, userId, onChanged }: { state: WavesState; userId: string; onChanged: () => void }) {
  const blocked = releaseBlocked(state);
  const size = state.waveSize;
  const action: ControlAction | null =
    blocked !== null || size === null
      ? null
      : {
          heading: `Release wave ${state.nextWave}: the top ${size} waiting`,
          submitLabel: 'Ask a second founder to approve the release',
          needsReason: false,
          reasonLabel: '',
          build: () => ({ kind: 'campaigns.waitlist.wave_release', wave: String(state.nextWave), size: String(size) }),
          danger: true,
        };
  return (
    <ControlDesk
      // Keyed on the size only: a run moves the next wave on, and the desk must keep showing that run's reply.
      key={String(size ?? '')}
      endpoint="/api/more-ops/waves"
      userId={userId}
      blockedReason={blocked}
      action={action}
      consequence={RELEASE_NOTE}
      blockedButtonLabel="Release unavailable"
      onChanged={onChanged}
    />
  );
}

export interface WavesDeskViewProps {
  readonly view: WavesDeskView | null;
  readonly loading: boolean;
  readonly userId: string;
  readonly onRefresh: () => void;
}

export function CampaignsWavesDeskView({ view, loading, userId, onRefresh }: WavesDeskViewProps) {
  const state = view && view.state.kind === 'ok' ? view.state.data : null;
  return (
    <div className="dk" data-testid="campaigns-waves-desk">
      <div className="adm-pagehead">
        <div>
          <h1>Waitlist waves</h1>
          <p>
            Who is still waiting, the waves already released, and the two-person release of the next wave. Operator ids only, never emails.
          </p>
        </div>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="dk-asof">{view ? `As of ${formatAsOf(view.asOf)} (when this console read svc-identity)` : 'No read yet'}</span>
      </div>
      {!view && <p className="dk-why">svc-identity could not be read. Nothing is shown rather than a guess.</p>}
      {view && view.state.kind === 'failed' && (
        <div className="adm-callout" data-tone="danger" role="status" data-testid="waves-failed">
          <strong>Waitlist waves unavailable</strong>
          <p>{view.state.message}</p>
          {view.state.code && <p className="dk-muted">Code: {view.state.code}</p>}
        </div>
      )}
      {state && (
        <>
          <WavesPanel state={state} />
          <WaveControls state={state} userId={userId} onChanged={onRefresh} />
        </>
      )}
    </div>
  );
}

export function CampaignsWavesDesk({ initial, userId }: { initial: WavesDeskView | null; userId: string }) {
  const [view, setView] = useState<WavesDeskView | null>(initial);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await fetchWaves();
    if (mine === sequence.current) {
      setView(next);
      setLoading(false);
    }
  }, []);
  return <CampaignsWavesDeskView view={view} loading={loading} userId={userId} onRefresh={() => void reload()} />;
}
