'use client';

import { useCallback, useState } from 'react';
import type { DistributionRun } from '@intafaced/contracts/campaigns-distribution';
import {
  PAYOUT_BOARD_STATES,
  type DistributionPlan,
  type DistributionPlanAccount,
  type PayoutBoard,
  type PayoutBoardRow,
  type PayoutBoardState,
} from '@intafaced/contracts/campaigns-payout-board';
import { formatWhen } from '@/lib/as-of';
import type { RuleAnswer } from '@/lib/campaigns-ops/builder-browser';
import { payoutsChange, payoutsRead } from '@/lib/campaigns-ops/payouts-browser';
import './desk.css';

/**
 * CAMPAIGN PAYOUT BOARD (J-campaigns-19; CM-payouts-ledger-02, CM-airdrop-campaigns-01).
 *
 * Every reward intent by where it stands on its way to the customer's own connected wallet: owed, pending funding,
 * sending, paid, failed, or another named state, with its business key, the ledger transactions that owed and booked it,
 * and the chain transaction that carried it. With an airdrop's plan: each account at the snapshot, counted, excluded for a
 * negative equity, or named and held out when its equity could not be read. Running the distribution again resumes it;
 * svc-campaigns owes each share once under its key, so nobody is paid twice. Every row is svc-campaigns' own, read on this visit.
 */

type Refusal = Extract<RuleAnswer<never>, { ok: false }>;

export type PayoutsInitial = {
  campaign: string | null;
  board: RuleAnswer<PayoutBoard>;
  plan: string | null;
  planAnswer: RuleAnswer<DistributionPlan> | null;
};

const BOARD_LABEL: Record<PayoutBoardState, string> = {
  owed: 'Owed',
  pending_funding: 'Pending funding',
  sending: 'Sending',
  paid: 'Paid',
  failed: 'Failed',
  other: 'Other',
};

const PLAN_STATE_LABEL: Record<DistributionPlan['state'], string> = {
  not_started: 'Not started: no snapshot taken yet',
  reading: 'Reading: some equities are still being read',
  owed: 'Owed: every counted share is owed under its key',
};

const LOST_ANSWER = 'Looked for on the chain: its send’s answer was lost';

const BOARD_URL = '/more-ops/campaigns/payouts';

function Refused({ refusal, testId }: { refusal: Refusal; testId: string }) {
  return (
    <div className="adm-callout" data-tone="danger" role="alert" data-testid={testId} data-code={refusal.code ?? ''}>
      <strong>{refusal.title}</strong>
      <p>
        {refusal.body}
        {refusal.code ? ` (${refusal.code})` : ''}
      </p>
      {refusal.next && <p className="dk-muted">{refusal.next}</p>}
    </div>
  );
}

function ChainCell({ row }: { row: PayoutBoardRow }) {
  if (row.payment === null) return <>—</>;
  if (row.payment.chainTx === null) return <span data-testid="payout-chain-lost">{LOST_ANSWER}</span>;
  return <code>{row.payment.chainTx}</code>;
}

