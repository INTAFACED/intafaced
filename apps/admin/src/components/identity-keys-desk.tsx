'use client';

import { useCallback, useRef, useState } from 'react';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchKeys, type KeysDeskView } from '@/lib/identity-ops/keys-browser';
import { removalIds, rotationCandidates, type KeyState } from '@/lib/identity-ops/keys-model';
import './desk.css';

/**
 * IDENTITY SIGNING KEYS.
 *
 * Which key signs access tokens now, which previous keys still verify, and the two-founder rotate and remove-old controls.
 * Only key ids are shown: the secrets live in the identity host's settings and are never typed here. A rotation can only go
 * to an id the host already holds a secret for; if there is none, the desk says so instead of offering a blank form.
 */

type Choice = 'rotate' | 'remove';

const ROTATE_NOTE =
  'The new key signs every token from now on; the current one keeps verifying, so nobody is signed out. Every other service must already carry the same key list, or it will refuse new tokens. Two different founders must agree.';
const REMOVE_NOTE =
  'Tokens signed with the previous keys stop working at once and their holders sign in again. Do this only after the overlap. Two different founders must agree.';

export function KeysPanel({ state }: { state: KeyState }) {
  return (
    <div className="dk-stack" data-testid="keys-state">
      <dl className="dk-kv">
        <dt>Signing key</dt>
        <dd className="dk-packet" data-testid="keys-active">
          {state.activeKeyId}
        </dd>
        <dt>Signing since</dt>
        <dd>{state.activatedAt ? formatWhen(state.activatedAt) : 'No rotation recorded: the original key is still signing.'}</dd>
        <dt>Previous keys still verifying</dt>
        <dd className="dk-packet" data-testid="keys-previous">
          {state.previousKeyIds.length === 0 ? 'none' : state.previousKeyIds.join(', ')}
        </dd>
        <dt>Keys the host holds a secret for</dt>
        <dd className="dk-packet">{state.availableKeyIds.join(', ')}</dd>
      </dl>
    </div>
  );
}

export function KeyControls({ state, userId, onChanged }: { state: KeyState; userId: string; onChanged: () => void }) {
  const candidates = rotationCandidates(state);
  const ids = removalIds(state);
  const [choice, setChoice] = useState<Choice>('rotate');
  const [picked, setPicked] = useState('');
  const keyId = candidates.includes(picked) ? picked : (candidates[0] ?? null);
  const mode: Choice = choice === 'remove' && ids === null ? 'rotate' : choice;

  const action: ControlAction | null =
    mode === 'rotate'
      ? keyId === null
        ? null
        : {
            heading: `Rotate the signing key to ${keyId}`,
            submitLabel: 'Ask a second founder to approve the rotation',
            needsReason: false,
            reasonLabel: '',
            build: () => ({ kind: 'identity.auth_key.rotate', keyId }),
            danger: true,
          }
      : ids === null
        ? null
        : {
            heading: `Remove the previous keys (${ids})`,
            submitLabel: 'Ask a second founder to approve the removal',
            needsReason: false,
            reasonLabel: '',
            build: () => ({ kind: 'identity.auth_key.remove_old', keyIds: ids }),
            danger: true,
          };

  const blocked =
    action === null
      ? mode === 'rotate'
        ? 'The identity host holds no secret for any key other than the ones already in use, so there is nothing to rotate to. Secrets are added to the identity service settings by whoever runs the host, never here.'
        : 'There is no previous key to remove.'
      : null;

  return (
    <ControlDesk
      key={`${mode}:${keyId ?? ''}:${ids ?? ''}`}
      endpoint="/api/identity-ops/keys"
      userId={userId}
      blockedReason={blocked}
      action={action}
      consequence={mode === 'rotate' ? ROTATE_NOTE : REMOVE_NOTE}
      blockedButtonLabel={mode === 'rotate' ? 'Rotation unavailable' : 'Removal unavailable'}
      onChanged={onChanged}
    >
      <div className="dk-row" role="group" aria-label="Key change">
        <button type="button" className="adm-btn" aria-pressed={mode === 'rotate'} onClick={() => setChoice('rotate')}>
          Rotate the signing key
        </button>
        <button
          type="button"
          className="adm-btn"
          aria-pressed={mode === 'remove'}
          disabled={ids === null}
          onClick={() => setChoice('remove')}
        >
          Remove previous keys
        </button>
      </div>
      {mode === 'rotate' && candidates.length > 0 && (
        <div className="adm-field">
          <label htmlFor="ik-key">New signing key</label>
          <select id="ik-key" className="adm-input" value={keyId ?? ''} onChange={(e) => setPicked(e.target.value)}>
            {candidates.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      )}
    </ControlDesk>
  );
}

export interface KeysDeskViewProps {
  readonly view: KeysDeskView | null;
  readonly loading: boolean;
  readonly userId: string;
  readonly onRefresh: () => void;
}

export function IdentityKeysDeskView({ view, loading, userId, onRefresh }: KeysDeskViewProps) {
  const state = view && view.state.kind === 'ok' ? view.state.data : null;
  return (
    <div className="dk" data-testid="identity-keys-desk">
      <div className="adm-pagehead">
        <div>
          <h1>Identity signing keys</h1>
          <p>
            Which key signs access tokens, which previous keys still verify, and the two-founder changes. Only ids appear here, never
            secrets.
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
        <div className="adm-callout" data-tone="danger" role="status" data-testid="keys-failed">
          <strong>Signing keys unavailable</strong>
          <p>{view.state.message}</p>
          {view.state.code && <p className="dk-muted">Code: {view.state.code}</p>}
        </div>
      )}
      {state && (
        <>
          <KeysPanel state={state} />
          <KeyControls state={state} userId={userId} onChanged={onRefresh} />
        </>
      )}
    </div>
  );
}

export function IdentityKeysDesk({ initial, userId }: { initial: KeysDeskView | null; userId: string }) {
  const [view, setView] = useState<KeysDeskView | null>(initial);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await fetchKeys();
    if (mine === sequence.current) {
      setView(next);
      setLoading(false);
    }
  }, []);
  return <IdentityKeysDeskView view={view} loading={loading} userId={userId} onRefresh={() => void reload()} />;
}
