'use client';

import { useCallback, useState } from 'react';
import type { RiskCase, RiskQueue } from '@intafaced/contracts/campaigns-risk';
import { formatWhen } from '@/lib/as-of';
import type { RuleAnswer } from '@/lib/campaigns-ops/builder-browser';
import { riskChange, riskRead } from '@/lib/campaigns-ops/risk-browser';
import './desk.css';

/**
 * CAMPAIGN RISK REVIEW (J-campaigns-18; CM-abuse-fraud-01, -02).
 *
 * The queue of accounts with duplicate-account, device and anti-churn signals, or with a reward withheld because the
 * account is not active (the freeze itself is identity's), and one account's case. Every row is svc-campaigns' own, read
 * on this visit. Withholding calls no ledger; revoking cancels an owed reward once and records, never pulls back, one
 * already paid to the customer's own wallet; an appeal is decided by a person other than the one who revoked.
 */

type Refusal = Extract<RuleAnswer<never>, { ok: false }>;

export type RiskInitial = {
  queue: RuleAnswer<RiskQueue>;
  account: string | null;
  case: RuleAnswer<RiskCase> | null;
};

const KIND_LABEL: Record<string, string> = {
  duplicate_account: 'Duplicate account',
  device: 'Shared device',
  anti_churn: 'Anti-churn',
};

const STANDING_LABEL: Record<string, string> = {
  held: 'Rewards held for review',
  watching: 'Below the threshold: untouched',
  unset: 'Threshold blank: rewards wait, never paid',
};

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

