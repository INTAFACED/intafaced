'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { ActionApproval } from '@intafaced/contracts';
import { PageSection } from './kit';
import { ConfirmAction } from './confirm-action';
import { OutcomeNotice } from './outcome-notice';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';
import type { FeesDeskView } from '@/lib/trade-ops/fees-calls';
import type { FeeNotice } from '@/lib/trade-ops/fees-desk-parse';
import {
  STATE_LABEL,
  buildProposal,
  draftFrom,
  pairGroupViews,
  rateText,
  rebateTiers,
  shownTime,
  shownVersions,
  tierProgramOf,
  tierProgramText,
  versionInForce,
  versionStates,
  type FeeHistory,
  type FeeVersionRow,
  type ProposalDraft,
} from '@/lib/trade-ops/fees-versions-model';

/**
 * Fees and convert (J-cex-spot-17): fee versions by pair group, a proposal a second founder approves, VIP thresholds and
 * the snapshot runs, maker rebate tiers, the customer's fee-change notice, Convert's state and limits, and finance's read
 * of sell quotes and fiat buy fees. Every number is the service's own string; a blank owner value reads "not set". A
 * proposal is checked on the page before anything is sent, and the services check it again.
 */

function Problem({ outcome, title }: { outcome: Outcome<unknown>; title: string }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="text-fg">{title}</p>
      <OutcomeNotice outcome={outcome} />
    </div>
  );
}

