import type { PayHaltAutoTrip, PayHaltEvent, PayHaltState } from '@intafaced/contracts';
import { haltChip, type ChipSpec } from '@/lib/merchants/chips';
import { formatUtc } from '@/lib/merchants/time';
import { shortId, StateBlock, StatusChip } from './ui';

/** Shared halt views: used by the merchant's Halts tab and the Treasury and halts page. */

export const HALT_SCOPE: Record<string, { label: string; hint: string }> = {
  intake: { label: 'Taking payments', hint: 'Intake: new payments are refused while this is halted.' },
  conversion: { label: 'Converting currency', hint: 'Conversion: no new conversion orders while this is halted.' },
  payout: { label: 'Paying out', hint: 'Payout: no money leaves to a destination while this is halted.' },
  settlement: { label: 'Settling to merchants', hint: 'Settlement: captured money is not released to merchants while this is halted.' },
};

export const scopeLabel = (scope: string) => HALT_SCOPE[scope]?.label ?? scope;

function who(userId: string | null, currentUserId: string | undefined) {
  if (userId === null) return <span className="mp-muted">unknown</span>;
  return (
    <>
      <code className="mp-sub" title={userId}>
        {shortId(userId)}
      </code>
      {currentUserId && userId.toLowerCase() === currentUserId.toLowerCase() ? <span className="mp-asset"> (you)</span> : null}
    </>
  );
}

export function AutoTripCard({ autoTrip }: { autoTrip: PayHaltAutoTrip }) {
  return autoTrip.enabled && autoTrip.consecutiveFailures !== null ? (
    <dl className="mp-kv" aria-label="Automatic trip">
      <div>
        <dt>Automatic trip</dt>
        <dd>
          <StatusChip spec={{ label: 'on', tone: 'live', hint: 'A run of failures pauses the operation by itself.' }} />
        </dd>
      </div>
      <div>
        <dt>Pauses an operation after</dt>
        <dd className="mp-num">
          {autoTrip.consecutiveFailures} failure{autoTrip.consecutiveFailures === 1 ? '' : 's'} in a row
        </dd>
      </div>
    </dl>
  ) : (
    <StateBlock kind="not_built" title="Automatic trip is off: nothing pauses by itself">
      No failure count has been set, and there is no default one. A venue or rail can keep failing without anything stopping until a founder
      halts it. Clearing a halt always takes two founders.
    </StateBlock>
  );
}

export function PendingClearsGap() {
  return (
    <StateBlock kind="not_built" title="Pending halt clears are not available yet">
      Clearing a halt takes two founders: the first records a proposal, a different founder repeats it to apply it. The service keeps that
      proposal but has no read for it, so this page cannot list proposals that are waiting for a second founder. Until it does, a cleared
      halt appears in the history below with the second founder named, and a halt that is still on stays on.
    </StateBlock>
  );
}

export function HaltStatesTable({ states, caption }: { states: readonly PayHaltState[]; caption: string }) {
  return (
    <div className="mp-scroll" tabIndex={0} role="region" aria-label={`${caption}, scrolls sideways on small screens`}>
      <table className="mp-table mp-table--rows">
        <caption className="mp-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Operation</th>
            <th scope="col">Covers</th>
            <th scope="col">State</th>
            <th scope="col">Why</th>
            <th scope="col">Since</th>
          </tr>
        </thead>
        <tbody>
          {states.map((s) => (
            <tr key={`${s.scope}-${s.target.level === 'global' ? 'global' : s.target.merchantId}`}>
              <th scope="row" title={HALT_SCOPE[s.scope]?.hint}>
                {scopeLabel(s.scope)}
              </th>
              <td>{s.target.level === 'global' ? 'Everyone' : `Merchant ${shortId(s.target.merchantId)}`}</td>
              <td>
                <StatusChip spec={haltChip(s.halted)} />
              </td>
              <td>{s.reason ?? <span className="mp-muted">—</span>}</td>
              <td className="mp-num">{s.changedAt === null ? <span className="mp-muted">never changed</span> : formatUtc(s.changedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function secondFounder(h: PayHaltEvent, currentUserId: string | undefined) {
  if (h.confirmedByUserId) {
    const chip: ChipSpec = {
      label: 'confirmed by a second founder',
      tone: 'live',
      hint: 'A different founder repeated the request, so two founders made this change.',
    };
    return (
      <>
        <StatusChip spec={chip} /> {who(h.confirmedByUserId, currentUserId)}
      </>
    );
  }
  if (h.halted) return <span className="mp-muted">Not needed: one founder can stop an operation</span>;
  if (h.source === 'auto_trip') return <span className="mp-muted">Not applicable</span>;
  const missing: ChipSpec = {
    label: 'no second founder recorded',
    tone: 'warn',
    hint: 'A clear needs two founders. This row has none recorded, so check it with engineering.',
  };
  return <StatusChip spec={missing} />;
}

export function HaltHistoryTable({
  events,
  currentUserId,
  showTarget = true,
}: {
  events: readonly PayHaltEvent[];
  currentUserId?: string | undefined;
  showTarget?: boolean;
}) {
  return (
    <div className="mp-scroll" tabIndex={0} role="region" aria-label="Halt history table, scrolls sideways on small screens">
      <table className="mp-table mp-table--rows">
        <caption className="mp-visually-hidden">Halt history</caption>
        <thead>
          <tr>
            <th scope="col">Operation</th>
            {showTarget ? <th scope="col">Covers</th> : null}
            <th scope="col">State</th>
            <th scope="col">Set by</th>
            <th scope="col">Second founder</th>
            <th scope="col">Why</th>
            <th scope="col">When</th>
          </tr>
        </thead>
        <tbody>
          {events.map((h, i) => (
            <tr key={`${h.scope}-${h.version}-${i}`}>
              <th scope="row" title={HALT_SCOPE[h.scope]?.hint}>
                {scopeLabel(h.scope)}
              </th>
              {showTarget ? <td>{h.target.level === 'global' ? 'Everyone' : `Merchant ${shortId(h.target.merchantId)}`}</td> : null}
              <td>
                <StatusChip spec={haltChip(h.halted)} />
              </td>
              <td>
                {h.source === 'auto_trip' ? (
                  'Automatic trip'
                ) : h.source === 'operator' ? (
                  <>A founder {who(h.actorUserId, currentUserId)}</>
                ) : (
                  <span className="mp-muted">Unknown</span>
                )}
              </td>
              <td>{secondFounder(h, currentUserId)}</td>
              <td>{h.reason ?? <span className="mp-muted">—</span>}</td>
              <td className="mp-num">{h.changedAt === null ? <span className="mp-muted">unknown</span> : formatUtc(h.changedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