function Queue({ answer, open }: { answer: RuleAnswer<RiskQueue>; open: string | null }) {
  if (!answer.ok) return <Refused refusal={answer} testId="risk-queue-refused" />;
  const q = answer.data;
  return (
    <section aria-labelledby="risk-queue-title">
      <h2 id="risk-queue-title">Review queue</h2>
      <dl className="dk-kv" data-testid="risk-owner-values">
        <div>
          <dt>Signal threshold</dt>
          <dd data-testid="risk-threshold" data-value={q.threshold ?? ''}>
            {q.threshold === null ? 'Not set: a reward of an account with a signal waits and is never paid' : `${q.threshold} signals`}
          </dd>
        </div>
        <div>
          <dt>Appeal window</dt>
          <dd data-testid="risk-appeal-window" data-value={q.appealWindowSeconds ?? ''}>
            {q.appealWindowSeconds === null ? 'Not set: no account can be disqualified' : `${q.appealWindowSeconds} seconds`}
          </dd>
        </div>
      </dl>
      {q.rows.length === 0 ? (
        <p data-testid="risk-queue-empty">No account has a signal or a withheld reward.</p>
      ) : (
        <table className="adm-table" data-testid="risk-queue">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Signals</th>
              <th scope="col">Standing</th>
              <th scope="col">Withheld for</th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {q.rows.map((r) => (
              <tr
                key={r.accountId}
                data-testid="risk-queue-row"
                data-account={r.accountId}
                data-standing={r.standing}
                data-signals={r.signals}
                data-kinds={r.kinds.join(' ')}
                data-causes={r.causes.join(' ')}
                data-flagged={r.flagged ? 'true' : 'false'}
                aria-current={open === r.accountId ? 'true' : undefined}
              >
                <td>
                  <a className="text-link" href={`/more-ops/campaigns/risk?account=${encodeURIComponent(r.accountId)}`}>
                    <code>{r.accountId}</code>
                  </a>
                </td>
                <td>{r.kinds.length === 0 ? 'None' : `${r.signals}: ${r.kinds.map((k) => KIND_LABEL[k] ?? k).join(', ')}`}</td>
                <td>
                  {STANDING_LABEL[r.standing]}
                  {r.flagged ? '; flagged' : ''}
                </td>
                <td>{r.causes.length === 0 ? '—' : r.causes.join(', ')}</td>
                <td>{formatWhen(r.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CaseView({ initial }: { initial: RuleAnswer<RiskCase> }) {
  const [answer, setAnswer] = useState(initial);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<'upheld' | 'overturned'>('upheld');

  const act = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setRefusal(null);
    const next = await riskChange<RiskCase>(body);
    if (next.ok) setAnswer(next);
    else setRefusal(next);
    setBusy(false);
  }, []);

  if (!answer.ok) return <Refused refusal={answer} testId="risk-case-refused" />;
  const c = answer.data;
  return (
    <section aria-labelledby="risk-case-title" data-testid="risk-case" data-account={c.accountId} data-standing={c.standing}>
      <h2 id="risk-case-title">
        Case for <code>{c.accountId}</code>
      </h2>
      <p data-testid="risk-case-standing">{STANDING_LABEL[c.standing]}</p>
      <p data-testid="risk-case-flag" data-flagged={c.flagged ? 'true' : 'false'}>
        {c.flagged ? 'Flagged: this account’s rewards were revoked.' : 'Not flagged.'}
      </p>
      {c.causes.length > 0 && (
        <p data-testid="risk-case-causes" data-causes={c.causes.join(' ')}>
          Rewards withheld because the account is not active: {c.causes.join(', ')}. The freeze itself is identity’s.
        </p>
      )}

      <h3>Signals</h3>
      {c.signals.length === 0 ? (
        <p>No signal.</p>
      ) : (
        <ul data-testid="risk-signals">
          {c.signals.map((s) => (
            <li
              key={`${s.kind}:${s.subject}`}
              data-testid="risk-signal"
              data-kind={s.kind}
              data-subject={s.subject}
              data-shared={s.sharedWith.join(' ')}
            >
              {KIND_LABEL[s.kind] ?? s.kind}: <code>{s.subject}</code>
              {s.sharedWith.length > 0 ? `, also on ${s.sharedWith.join(', ')}` : ''} ({formatWhen(s.at)})
            </li>
          ))}
        </ul>
      )}

      <h3>Rewards</h3>
      {c.rewards.length === 0 ? (
        <p>No reward.</p>
      ) : (
        <table className="adm-table" data-testid="risk-rewards">
          <thead>
            <tr>
              <th scope="col">Reward</th>
              <th scope="col">Amount</th>
              <th scope="col">State</th>
              <th scope="col">Reason</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {c.rewards.map((r) => (
              <tr
                key={r.rewardKey}
                data-testid="risk-reward"
                data-reward-key={r.rewardKey}
                data-state={r.state}
                data-reason={r.reason ?? ''}
              >
                <td>
                  <code>{r.rewardKey}</code>
                </td>
                <td>
                  {r.amount} {r.asset}
                </td>
                <td>{r.state}</td>
                <td>{r.reason ?? '—'}</td>
                <td>
                  {r.state === 'review' && r.reason === 'risk.review' ? (
                    <button
                      className="adm-btn"
                      type="button"
                      disabled={busy || reason.trim().length < 3}
                      onClick={() => act({ op: 'withhold', rewardKey: r.rewardKey, reason })}
                    >
                      Withhold
                    </button>
                  ) : r.state === 'paid' ? (
                    <span>Paid to the customer’s own wallet: never pulled back</span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Decide</h3>
      <label className="adm-field">
        Reason
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
      </label>
      <p>
        <button
          className="adm-btn"
          type="button"
          disabled={busy || reason.trim().length < 3}
          onClick={() => act({ op: 'revoke', accountId: c.accountId, reason })}
        >
          Revoke this account’s rewards
        </button>
      </p>
      <p className="dk-muted">
        Revoking cancels each owed reward not yet sent to the wallet, once, and records what was already paid; the customer may appeal
        inside the window.
      </p>

      <dl className="dk-kv" data-testid="risk-decision">
        <div>
          <dt>Revoked by</dt>
          <dd data-testid="risk-revoked-by" data-actor={c.revokedBy ?? ''}>
            {c.revokedBy ?? 'Not revoked'}
            {c.revokedAt ? ` (${formatWhen(c.revokedAt)})` : ''}
          </dd>
        </div>
        <div>
          <dt>Appeal window ends</dt>
          <dd data-testid="risk-appeal-until" data-at={c.appealUntil ?? ''}>
            {c.appealUntil ? formatWhen(c.appealUntil) : '—'}
          </dd>
        </div>
        <div>
          <dt>Paid and not recoverable</dt>
          <dd data-testid="risk-paid-unrecoverable" data-amounts={c.paidUnrecoverable.map((p) => `${p.amount} ${p.asset}`).join(', ')}>
            {c.paidUnrecoverable.length === 0 ? 'None' : c.paidUnrecoverable.map((p) => `${p.amount} ${p.asset}`).join(', ')}
          </dd>
        </div>
      </dl>

      <h3>Appeal</h3>
      {c.appeal === null ? (
        <p data-testid="risk-appeal-none">No appeal filed.</p>
      ) : (
        <div data-testid="risk-appeal" data-outcome={c.appeal.outcome ?? ''} data-decided-by={c.appeal.decidedBy ?? ''}>
          <p>
            Filed {formatWhen(c.appeal.filedAt)}: “{c.appeal.text}”
          </p>
          {c.appeal.outcome ? (
            <p data-testid="risk-appeal-decided">
              {c.appeal.outcome === 'upheld' ? 'Upheld' : 'Overturned'} by {c.appeal.decidedBy} ({formatWhen(c.appeal.decidedAt!)}):{' '}
              {c.appeal.decisionReason}
            </p>
          ) : (
            <p>
              <label>
                Outcome
                <select value={outcome} onChange={(e) => setOutcome(e.target.value as 'upheld' | 'overturned')}>
                  <option value="upheld">Upheld</option>
                  <option value="overturned">Overturned</option>
                </select>
              </label>{' '}
              <button
                className="adm-btn"
                type="button"
                disabled={busy || reason.trim().length < 3}
                onClick={() => act({ op: 'decide', accountId: c.accountId, outcome, reason })}
              >
                Decide the appeal
              </button>
            </p>
          )}
        </div>
      )}
      {refusal && <Refused refusal={refusal} testId="risk-action-refused" />}

      <h3>Record</h3>
      <ol data-testid="risk-actions">
        {c.actions.map((a, i) => (
          <li
            key={i}
            data-testid="risk-action"
            data-action={a.action}
            data-actor={a.actor}
            data-reward-key={a.rewardKey ?? ''}
            data-tx={a.ledgerTxId ?? ''}
          >
            {formatWhen(a.at)}: {a.action} by {a.actor}
            {a.rewardKey ? ` on ${a.rewardKey}` : ''}
            {a.amount ? `, ${a.amount}` : ''}
            {a.reason ? `: ${a.reason}` : ''}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function CampaignsRisk({ initial }: { initial: RiskInitial }) {
  const [queue, setQueue] = useState(initial.queue);
  const reload = useCallback(async () => setQueue(await riskRead<RiskQueue>('')), []);
  return (
    <div className="dk" data-testid="campaigns-risk">
      <div className="adm-pagehead">
        <div>
          <h1>Campaign risk review</h1>
          <p>
            Read from svc-campaigns on this visit. Each account is judged on its own signals only.{' '}
            <button className="adm-btn" type="button" onClick={reload}>
              Read again
            </button>
          </p>
        </div>
      </div>
      <Queue answer={queue} open={initial.account} />
      {initial.case && <CaseView initial={initial.case} />}
    </div>
  );
}