function BoardGroup({ state, rows }: { state: PayoutBoardState; rows: PayoutBoardRow[] }) {
  const titleId = `payout-group-${state}`;
  return (
    <section aria-labelledby={titleId} data-testid="payout-group" data-board={state}>
      <h3 id={titleId}>{BOARD_LABEL[state]}</h3>
      {rows.length === 0 ? (
        <p data-testid="payout-group-empty">None</p>
      ) : (
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">Reward key</th>
              <th scope="col">Account</th>
              <th scope="col">Amount</th>
              <th scope="col">State</th>
              <th scope="col">Owed (ledger)</th>
              <th scope="col">Paid (ledger)</th>
              <th scope="col">Payment to wallet</th>
              <th scope="col">Chain transaction</th>
              <th scope="col">Redemption log</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.rewardKey}
                data-testid="payout-row"
                data-reward-key={r.rewardKey}
                data-board={r.board}
                data-state={r.state}
                data-reason={r.reason ?? ''}
                data-chain-tx={r.payment?.chainTx ?? ''}
                data-payment-state={r.payment?.state ?? ''}
              >
                <td>
                  <code>{r.rewardKey}</code>
                </td>
                <td>
                  <code>{r.accountId}</code>
                </td>
                <td>
                  {r.amount} {r.asset}
                </td>
                <td>
                  {r.state}
                  {r.reason ? `: ${r.reason}` : ''}
                </td>
                <td>{r.owedTxId ? <code>{r.owedTxId}</code> : '—'}</td>
                <td>{r.paidTxId ? <code>{r.paidTxId}</code> : '—'}</td>
                <td>
                  {r.payment === null ? (
                    'Not begun'
                  ) : (
                    <>
                      {r.payment.state} to <code>{r.payment.toWallet}</code> ({formatWhen(r.payment.sentAt)})
                      {r.payment.reason ? `: ${r.payment.reason}` : ''}
                    </>
                  )}
                </td>
                <td>
                  <ChainCell row={r} />
                </td>
                <td>
                  {r.attempts.length === 0 ? (
                    '—'
                  ) : (
                    <ol data-testid="payout-attempts">
                      {r.attempts.map((a, i) => (
                        <li key={i} data-testid="payout-attempt" data-outcome={a.outcome} data-reason={a.reason ?? ''}>
                          {a.outcome}
                          {a.reason ? `: ${a.reason}` : ''} ({formatWhen(a.at)})
                        </li>
                      ))}
                    </ol>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Board({ answer, campaign }: { answer: RuleAnswer<PayoutBoard>; campaign: string | null }) {
  if (!answer.ok) return <Refused refusal={answer} testId="payout-board-refused" />;
  const b = answer.data;
  return (
    <section aria-labelledby="payout-board-title" data-testid="payout-board" data-campaign={campaign ?? ''}>
      <h2 id="payout-board-title">Intents by state{campaign ? ` for ${campaign}` : ''}</h2>
      <p className="dk-muted">
        Counted over every intent{campaign ? ' of this campaign' : ''}; the newest 200 are listed. Read {formatWhen(b.asOf)}.
      </p>
      <ul aria-label="Intents by state" data-testid="payout-counts">
        {PAYOUT_BOARD_STATES.map((s) => {
          const n = b.counts[s] ?? 0;
          return (
            <li key={s} data-testid="payout-count" data-board={s} data-count={n}>
              {BOARD_LABEL[s]}: {n}
            </li>
          );
        })}
      </ul>
      {PAYOUT_BOARD_STATES.map((s) => (
        <BoardGroup key={s} state={s} rows={b.rows.filter((r) => r.board === s)} />
      ))}
    </section>
  );
}

function PlanAccountRow({ a }: { a: DistributionPlanAccount }) {
  return (
    <tr
      data-testid="plan-account"
      data-account={a.accountId}
      data-standing={a.standing}
      data-equity={a.equity ?? ''}
      data-reason={a.reason ?? ''}
      data-share={a.share ?? ''}
      data-reward-state={a.rewardState ?? ''}
      data-chain-tx={a.chainTx ?? ''}
    >
      <td>
        <code>{a.accountId}</code>
      </td>
      <td>
        {a.standing === 'held_out'
          ? `Held out: ${a.reason ?? 'equity not read'}`
          : a.standing === 'excluded_negative'
            ? 'Excluded: negative equity'
            : a.standing === 'waiting'
              ? 'Waiting: equity not read yet'
              : 'Counted'}
      </td>
      <td>
        {a.equity ?? '—'}
        {a.equityAsOf ? ` (${formatWhen(a.equityAsOf)})` : ''}
      </td>
      <td>{a.share ?? '—'}</td>
      <td>{a.rewardKey ? <code>{a.rewardKey}</code> : '—'}</td>
      <td>{a.rewardState ?? '—'}</td>
      <td>{a.toWallet ? <code>{a.toWallet}</code> : '—'}</td>
      <td>{a.chainTx ? <code>{a.chainTx}</code> : '—'}</td>
    </tr>
  );
}

function PlanView({ campaignId, initial }: { campaignId: string; initial: RuleAnswer<DistributionPlan> }) {
  const [answer, setAnswer] = useState(initial);
  const [run, setRun] = useState<DistributionRun | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  const runIt = useCallback(async () => {
    setBusy(true);
    setRefusal(null);
    const next = await payoutsChange<DistributionRun>({ op: 'run', campaignId, reason });
    if (next.ok) setRun(next.data);
    else setRefusal(next);
    // Read the plan again either way: a run that may have arrived shows in the plan, never repeated on its own.
    setAnswer(await payoutsRead<DistributionPlan>(`?plan=${encodeURIComponent(campaignId)}`));
    setBusy(false);
  }, [campaignId, reason]);

  return (
    <section aria-labelledby="distribution-plan-title">
      <h2 id="distribution-plan-title">
        Airdrop plan for <code>{campaignId}</code>
      </h2>
      {!answer.ok ? (
        <Refused refusal={answer} testId="distribution-plan-refused" />
      ) : (
        <div
          data-testid="distribution-plan"
          data-campaign={answer.data.campaignId}
          data-state={answer.data.state}
          data-pool={answer.data.pool ?? ''}
          data-shares-total={answer.data.sharesTotal ?? ''}
        >
          <dl className="dk-kv">
            <div>
              <dt>Campaign</dt>
              <dd>{answer.data.campaignName}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd data-testid="distribution-plan-state">{PLAN_STATE_LABEL[answer.data.state]}</dd>
            </div>
            <div>
              <dt>Snapshot</dt>
              <dd>{answer.data.snapshotAt ? formatWhen(answer.data.snapshotAt) : 'Not taken'}</dd>
            </div>
            <div>
              <dt>Pool</dt>
              <dd>{answer.data.pool === null ? 'Not set' : `${answer.data.pool} ${answer.data.asset ?? ''}`}</dd>
            </div>
            <div>
              <dt>Total counted equity</dt>
              <dd>{answer.data.totalEquity ?? '—'}</dd>
            </div>
            <div>
              <dt>Shares total</dt>
              <dd data-testid="distribution-plan-shares-total">{answer.data.sharesTotal ?? '—'}</dd>
            </div>
          </dl>
          {answer.data.accounts.length === 0 ? (
            <p>No account at the snapshot yet.</p>
          ) : (
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Standing</th>
                  <th scope="col">Equity at the snapshot</th>
                  <th scope="col">Share</th>
                  <th scope="col">Reward key</th>
                  <th scope="col">Reward state</th>
                  <th scope="col">Wallet</th>
                  <th scope="col">Chain transaction</th>
                </tr>
              </thead>
              <tbody>
                {answer.data.accounts.map((a) => (
                  <PlanAccountRow key={a.accountId} a={a} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <h3>Run the distribution</h3>
      <p className="dk-muted">
        Takes the snapshot when it is due, or resumes a run that stopped part way. Each share is owed once under its key and paid to the
        account’s connected wallet; running it again pays nobody twice.
      </p>
      <label className="adm-field">
        Reason
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
      </label>
      <p>
        <button className="adm-btn" type="button" disabled={busy || reason.trim().length < 3} onClick={runIt}>
          Run the distribution
        </button>
      </p>
      {refusal && <Refused refusal={refusal} testId="distribution-run-refused" />}
      {run && (
        <dl
          className="dk-kv"
          data-testid="distribution-run"
          data-state={run.state}
          data-counted={run.counted}
          data-excluded={run.excludedNegative}
          data-held-out={run.heldOut}
          data-shares-total={run.sharesTotal ?? ''}
        >
          <div>
            <dt>Run</dt>
            <dd>
              {run.state} (snapshot {formatWhen(run.snapshotAt)})
            </dd>
          </div>
          <div>
            <dt>Counted</dt>
            <dd>{run.counted}</dd>
          </div>
          <div>
            <dt>Excluded</dt>
            <dd>{run.excludedNegative}</dd>
          </div>
          <div>
            <dt>Held out</dt>
            <dd>{run.heldOut}</dd>
          </div>
          <div>
            <dt>Shares total</dt>
            <dd>
              {run.sharesTotal ?? '—'} of {run.pool}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

export function CampaignsPayouts({ initial }: { initial: PayoutsInitial }) {
  const [board, setBoard] = useState(initial.board);
  const [planId, setPlanId] = useState(initial.plan ?? '');
  const reload = useCallback(
    async () => setBoard(await payoutsRead<PayoutBoard>(initial.campaign ? `?campaign=${encodeURIComponent(initial.campaign)}` : '')),
    [initial.campaign],
  );
  return (
    <div className="dk" data-testid="campaigns-payouts">
      <div className="adm-pagehead">
        <div>
          <h1>Campaign payout board</h1>
          <p>
            Read from svc-campaigns on this visit. Rewards are paid to the customer’s own connected wallet; the ledger records what was owed
            and booked.{' '}
            <button className="adm-btn" type="button" onClick={reload}>
              Read again
            </button>
          </p>
        </div>
      </div>
      <form method="get" action={BOARD_URL}>
        {initial.campaign && <input type="hidden" name="campaign" value={initial.campaign} />}
        <label className="adm-field">
          Airdrop campaign id
          <input name="plan" value={planId} onChange={(e) => setPlanId(e.target.value)} required maxLength={128} />
        </label>{' '}
        <button className="adm-btn" type="submit" disabled={planId.trim().length === 0}>
          Open plan
        </button>
      </form>
      {initial.plan && initial.planAnswer && <PlanView campaignId={initial.plan} initial={initial.planAnswer} />}
      <Board answer={board} campaign={initial.campaign} />
    </div>
  );
}
