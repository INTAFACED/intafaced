'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import type { Part } from '@/lib/desk/part';
import {
  ISSUER_NEXT,
  LAUNCH_ID,
  LAUNCH_MOVE_TARGETS,
  type LaunchIssuerState,
  type LaunchMove,
  type LaunchMoveTarget,
} from '@/lib/launch-issuers/model';
import type { IssuerLensRead } from '@/lib/launch-issuers/server';
import '@/components/desk.css';

/**
 * The launch issuer lens (J-more-catalogue-14). Issuers and their review state, every launch with drafts included, and the
 * audited moves of each, as svc-token holds them. Every change needs two founders: one asks, the other approves the same
 * packet on their own console, then the first runs it.
 */

const STATE_LABEL: Record<LaunchIssuerState, string> = {
  applied: 'Applied',
  reviewing: 'In review',
  onboarded: 'Onboarded',
  suspended: 'Suspended',
};
const CAUSE_LABEL: Record<string, string> = { issuer_suspended: 'closed because its issuer was suspended' };

function Failed({ part }: { part: Extract<Part<unknown>, { kind: 'failed' }> }) {
  return (
    <p role="alert" className="dk-muted">
      {part.message}
      {part.code ? ` (${part.code})` : ''}
    </p>
  );
}

function Moves({ part, label }: { part: Part<LaunchMove[]> | undefined; label: string }) {
  if (!part) return null;
  if (part.kind === 'failed') return <Failed part={part} />;
  return (
    <details>
      <summary>History ({part.data.length})</summary>
      <ol aria-label={label}>
        {part.data.map((m) => (
          <li key={m.ordinal} data-testid="launch-move" data-cause={m.cause ?? ''}>
            {m.from ?? 'new'} → {m.to}
            {m.cause ? `, ${CAUSE_LABEL[m.cause] ?? m.cause}` : ''} · {formatWhen(m.at)} · asked by <code>{m.actorId}</code>, approved by{' '}
            <code>{m.approverId}</code>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function IssuerLens({ read, userId }: { read: IssuerLensRead; userId: string }) {
  const router = useRouter();
  const refresh = () => router.refresh();
  const issuers = read.issuers.kind === 'ok' ? read.issuers.data : [];
  const events = read.events.kind === 'ok' ? read.events.data : [];

  // Issuer review: an existing issuer's next step, or a new issuer, which starts as applied.
  const [issuerId, setIssuerId] = useState('');
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [state, setState] = useState('');
  const chosen = issuers.find((i) => i.id === issuerId) ?? null;
  const nextStates = chosen ? ISSUER_NEXT[chosen.state] : [];
  const adding = issuerId === '+';
  const issuerHold = adding
    ? !LAUNCH_ID.test(newId.trim())
      ? 'Type the new issuer’s id: 3 to 63 lowercase letters, digits or dashes.'
      : newName.trim() === ''
        ? 'Type the new issuer’s name.'
        : null
    : !chosen
      ? 'Choose an issuer.'
      : !(nextStates as readonly string[]).includes(state)
        ? 'Choose the issuer’s next state.'
        : null;
  const issuerAction: ControlAction = {
    heading: 'Review an issuer',
    submitLabel: 'Ask a second founder to approve this issuer change',
    needsReason: false,
    reasonLabel: '',
    build: () =>
      adding || !chosen
        ? { kind: 'token.launch.issuer.set', issuerId: newId.trim(), name: newName.trim(), state: 'applied', revision: '0' }
        : {
            kind: 'token.launch.issuer.set',
            issuerId: chosen.id,
            name: chosen.name,
            state: state as LaunchIssuerState,
            revision: String(chosen.revision),
          },
    danger: !adding && state === 'suspended',
  };

  // Launch moves: one step forward, or cancel. svc-token checks the period and the issuer.
  const [eventId, setEventId] = useState('');
  const [to, setTo] = useState('');
  const event = events.find((e) => e.id === eventId) ?? null;
  const moveHold = !event ? 'Choose a launch.' : !(LAUNCH_MOVE_TARGETS as readonly string[]).includes(to) ? 'Choose where it moves.' : null;
  const moveAction: ControlAction = {
    heading: 'Move a launch',
    submitLabel: 'Ask a second founder to approve this launch move',
    needsReason: false,
    reasonLabel: '',
    build: () => ({
      kind: 'token.launch.event.move',
      eventId: event?.id ?? 'x',
      to: (to || 'announced') as LaunchMoveTarget,
      revision: String(event?.revision ?? 0),
    }),
  };

  return (
    <div className="dk" data-testid="launch-issuer-lens">
      <div className="adm-pagehead">
        <div>
          <h1>Launch issuers</h1>
          <p>Issuers and their review, every launch including drafts, and who moved each one. Every change needs two founders.</p>
        </div>
        <Link className="adm-btn" href="/launch/new">
          New launch draft
        </Link>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={refresh}>
          Refresh
        </button>
        <span className="dk-asof">As of {formatAsOf(read.asOf)} (when this console read svc-token)</span>
      </div>

      <section className="dk-stack" aria-labelledby="launch-issuers-h">
        <h2 id="launch-issuers-h">Issuers</h2>
        {read.issuers.kind === 'failed' ? (
          <Failed part={read.issuers} />
        ) : issuers.length === 0 ? (
          <p className="dk-muted">No issuer has applied yet.</p>
        ) : (
          <table className="adm-table" aria-label="Issuers">
            <thead>
              <tr>
                <th scope="col">Issuer</th>
                <th scope="col">State</th>
                <th scope="col">Revision</th>
                <th scope="col">History</th>
              </tr>
            </thead>
            <tbody>
              {issuers.map((i) => (
                <tr key={i.id} data-issuer={i.id}>
                  <td>
                    {i.name} <code>{i.id}</code>
                  </td>
                  <td data-testid="issuer-state">{STATE_LABEL[i.state]}</td>
                  <td>{i.revision}</td>
                  <td>
                    <Moves part={read.issuerMoves[i.id]} label={`History of issuer ${i.id}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="dk-row">
          <label>
            Issuer
            <select value={issuerId} onChange={(e) => (setIssuerId(e.target.value), setState(''))}>
              <option value="">Choose</option>
              {issuers.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({STATE_LABEL[i.state]})
                </option>
              ))}
              <option value="+">A new issuer</option>
            </select>
          </label>
          {adding ? (
            <>
              <label>
                New issuer id
                <input value={newId} onChange={(e) => setNewId(e.target.value)} />
              </label>
              <label>
                New issuer name
                <input value={newName} onChange={(e) => setNewName(e.target.value)} />
              </label>
            </>
          ) : (
            <label>
              Next state
              <select value={state} onChange={(e) => setState(e.target.value)} disabled={!chosen}>
                <option value="">Choose</option>
                {nextStates.map((s) => (
                  <option key={s} value={s}>
                    {STATE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <ControlDesk
          key="launch-issuer"
          endpoint="/api/launch/issuers"
          userId={userId}
          blockedReason={read.issuers.kind === 'failed' ? 'The issuers cannot be read, so none can be changed.' : null}
          formHold={issuerHold}
          action={issuerAction}
          consequence="svc-token applies the change only if the issuer is still at the revision read. Suspending an issuer closes each of its open launches in the same step, and every move is recorded with both founders."
          blockedButtonLabel="Issuer changes unavailable"
          onChanged={refresh}
        />
      </section>

      <section className="dk-stack" aria-labelledby="launch-events-h">
        <h2 id="launch-events-h">Launches</h2>
        {read.events.kind === 'failed' ? (
          <Failed part={read.events} />
        ) : events.length === 0 ? (
          <p className="dk-muted">No launch has been saved yet, not even a draft.</p>
        ) : (
          <table className="adm-table" aria-label="Launches">
            <thead>
              <tr>
                <th scope="col">Launch</th>
                <th scope="col">Issuer</th>
                <th scope="col">Status</th>
                <th scope="col">Opens</th>
                <th scope="col">Revision</th>
                <th scope="col">History</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} data-launch={e.id}>
                  <td>
                    {e.projectName} ({e.symbol}) <code>{e.id}</code>
                  </td>
                  <td>
                    {e.issuer.name} · <span data-testid="launch-issuer-state">{STATE_LABEL[e.issuer.state]}</span>
                  </td>
                  <td data-testid="launch-status">{e.status}</td>
                  <td>{formatWhen(e.periods.openAt)}</td>
                  <td>{e.revision}</td>
                  <td>
                    <Moves part={read.eventMoves[e.id]} label={`History of launch ${e.id}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="dk-row">
          <label>
            Launch
            <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
              <option value="">Choose</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.id} ({e.status})
                </option>
              ))}
            </select>
          </label>
          <label>
            Move to
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose</option>
              {LAUNCH_MOVE_TARGETS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ControlDesk
          key="launch-move"
          endpoint="/api/launch/issuers"
          userId={userId}
          blockedReason={read.events.kind === 'failed' ? 'The launches cannot be read, so none can be moved.' : null}
          formHold={moveHold}
          action={moveAction}
          consequence="svc-token moves a launch one step at a time, only once that step's period has begun, and announces, snapshots or opens it only for an onboarded issuer. Past closed, allocation needs a ledger recipe that is not wired, so it refuses."
          blockedButtonLabel="Launch moves unavailable"
          onChanged={refresh}
        />
      </section>

      <section className="dk-stack" aria-labelledby="launch-parked-h" data-testid="launch-parked">
        <h2 id="launch-parked-h">Not wired yet</h2>
        <ul>
          {PARKED.map(([what, why]) => (
            <li key={what}>
              <strong>{what}</strong>: {why}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** The parts of a launch this lens cannot show yet, each with what blocks it. Nothing here is read or estimated. */
const PARKED: readonly (readonly [string, string])[] = [
  [
    'Commits and refunds per launch',
    'subscribing, allocation and refunds have no ledger recipe wired yet (MC-launch-03), so there is no progress to read.',
  ],
  ['Fundraising milestones and investor records', 'svc-token keeps no milestone or investor record yet (RC-more-catalogue-22).'],
  ['Wrapped, synthetic or structured issuance', 'svc-token records no issuance kind yet (RC-more-catalogue-23).'],
  ['Marketing claims evidence register', 'no service keeps claims and their evidence yet (RC-more-catalogue-24).'],
];
