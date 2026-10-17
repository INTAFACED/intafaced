import type { PayHaltAutoTrip, PayHaltEvent, PayHaltPendingClear, PayHaltState } from '@intafaced/contracts';
import { haltChip, type ChipSpec } from '@/lib/merchants/chips';
import type { PayCallResult } from '@/lib/merchants/pay-call';
import { formatUtc } from '@/lib/merchants/time';
import { FailureState, shortId, StateBlock, StatusChip } from './ui';

/** Shared halt views: used by the merchant's Halts tab and the Treasury and halts page. */

export const HALT_SCOPE: Record<string, { label: string; hint: string }> = {
  intake: { label: 'Taking payments', hint: 'Intake: new payments are refused while this is halted.' },
  conversion: { label: 'Converting currency', hint: 'Conversion: no new conversion orders while this is halted.' },
  payout: { label: 'Paying out', hint: 'Payout: no money leaves to a destination while this is halted.' },
  settlement: { label: 'Settling to merchants', hint: 'Settlement: captured money is not released to merchants while this is halted.' },
};

export const scopeLabel = (scope: string) => HALT_SCOPE[scope]?.label ?? scope;

export function haltAppliesToMerchant(target: PayHaltState['target'], merchantId: string): boolean {
  if (target.level === 'global' || target.level === 'rail') return true;
  if (target.level === 'merchant') return target.merchantId === merchantId;
  return false;
}

export function haltCoversLabel(target: PayHaltState['target']): string {
  if (target.level === 'global') return 'Everyone';
  if (target.level === 'merchant') return `Merchant ${shortId(target.merchantId)}`;
  if (target.level === 'user') return `User ${shortId(target.userId)}`;
  return `Rail ${target.railId}`;
}

export function haltRowKey(scope: string, target: PayHaltState['target']): string {
  if (target.level === 'global') return `${scope}:global`;
  if (target.level === 'merchant') return `${scope}:merchant:${target.merchantId}`;
  if (target.level === 'user') return `${scope}:user:${target.userId}`;
  return `${scope}:rail:${target.railId}`;
}

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

/**
 * Clears that one founder proposed and a different founder has not confirmed yet (`payHalts.pendingClears`). Read only
 * here: confirming happens on the Ledger halts desk (/ledger), which repeats the same request as the second founder. Every row's halt is
 * STILL ON until then.
 */
export function PendingClearsPanel({
  result,
  currentUserId,
  merchantId,
  retryHref,
}: {
  result: PayCallResult<{ proposals: readonly PayHaltPendingClear[]; nextCursor: string | null }>;
  currentUserId?: string | undefined;
  /** On a merchant page only the clears that cover that merchant are listed. */
  merchantId?: string | undefined;
  retryHref: string;
}) {
  if (result.kind !== 'ok') return <FailureState failure={result} what="Clears waiting for a second founder" retryHref={retryHref} />;
  const rows = merchantId ? result.data.proposals.filter((p) => haltAppliesToMerchant(p.target, merchantId)) : result.data.proposals;
  if (rows.length === 0)
    return (
      <StateBlock kind="empty" title="No clear is waiting for a second founder">
        When one founder proposes clearing a halt, it is listed here until a different founder confirms it. A halt stays on until then.
      </StateBlock>
    );
  return (
    <>
      <div
        className="mp-scroll"
        tabIndex={0}
        role="region"
        aria-label="Clears waiting for a second founder, scrolls sideways on small screens"
      >
        <table className="mp-table mp-table--rows">
          <caption className="mp-visually-hidden">Halt clears waiting for a second founder</caption>
          <thead>
            <tr>
              <th scope="col">Operation</th>
              <th scope="col">Covers</th>
              <th scope="col">Reason given</th>
              <th scope="col">Proposed by</th>
              <th scope="col">Proposed at</th>
              <th scope="col">Your part</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const mine = currentUserId !== undefined && p.requestedByUserId.toLowerCase() === currentUserId.toLowerCase();
              return (
                <tr key={p.requestId} data-testid="pending-clear">
                  <th scope="row" title={HALT_SCOPE[p.scope]?.hint}>
                    {scopeLabel(p.scope)}
                  </th>
                  <td>{haltCoversLabel(p.target)}</td>
                  <td>{p.reason}</td>
                  <td>
                    <code title={p.requestedByUserId}>{shortId(p.requestedByUserId)}</code>
                    {mine ? ' (you)' : ''}
                  </td>
                  <td className="mp-num">{formatUtc(p.requestedAt)}</td>
                  <td>
                    {currentUserId === undefined ? (
                      <span className="mp-muted">A different founder from the proposer confirms it</span>
                    ) : mine ? (
                      <span className="mp-muted">You proposed it. A different founder has to confirm</span>
                    ) : (
                      <a className="mp-btn mp-btn--small" href="/ledger">
                        Review and confirm on the Ledger halts desk
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mp-footnote mp-mt">
        The halt is still on for every row above. A proposal older than the store&apos;s confirm window is not listed, because it can no
        longer be confirmed.{result.data.nextCursor ? ' More proposals exist than are shown; confirm these first.' : ''}
      </p>
    </>
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
            <tr key={haltRowKey(s.scope, s.target)}>
              <th scope="row" title={HALT_SCOPE[s.scope]?.hint}>
                {scopeLabel(s.scope)}
              </th>
              <td>{haltCoversLabel(s.target)}</td>
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
              {showTarget ? <td>{haltCoversLabel(h.target)}</td> : null}
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