function Pairs({ items }: { items: ReadonlyArray<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm md:grid-cols-[max-content_1fr]">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-fg-2">{item.label}</dt>
          <dd className="if-num text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const TABLE = 'w-full border-collapse text-sm [&_td]:py-1 [&_td]:pe-3 [&_th]:py-1 [&_th]:pe-3 [&_th]:text-start [&_td]:text-start';

// ── #1 fee versions by pair group ──

function Versions({ history, now }: { history: FeeHistory; now: Date }) {
  const groups = pairGroupViews(history.history, now);
  const programmes = shownVersions(history.history, now)
    .map(({ row }) => ({ row, programme: tierProgramOf(row.schedule) }))
    .filter((p) => p.programme !== null);
  if (groups.length === 0)
    return (
      <p className="text-sm text-fg-2" data-fees="no-versions">
        No version is stored yet: customers are charged the boot schedule until a first version is written.
      </p>
    );
  return (
    <div className="flex flex-col gap-4" data-fees="versions">
      <p className="text-sm text-fg-2">
        Every scheduled version, the one in force and up to five before it. The latest is v{history.version}.
      </p>
      {groups.map((g) => (
        <section key={g.group} data-pair-group={g.group} className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{g.group}</h3>
          <p className="text-xs text-fg-2">
            {g.markets === null
              ? 'Every market not named in another group.'
              : g.markets.length
                ? `Markets: ${g.markets.join(', ')}`
                : 'No market is named in this group in the latest version.'}
          </p>
          <table className={TABLE}>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">State</th>
                <th scope="col">Takes effect</th>
                <th scope="col">Tier</th>
                <th scope="col">Maker</th>
                <th scope="col">Taker</th>
                <th scope="col">Maker rebate</th>
                <th scope="col">Minimum fee</th>
              </tr>
            </thead>
            <tbody>
              {g.lines.map((line) => (
                <tr
                  key={`${line.version}:${line.tierId}`}
                  data-version={`v${line.version}`}
                  data-tier={line.tierId}
                  data-state={line.state}
                >
                  <th scope="row" className="if-num">
                    v{line.version}
                  </th>
                  <td>{STATE_LABEL[line.state]}</td>
                  <td className="if-num">{shownTime(line.effectiveAt)}</td>
                  <td>{line.tierId}</td>
                  <td className="if-num">{line.maker}</td>
                  <td className="if-num">{line.taker}</td>
                  <td className="if-num">{line.rebate}</td>
                  <td className="if-num">{line.minFee}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {programmes.length ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">VIP tier programme</h3>
          {programmes.map(({ row, programme }) => (
            <p key={row.version} className="text-sm" data-fees="programme" data-version={`v${row.version}`}>
              v{row.version}: {tierProgramText(programme!)}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── #2-#4 the proposal ──

function Propose({ base, onWritten }: { base: FeeVersionRow; onWritten: () => void }) {
  const [draft, setDraft] = useState<ProposalDraft>(() => draftFrom(base));
  const [reason, setReason] = useState('');
  const [localRefusal, setLocalRefusal] = useState<{ code: string; message: string } | null>(null);
  const [proposed, setProposed] = useState<Outcome<{ approval: ActionApproval; payloadHash: string }> | null>(null);
  const [approvalId, setApprovalId] = useState('');
  const [written, setWritten] = useState<FeeVersionRow | null>(null);
  const [busy, setBusy] = useState(false);

  const setRate = (i: number, field: 'makerBps' | 'takerBps', value: string) =>
    setDraft((d) => ({ ...d, rates: d.rates.map((r, j) => (j === i ? { ...r, [field]: value } : r)) }));
  const setThreshold = (i: number, value: string) =>
    setDraft((d) => ({ ...d, thresholds: d.thresholds?.map((t, j) => (j === i ? { ...t, minVolume30d: value } : t)) ?? null }));
  const body = () => ({ basisVersion: base.version, draft, reason: reason.trim() });

  async function propose() {
    setProposed(null);
    setWritten(null);
    // Checked here first: a blank or malformed value is refused with its typed code, and nothing is sent.
    const check = buildProposal(base, draft, reason, new Date());
    if (!check.ok) {
      setLocalRefusal({ code: check.code, message: check.message });
      return;
    }
    setLocalRefusal(null);
    setBusy(true);
    setProposed(await tradeOpsAction<{ approval: ActionApproval; payloadHash: string }>('fees', { action: 'propose', ...body() }));
    setBusy(false);
  }

  const check = buildProposal(base, draft, reason, new Date());
  return (
    <div className="flex flex-col gap-3" data-fees="propose">
      <p className="text-sm text-fg-2">
        Starts from v{base.version} (takes effect {shownTime(base.effectiveAt)}). Change what should change; everything else is kept
        exactly. A second founder approves the exact version before it is written, and it takes effect at the time you state, so an order
        already placed keeps the version it was placed under.
      </p>
      <table className={TABLE}>
        <thead>
          <tr>
            <th scope="col">Pair group / tier</th>
            <th scope="col">Maker (bps)</th>
            <th scope="col">Taker (bps)</th>
          </tr>
        </thead>
        <tbody>
          {draft.rates.map((r, i) => (
            <tr key={`${r.pairGroup}:${r.tierId}`}>
              <th scope="row">
                {r.pairGroup} / {r.tierId}
              </th>
              <td>
                <input
                  className="adm-input"
                  inputMode="numeric"
                  aria-label={`Maker bps, ${r.pairGroup} / ${r.tierId}`}
                  value={r.makerBps}
                  onChange={(e) => setRate(i, 'makerBps', e.target.value)}
                />
              </td>
              <td>
                <input
                  className="adm-input"
                  inputMode="numeric"
                  aria-label={`Taker bps, ${r.pairGroup} / ${r.tierId}`}
                  value={r.takerBps}
                  onChange={(e) => setRate(i, 'takerBps', e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {draft.thresholds === null ? (
        <p className="text-sm text-fg-2">
          This version has no VIP tier programme: thresholds not set, every account is on the regular tier.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          {draft.thresholds.map((t, i) => (
            <label key={t.tierId} className="flex flex-col gap-1 text-sm">
              <span>Threshold (30-day volume), {t.tierId}</span>
              <input
                className="adm-input"
                inputMode="decimal"
                aria-label={`Threshold (30-day volume), ${t.tierId}`}
                value={t.minVolume30d}
                onChange={(e) => setThreshold(i, e.target.value)}
              />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-sm">
            <span>Snapshot time (UTC, HH:MM)</span>
            <input
              className="adm-input"
              aria-label="Snapshot time (UTC, HH:MM)"
              value={draft.snapshotTimeUtc ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, snapshotTimeUtc: e.target.value }))}
            />
          </label>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>Takes effect at (UTC)</span>
          <input
            className="adm-input"
            aria-label="Takes effect at (UTC)"
            placeholder="2026-11-06T16:00:00Z"
            value={draft.effectiveAt}
            onChange={(e) => setDraft((d) => ({ ...d, effectiveAt: e.target.value }))}
          />
        </label>
        <label className="flex min-w-[24rem] flex-col gap-1 text-sm">
          <span>Reason (12 to 500 characters, kept in the audit)</span>
          <input
            className="adm-input"
            aria-label="Reason (12 to 500 characters, kept in the audit)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>
      <div>
        <button type="button" className="adm-btn" data-tone="primary" disabled={busy} onClick={() => void propose()}>
          Ask a second founder to approve
        </button>
      </div>
      {localRefusal ? (
        <div role="alert" className="flex flex-col gap-1 text-sm" data-fees="refused">
          <span>
            Refused <code className="if-num text-xs">{localRefusal.code}</code>
          </span>
          <span className="text-fg-2">{localRefusal.message} Nothing was sent.</span>
        </div>
      ) : null}
      {proposed ? (
        <div className="flex flex-col gap-2" data-fees="proposed">
          <OutcomeNotice outcome={proposed} doneText="Request filed" />
          {proposed.kind === 'ok' ? (
            <Pairs
              items={[
                { label: 'Approval id (apply with this once approved)', value: proposed.data.approval.approvalId },
                { label: 'Payload hash (the approver confirms this)', value: proposed.data.payloadHash },
                { label: 'Bound to version', value: `v${proposed.data.approval.expectedVersion}` },
              ]}
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>Approved request id</span>
          <input
            className="adm-input"
            aria-label="Approved request id"
            value={approvalId}
            onChange={(e) => setApprovalId(e.target.value)}
          />
        </label>
        <ConfirmAction
          trigger="Apply the approved version"
          title={`Write the version after v${base.version}?`}
          consequence={
            check.ok
              ? `A new version takes effect ${shownTime(check.effectiveAt)}. Orders placed from then on are charged it; an order placed before keeps its version. Nothing moves now. The approval is used up.`
              : `It cannot be written as it stands: ${check.message}`
          }
          confirmLabel="Write version"
          reasonMin={0}
          disabled={approvalId.trim() === '' || !check.ok}
          disabledReason={check.ok ? 'Enter the approved request id.' : check.message}
          doneText="Written"
          run={() => tradeOpsAction('fees', { action: 'apply', ...body(), approvalId: approvalId.trim() })}
          onDone={(o) => {
            if (o.kind === 'ok') {
              setWritten(o.data as FeeVersionRow);
              onWritten();
            }
          }}
        />
      </div>
      {written ? (
        <p role="status" className="text-sm" data-fees="written" data-version={written.version} data-effective-at={written.effectiveAt}>
          Written: v{written.version}, takes effect {shownTime(written.effectiveAt)}.
        </p>
      ) : null}
    </div>
  );
}

// ── #4 snapshot runs ──

function Snapshots({ view }: { view: FeesDeskView['snapshots'] }) {
  if (view.kind !== 'ok') return <Problem outcome={view} title="The snapshot runs could not be read" />;
  if (view.data.length === 0)
    return (
      <p className="text-sm text-fg-2" data-fees="snapshots">
        No snapshot has run: a run needs a version with a VIP programme and a snapshot time.
      </p>
    );
  return (
    <table className={TABLE} data-fees="snapshots">
      <thead>
        <tr>
          <th scope="col">Snapshot at</th>
          <th scope="col">Version</th>
          <th scope="col">Accounts</th>
          <th scope="col">Above regular</th>
          <th scope="col">Counted 30-day volume</th>
        </tr>
      </thead>
      <tbody>
        {view.data.map((run) => (
          <tr key={run.instant} data-snapshot={run.instant}>
            <th scope="row" className="if-num">
              {shownTime(run.instant)}
            </th>
            <td className="if-num">{run.scheduleVersion}</td>
            <td className="if-num">{run.accounts}</td>
            <td className="if-num">{run.aboveRegular}</td>
            <td className="if-num">{run.countedVolume}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── #5 maker rebate tiers ──

function Rebates({ inForce }: { inForce: FeeVersionRow | null }) {
  return (
    <div className="flex flex-col gap-2" data-fees="rebates">
      <h3 className="text-sm font-semibold">Maker rebate tiers</h3>
      {inForce === null ? (
        <p className="text-sm text-fg-2">No stored version is in force: the boot schedule applies, and it names no rebate.</p>
      ) : (
        <>
          <p className="text-sm text-fg-2">
            From the version in force: v{inForce.version}. Read only: a rebate changes through a new version above.
          </p>
          <table className={TABLE}>
            <thead>
              <tr>
                <th scope="col">Pair group</th>
                <th scope="col">Tier</th>
                <th scope="col">Maker fee</th>
                <th scope="col">Maker rebate</th>
              </tr>
            </thead>
            <tbody>
              {rebateTiers(inForce).map((r) => (
                <tr key={`${r.pairGroup}:${r.tierId}`} data-pair-group={r.pairGroup} data-tier={r.tierId}>
                  <td>{r.pairGroup}</td>
                  <td>{r.tierId}</td>
                  <td className="if-num">{r.maker}</td>
                  <td className="if-num">{r.rebate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ── #6 the fee-change notice ──

function Notice({ scheduled }: { scheduled: readonly FeeVersionRow[] }) {
  const [version, setVersion] = useState(scheduled[0]?.version ?? '');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Outcome<FeeNotice> | null>(null);
  const [requested, setRequested] = useState<Outcome<{ approval: ActionApproval; payloadHash: string }> | null>(null);
  const [approvalId, setApprovalId] = useState('');
  const [published, setPublished] = useState<Outcome<FeeNotice> | null>(null);
  const [busy, setBusy] = useState(false);
  const row = scheduled.find((r) => r.version === version) ?? null;
  const noticeId = draft?.kind === 'ok' ? draft.data.id : null;

  const run = async <T,>(set: (o: Outcome<T>) => void, body: Record<string, unknown>) => {
    setBusy(true);
    set(await tradeOpsAction<T>('fees', body));
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-3" data-fees="notice">
      {scheduled.length === 0 ? (
        <p className="text-sm text-fg-2">No version is scheduled: a notice comes before a change, so there is nothing to announce yet.</p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>Version the notice is for</span>
          <select
            className="adm-input"
            aria-label="Version the notice is for"
            value={version === '' ? '' : `v${version}`}
            disabled={scheduled.length === 0}
            onChange={(e) => {
              setVersion(e.target.value.replace(/^v/, ''));
              setDraft(null);
              setRequested(null);
              setPublished(null);
            }}
          >
            {scheduled.map((r) => (
              <option key={r.version} value={`v${r.version}`}>
                v{r.version}
              </option>
            ))}
          </select>
        </label>
        {row ? (
          <span className="text-sm" data-fees="notice-effective">
            Takes effect {shownTime(row.effectiveAt)}
          </span>
        ) : null}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span>Notice title</span>
        <input className="adm-input" aria-label="Notice title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>Notice text</span>
        <textarea className="adm-input" aria-label="Notice text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="adm-btn"
          disabled={busy || row === null || title.trim() === '' || text.trim() === ''}
          onClick={() => void run(setDraft, { action: 'notice-draft', version, title, body: text })}
        >
          Save the notice draft
        </button>
        <button
          type="button"
          className="adm-btn"
          disabled={busy || noticeId === null}
          onClick={() => void run(setRequested, { action: 'notice-request', noticeId })}
        >
          Ask a second founder to approve the notice
        </button>
      </div>
      {draft?.kind === 'ok' ? (
        <p role="status" className="text-sm" data-fees="notice-draft" data-notice-id={draft.data.id}>
          Draft saved. Nothing is public until a second founder approves and it is published.
        </p>
      ) : draft ? (
        <OutcomeNotice outcome={draft} />
      ) : null}
      {requested ? (
        <div className="flex flex-col gap-2" data-fees="notice-proposed">
          <OutcomeNotice outcome={requested} doneText="Request filed" />
          {requested.kind === 'ok' ? (
            <Pairs
              items={[
                { label: 'Approval id (publish with this once approved)', value: requested.data.approval.approvalId },
                { label: 'Payload hash (the approver confirms this)', value: requested.data.payloadHash },
              ]}
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>Approved notice request id</span>
          <input
            className="adm-input"
            aria-label="Approved notice request id"
            value={approvalId}
            onChange={(e) => setApprovalId(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="adm-btn"
          data-tone="primary"
          disabled={busy || noticeId === null || approvalId.trim() === ''}
          onClick={() => void run(setPublished, { action: 'notice-publish', noticeId, approvalId: approvalId.trim() })}
        >
          Publish the notice
        </button>
      </div>
      {published?.kind === 'ok' && row ? (
        <p role="status" className="text-sm" data-fees="notice-published">
          Published. Customers see it on the notice board; it takes effect {shownTime(row.effectiveAt)}.
        </p>
      ) : published ? (
        <OutcomeNotice outcome={published} />
      ) : null}
    </div>
  );
}

// ── #7 Convert's state and limits ──

function ConvertLimits({ view }: { view: FeesDeskView['convert'] }) {
  if (view.kind !== 'ok') return <Problem outcome={view} title="Convert's settings could not be read" />;
  const c = view.data;
  const bounds = (b: { minQty: string; maxQty: string } | null) => (b ? `${b.minQty} to ${b.maxQty}` : 'not set');
  return (
    <div className="flex flex-col gap-3" data-fees="convert">
      <p className="text-sm" data-convert="state">
        {c.paused ? 'Convert is paused for maintenance: every quote refuses trade.convert_disabled.' : 'Convert is open.'}
      </p>
      <Pairs
        items={[
          { label: 'Spread on a quote', value: rateText(c.spreadBps) },
          { label: 'A quote holds for', value: c.quoteTtlMs === null ? 'not set' : `${c.quoteTtlMs} ms` },
          { label: 'Size at the desk price, convert', value: bounds(c.deskBounds.convert) },
          { label: 'Size at the desk price, one-click buy', value: bounds(c.deskBounds.oneClickBuy) },
          { label: 'Listed only on markets Convert refuses now', value: c.restricted.length ? c.restricted.join(', ') : 'none' },
        ]}
      />
      <table className={TABLE} data-convert="limits">
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col">Maximum per conversion</th>
          </tr>
        </thead>
        <tbody>
          {c.assets.map((a) => (
            <tr key={a.asset} data-asset={a.asset}>
              <td>{a.asset}</td>
              <td className="if-num">{a.maxPerConvert ? `${a.maxPerConvert.amount} ${a.maxPerConvert.asset}` : 'not set'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── #8 sell quotes and fiat buy fees ──

function SellQuotes({ view }: { view: FeesDeskView['sellQuotes'] }) {
  if (view.kind !== 'ok') return <Problem outcome={view} title="The sell quotes could not be read" />;
  return (
    <div data-fees="quotes" className="flex flex-col gap-2">
      <p className="text-sm text-fg-2">The latest convert quotes where a customer sells, exactly as they were given. Read only.</p>
      {view.data.length === 0 ? (
        <p className="text-sm text-fg-2">No sell quote has been given.</p>
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th scope="col">Quoted at</th>
              <th scope="col">Customer</th>
              <th scope="col">Sells</th>
              <th scope="col">Gets</th>
              <th scope="col">Book price</th>
              <th scope="col">Spread kept</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {view.data.map((q) => (
              <tr key={q.quoteId} data-quote={q.quoteId}>
                <th scope="row" className="if-num">
                  {shownTime(q.createdAt)}
                </th>
                <td className="if-num">{q.userId}</td>
                <td className="if-num">
                  {q.inAmount} {q.inAsset}
                </td>
                <td className="if-num">
                  {q.outAmount} {q.outAsset}
                </td>
                <td className="if-num">{q.avgPrice}</td>
                <td className="if-num">
                  {q.spreadAmount} {q.spreadAsset} ({q.spreadBps} bps)
                </td>
                <td>{q.lifecycle}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FiatBuy({ view }: { view: FeesDeskView['onrampQuotes'] }) {
  if (view.kind !== 'ok') return <Problem outcome={view} title="The fiat buy fees could not be read" />;
  const standIn = view.data.some((q) => q.simulated);
  return (
    <div data-fees="fiat-buy" className="flex flex-col gap-2">
      <p className="text-sm text-fg-2">
        The latest prices customers were given to buy with money, each with its fee, exactly as quoted. Read only.
        {standIn ? ' TEST: these prices come from a stand-in, not a payment partner.' : ''}
      </p>
      {view.data.length === 0 ? (
        <p className="text-sm text-fg-2">No fiat buy price has been given.</p>
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th scope="col">Quoted at</th>
              <th scope="col">Customer</th>
              <th scope="col">Buys</th>
              <th scope="col">Way to pay</th>
              <th scope="col">Pays</th>
              <th scope="col">Fee</th>
              <th scope="col">Rate</th>
            </tr>
          </thead>
          <tbody>
            {view.data.map((q) => (
              <tr key={q.quoteId} data-onramp-quote={q.quoteId}>
                <th scope="row" className="if-num">
                  {shownTime(q.createdAt)}
                </th>
                <td className="if-num">{q.userId}</td>
                <td className="if-num">
                  {q.amount} {q.assetId}
                </td>
                <td>{q.method}</td>
                <td className="if-num">
                  {q.payAmount} {q.payCurrency}
                </td>
                <td className="if-num">
                  {q.fee} {q.payCurrency}
                </td>
                <td className="if-num">{q.rate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function FeesRoom({ initial }: { initial: FeesDeskView }) {
  const [view, setView] = useState(initial);
  const reread = useCallback(async () => {
    const next = await tradeOpsAction<FeesDeskView>('fees', { action: 'read' });
    if (next.kind === 'ok') setView(next.data);
  }, []);
  const now = useMemo(() => new Date(view.asOf), [view.asOf]);
  const fees = view.fees;
  const history = fees.kind === 'ok' ? fees.data : null;
  const base = history?.history.find((r) => r.version === history.version) ?? null;
  const states = history ? versionStates(history.history, now) : new Map();
  const scheduled = history ? history.history.filter((r) => states.get(r.version) === 'scheduled').reverse() : [];

  return (
    <div className="flex flex-col gap-6" data-room="fees">
      <PageSection title="Fee versions by pair group">
        {history ? <Versions history={history} now={now} /> : <Problem outcome={fees} title="The fee versions could not be read" />}
      </PageSection>
      <PageSection title="Propose a new version">
        {base ? (
          <Propose key={base.version} base={base} onWritten={() => void reread()} />
        ) : history ? (
          <p className="text-sm text-fg-2">No version is stored yet, so there is nothing to start a proposal from.</p>
        ) : (
          <p className="text-sm text-fg-2">The fee versions could not be read, so nothing can be proposed.</p>
        )}
      </PageSection>
      <PageSection title="VIP snapshot runs">
        <Snapshots view={view.snapshots} />
      </PageSection>
      <PageSection title="Maker rebates">
        <Rebates inForce={history ? versionInForce(history.history, now) : null} />
      </PageSection>
      <PageSection title="Fee-change notice">
        <Notice key={scheduled.map((r) => r.version).join(',')} scheduled={scheduled} />
      </PageSection>
      <PageSection title="Convert maintenance and limits">
        <ConvertLimits view={view.convert} />
      </PageSection>
      <PageSection title="Sell quotes">
        <SellQuotes view={view.sellQuotes} />
      </PageSection>
      <PageSection title="Fiat buy fees">
        <FiatBuy view={view.onrampQuotes} />
      </PageSection>
    </div>
  );
}
