'use client';

import { useState } from 'react';
import './desk.css';
import { QUANT_QUOTA_RESOURCES, QUANT_SANDBOX_LIMITS, type QuantEscapeCorpus } from '@intafaced/contracts/quant-algo';
import { formatAsOf } from '@/lib/as-of';
import { fetchLimitsDesk, postLimitsAction } from '@/lib/quant-limits-ops/browser';
import { RESOURCE_WORDS, SANDBOX_WORDS, type LimitsDeskReply, type LimitsDeskView } from '@/lib/quant-limits-ops/model';

/**
 * PLAN LIMITS DESK (AL-limits-01, AL-limits-02, J-algo-dev-12), on the quant desk.
 *
 * One plan (a quota profile, a name and not a price) at a time: its quota limits and its sandbox limits as svc-quant
 * stores them, blank reading "not set". A founder sets one limit with a reason, puts an account on the plan with a
 * reason, and runs the escape corpus against the sandbox under the plan's limits. svc-quant decides every write, refuses
 * a blank reason by name and keeps an audit row naming who and why. A write's key is the plan, the limit and the read it
 * was made from, so a retry of the same press never writes twice.
 */
export function QuantLimitsDesk() {
  const [profile, setProfile] = useState('');
  const [view, setView] = useState<LimitsDeskView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<LimitsDeskReply | null>(null);
  const [corpus, setCorpus] = useState<QuantEscapeCorpus | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const field = (key: string) => fields[key] ?? '';
  const setField = (key: string, value: string) => setFields((f) => ({ ...f, [key]: value }));

  const read = async (name = profile.trim()) => {
    if (!name) return;
    const next = await fetchLimitsDesk(name);
    setFailed(!next);
    if (next) setView(next);
  };

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postLimitsAction(body);
    setReply(answer);
    if (answer.ok && answer.corpus) setCorpus(answer.corpus);
    setBusy(false);
    // Whatever the answer, the desk shows what svc-quant holds now.
    await read();
  };

  const name = profile.trim();
  const readAt = view?.asOf ?? 'unread';
  const data = view?.profile.kind === 'ok' && view.profile.data.profile === name ? view.profile.data : null;

  return (
    <section className="dk dk-stack" data-testid="quant-limits-desk" aria-labelledby="h-quant-limits">
      <h2 id="h-quant-limits">Plan quotas and sandbox limits</h2>
      <p className="dk-muted">
        A plan is a name, not a price. Every limit is the owner&rsquo;s value: blank reads &ldquo;not set&rdquo; and refuses what it bounds;
        0 is a deliberate value. Every change needs a reason.
      </p>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="limits-profile">Plan</label>
          <input id="limits-profile" value={profile} maxLength={80} onChange={(ev) => setProfile(ev.target.value)} />
        </div>
        <button type="button" className="adm-btn" disabled={!name} onClick={() => void read()}>
          Read plan
        </button>
        <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      </div>
      <Outcome reply={reply} />
      {failed && <p className="dk-why">The console could not reach its own server for this desk. Nothing is shown rather than a guess.</p>}
      {view?.profile.kind === 'failed' && (
        <div className="adm-callout" data-tone="danger" role="status" data-testid="limits-read-failed" data-code={view.profile.code ?? ''}>
          <strong>Could not read the plan</strong>
          <p>{view.profile.message}</p>
          {view.profile.code && <p className="dk-muted">Code: {view.profile.code}</p>}
        </div>
      )}
      {data && (
        <>
          <h3>Quota limits</h3>
          <table className="adm-table" data-testid="limits-quota">
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col">Limit</th>
                <th scope="col">Set</th>
              </tr>
            </thead>
            <tbody>
              {data.limits.map((row) => (
                <tr key={row.resource} data-resource={row.resource} data-limit={row.limit ?? ''}>
                  <th scope="row">{RESOURCE_WORDS[row.resource]}</th>
                  <td>{row.limit ?? 'not set'}</td>
                  <td>{row.setAt ? formatAsOf(row.setAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="dk-row">
            <div className="adm-field">
              <label htmlFor="quota-resource">Resource</label>
              <select
                id="quota-resource"
                value={field('resource') || 'strategies'}
                onChange={(ev) => setField('resource', ev.target.value)}
              >
                {QUANT_QUOTA_RESOURCES.map((r) => (
                  <option key={r} value={r}>
                    {RESOURCE_WORDS[r]}
                  </option>
                ))}
              </select>
            </div>
            <div className="adm-field">
              <label htmlFor="quota-limit">Limit</label>
              <input
                id="quota-limit"
                inputMode="numeric"
                value={field('limit')}
                maxLength={18}
                onChange={(ev) => setField('limit', ev.target.value)}
              />
            </div>
            <div className="adm-field">
              <label htmlFor="quota-reason">Reason</label>
              <input
                id="quota-reason"
                value={field('quotaReason')}
                maxLength={500}
                onChange={(ev) => setField('quotaReason', ev.target.value)}
              />
            </div>
            <button
              type="button"
              className="adm-btn"
              disabled={busy}
              onClick={() => {
                const resource = field('resource') || 'strategies';
                const limit = field('limit').trim();
                void send({
                  op: 'set',
                  profile: name,
                  resource,
                  limit: limit === '' ? null : limit,
                  reason: field('quotaReason'),
                  idempotencyKey: `quant.quota:${name}:${resource}:${limit || 'blank'}:${readAt}`,
                });
              }}
            >
              Save quota limit
            </button>
          </div>

          <h3>Sandbox limits</h3>
          <table className="adm-table" data-testid="limits-sandbox">
            <thead>
              <tr>
                <th scope="col">Limit</th>
                <th scope="col">Value</th>
                <th scope="col">Set</th>
              </tr>
            </thead>
            <tbody>
              {data.sandbox.map((row) => (
                <tr key={row.limit} data-limit={row.limit} data-value={row.value ?? ''}>
                  <th scope="row">{SANDBOX_WORDS[row.limit]}</th>
                  <td>{row.value ?? 'not set'}</td>
                  <td>{row.setAt ? formatAsOf(row.setAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="dk-row">
            <div className="adm-field">
              <label htmlFor="sandbox-limit">Sandbox limit</label>
              <select
                id="sandbox-limit"
                value={field('sandboxLimit') || 'wall_clock_ms'}
                onChange={(ev) => setField('sandboxLimit', ev.target.value)}
              >
                {QUANT_SANDBOX_LIMITS.map((l) => (
                  <option key={l} value={l}>
                    {SANDBOX_WORDS[l]}
                  </option>
                ))}
              </select>
            </div>
            <div className="adm-field">
              <label htmlFor="sandbox-value">Value</label>
              <input
                id="sandbox-value"
                inputMode="numeric"
                value={field('sandboxValue')}
                maxLength={18}
                onChange={(ev) => setField('sandboxValue', ev.target.value)}
              />
            </div>
            <div className="adm-field">
              <label htmlFor="sandbox-reason">Reason</label>
              <input
                id="sandbox-reason"
                value={field('sandboxReason')}
                maxLength={500}
                onChange={(ev) => setField('sandboxReason', ev.target.value)}
              />
            </div>
            <button
              type="button"
              className="adm-btn"
              disabled={busy}
              onClick={() => {
                const limit = field('sandboxLimit') || 'wall_clock_ms';
                const value = field('sandboxValue').trim();
                void send({
                  op: 'sandbox',
                  profile: name,
                  limit,
                  value: value === '' ? null : value,
                  reason: field('sandboxReason'),
                  idempotencyKey: `quant.sandbox:${name}:${limit}:${value || 'blank'}:${readAt}`,
                });
              }}
            >
              Save sandbox limit
            </button>
          </div>

          <h3>Put an account on this plan</h3>
          <div className="dk-row">
            <div className="adm-field">
              <label htmlFor="assign-account">Account id</label>
              <input id="assign-account" value={field('account')} maxLength={36} onChange={(ev) => setField('account', ev.target.value)} />
            </div>
            <div className="adm-field">
              <label htmlFor="assign-reason">Reason</label>
              <input
                id="assign-reason"
                value={field('assignReason')}
                maxLength={500}
                onChange={(ev) => setField('assignReason', ev.target.value)}
              />
            </div>
            <button
              type="button"
              className="adm-btn"
              disabled={busy}
              onClick={() =>
                void send({
                  op: 'assign',
                  accountId: field('account').trim(),
                  profile: name,
                  reason: field('assignReason'),
                  idempotencyKey: `quant.assign:${field('account').trim()}:${name}:${readAt}`,
                })
              }
            >
              Assign plan
            </button>
          </div>

          <h3>Escape corpus</h3>
          <p className="dk-muted">
            Runs code that tries to leave the sandbox, under this plan&rsquo;s limits. Each case must end in a typed refusal, and an
            ordinary run after them must still run. Nothing is stored.
          </p>
          <button type="button" className="adm-btn" disabled={busy} onClick={() => void send({ op: 'corpus', profile: name })}>
            Run escape corpus
          </button>
          {corpus && corpus.profile === name && <CorpusResult corpus={corpus} />}
        </>
      )}
    </section>
  );
}

function CorpusResult({ corpus }: { corpus: QuantEscapeCorpus }) {
  const typed = corpus.cases.filter((c) => c.code !== null).length;
  return (
    <div className="dk-stack" data-testid="limits-corpus">
      <p data-testid="limits-corpus-summary">
        {typed} of {corpus.cases.length} cases ended in a typed refusal. Ordinary run after them:{' '}
        <span data-testid="limits-corpus-control" data-ok={corpus.control.ok ? 'true' : 'false'}>
          {corpus.control.ok ? 'it ran' : `refused ${corpus.control.code ?? 'without a code'}`}
        </span>
        . Read {formatAsOf(corpus.asOf)}.
      </p>
      <table className="adm-table">
        <thead>
          <tr>
            <th scope="col">Attack</th>
            <th scope="col">Language</th>
            <th scope="col">Refusal</th>
          </tr>
        </thead>
        <tbody>
          {corpus.cases.map((c) => (
            <tr key={c.id} data-case={c.id} data-code={c.code ?? ''}>
              <th scope="row">{c.attack}</th>
              <td>{c.language}</td>
              <td>{c.code ?? `untyped: ${c.message}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Outcome({ reply }: { reply: LimitsDeskReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="limits-desk-outcome" data-code="">
        <strong>Done: {reply.what}</strong>
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="limits-desk-outcome"
      data-code={reply.code ?? ''}
    >
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}
