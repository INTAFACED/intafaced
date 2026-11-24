'use client';

import Link from 'next/link';
import { useState } from 'react';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';
import {
  HELD_REASON_TEXT,
  SETTLEMENT_WINDOWS,
  STATUS_LABEL,
  parseReconcileResult,
  reconcileLine,
  type FollowAccounting,
  type ReconcileResult,
  type SettlementList,
  type SettlementRow,
} from '@/lib/trade-ops/copy-settlements';
import { OutcomeNotice } from './outcome-notice';

/**
 * Copy settlement oversight (CB-ops-02, J-copy-bots-otc-11 #1 to #4). Each lead fee share with its status: "Settled" when
 * the ledger's posts under its keys and the builder fee the venue reported for the fill agree with it; "Held" with its key
 * and every reason otherwise; "Not owed" when the cap or a zero fee left nothing. Reconcile judges one chosen window again
 * and lists the counts each run gave. Read only.
 */

const TABLE = 'w-full border-collapse text-sm [&_td]:py-1 [&_td]:pe-3 [&_th]:py-1 [&_th]:pe-3 [&_th]:text-start [&_td]:text-start';
const short = (id: string) => id.slice(0, 8);

function SharesTable({ rows, label, linkFollow }: { rows: readonly SettlementRow[]; label: string; linkFollow: boolean }) {
  return (
    <table aria-label={label} className={TABLE}>
      <thead>
        <tr>
          <th>Status</th>
          <th>Fill</th>
          <th>Lead</th>
          <th>Follower</th>
          <th>Owed to lead</th>
          <th>Fee of fill</th>
          <th>Ledger post</th>
          <th>Venue builder fee</th>
          <th>Key</th>
          <th>Reason</th>
          {linkFollow ? <th>Follow</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.followId}:${r.fillId}`} data-settlement={r.status} data-fill={r.fillId}>
            <td>{STATUS_LABEL[r.status]}</td>
            <td className="if-num">{short(r.fillId)}</td>
            <td className="if-num">{short(r.leaderId)}</td>
            <td className="if-num">{short(r.followerId)}</td>
            <td className="if-num">
              {r.owed} {r.assetId}
            </td>
            <td className="if-num">
              {r.feeOfFill} {r.assetId}
            </td>
            <td className="if-num">{r.ledgerAmount ?? 'None'}</td>
            <td className="if-num">{r.venueAmount === null ? 'Not reported' : `${r.venueAmount} (${r.venueId})`}</td>
            <td className="if-num break-all">{r.key}</td>
            <td>
              {r.status === 'not_owed'
                ? r.notOwedReason === 'cap_reached'
                  ? 'The cap for this follower was reached.'
                  : 'The share came to zero.'
                : r.reasons.map((x) => HELD_REASON_TEXT[x]).join(' ')}
            </td>
            {linkFollow ? (
              <td>
                <Link href={`/trade-ops/copy/follows/${encodeURIComponent(r.followId)}`}>Open follow</Link>
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Reconcile() {
  const [window, setWindow] = useState('');
  const [runs, setRuns] = useState<ReconcileResult[]>([]);
  const [last, setLast] = useState<Outcome<unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label="Reconcile" className="flex flex-col gap-2 border border-line p-3">
      <h2 className="text-sm font-medium">Reconcile</h2>
      <p className="text-sm text-fg-2">
        Judges every lead fee share created in the window again, against the ledger and the venue, and gives the counts. Nothing is posted.
      </p>
      <div className="flex items-center gap-2">
        <label className="text-sm" htmlFor="settlement-window">
          Window
        </label>
        <select id="settlement-window" value={window} onChange={(e) => setWindow(e.target.value)} className="border border-line text-sm">
          <option value="">Choose a window</option>
          {SETTLEMENT_WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          className="border border-line px-2 text-sm"
          onClick={async () => {
            setLast(null);
            setBusy(true);
            // A blank window goes to svc-trade as it is: the service refuses it by name, and that refusal is shown.
            const outcome = await tradeOpsAction('copy-settlements', { action: 'reconcile', window: window || null });
            setBusy(false);
            const result = outcome.kind === 'ok' ? parseReconcileResult(outcome.data) : null;
            if (result) setRuns((prev) => [...prev, result]);
            else setLast(outcome);
          }}
        >
          Reconcile
        </button>
      </div>
      {last?.kind === 'refused' ? (
        <p role="alert" className="text-sm text-fg" data-refusal={last.code}>
          {last.message} Reference {last.code}
        </p>
      ) : last ? (
        <OutcomeNotice outcome={last} />
      ) : null}
      {runs.length > 0 ? (
        <div role="status" aria-label="Reconcile result" className="flex flex-col gap-1 text-sm">
          <p data-reconcile-latest="" data-compared={runs.at(-1)!.counts.compared} data-held={runs.at(-1)!.counts.held}>
            {reconcileLine(runs.at(-1)!)}
          </p>
          {runs.length > 1 ? (
            <ol className="text-xs text-fg-3" aria-label="Earlier runs">
              {runs.slice(0, -1).map((r, i) => (
                <li key={`${r.through}:${i}`}>{reconcileLine(r)}</li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-fg-3">No reconcile has run from this page.</p>
      )}
    </section>
  );
}

export function CopySettlements({ read }: { read: Outcome<SettlementList> }) {
  return (
    <div className="flex flex-col gap-4">
      <Reconcile />
      <section aria-label="Lead fee shares" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Lead fee shares</h2>
        {read.kind !== 'ok' ? (
          <OutcomeNotice outcome={read} />
        ) : read.data.rows.length === 0 ? (
          <p className="text-sm text-fg-2">No lead fee share has been settled.</p>
        ) : (
          <>
            <p className="text-sm text-fg-2" data-counts="">
              {read.data.counts.compared} newest shown: settled {read.data.counts.settled}, held {read.data.counts.held}, not owed{' '}
              {read.data.counts.notOwed}.
            </p>
            <SharesTable rows={read.data.rows} label="Settlements" linkFollow />
          </>
        )}
      </section>
    </div>
  );
}

export function FollowAccountingView({ read }: { read: Outcome<FollowAccounting> }) {
  if (read.kind !== 'ok') return <OutcomeNotice outcome={read} />;
  const f = read.data;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        <Link href="/trade-ops/copy/settlements">Back to Copy settlements</Link>
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 text-sm">
        <dt>Follow</dt>
        <dd className="if-num">{f.followId}</dd>
        <dt>Lead</dt>
        <dd className="if-num">{f.leaderId}</dd>
        <dt>Follower</dt>
        <dd className="if-num">{f.followerId}</dd>
        <dt>Since</dt>
        <dd className="if-num">{f.createdAt.slice(0, 19).replace('T', ' ')} UTC</dd>
      </dl>
      <section aria-label="Follow fee shares" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Fee shares</h2>
        {f.feeShares.length === 0 ? (
          <p className="text-sm text-fg-2">No lead fee share on this follow.</p>
        ) : (
          <SharesTable rows={f.feeShares} label="Fee shares" linkFollow={false} />
        )}
      </section>
      <section aria-label="Follow positions" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Positions</h2>
        {f.positions.length === 0 ? (
          <p className="text-sm text-fg-2">No copied position on this follow.</p>
        ) : (
          <table aria-label="Positions" className={TABLE}>
            <thead>
              <tr>
                <th>Position</th>
                <th>Market</th>
                <th>Bought</th>
                <th>Open</th>
                <th>Closing</th>
                <th>Status</th>
                <th>Placed</th>
              </tr>
            </thead>
            <tbody>
              {f.positions.map((p) => (
                <tr key={p.positionId} data-position={p.positionId}>
                  <td className="if-num">{short(p.positionId)}</td>
                  <td>{p.market}</td>
                  <td className="if-num">{p.bought}</td>
                  <td className="if-num">{p.open}</td>
                  <td className="if-num">{p.closing}</td>
                  <td>{p.status}</td>
                  <td className="if-num">{p.placedAt.slice(0, 19).replace('T', ' ')} UTC</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
