'use client';

import { useState } from 'react';
import { customerReference, OUTCOME_WORD, OUTCOMES, type Outcome } from '@/lib/agents-log/model';

/**
 * The agent action log desk (AG-audit-01, AG-audit-02): one customer's agent actions as svc-agents recorded them. Every
 * search, export and transcript open needs a reason from the owner's list and writes one audit row there, whose count
 * the service re-reads and this desk shows. The table never holds prompt or answer text; a transcript is opened one
 * action at a time, while the owner's retention keeps it.
 */

interface ActionRow {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: string;
  readonly tool: string;
  readonly outcome: Outcome;
  readonly refusalCode: string | null;
  readonly inputDigest: string | null;
}

interface Page {
  readonly items: readonly ActionRow[];
  readonly tools: readonly string[];
  readonly more: boolean;
  readonly limit: number;
  readonly auditRows: number;
}

interface Transcript {
  readonly actionId: string;
  readonly text: string;
  readonly digest: string;
  readonly inputDigest: string | null;
  readonly expiresAt: string;
  readonly auditRows: number;
}

const WORDS: Record<string, string> = {
  'agents.log_read_reason_required': 'A reason is required to read this customer’s agent log.',
  'agents.log_read_reason_unset': 'The owner has not published the reasons for reading the agent log, so it cannot be read yet.',
  'agents.log_read_reason_unknown': 'That reason is not on the owner’s list.',
  'agents.ops_actions_limit_unset': 'The owner has not set how many rows one read shows, so the log cannot be read yet.',
  'agents.transcript_retention_unset': 'The owner has not set how long transcripts are kept, so no transcript is read.',
  'agents.transcript_not_kept': 'This action’s text was not kept: retention was off when it ran, or it has expired.',
  'agents.action_not_found': 'svc-agents has no such action.',
  'admin.agents_log_customer_not_found': 'No account has this handle.',
  'admin.agents_log_customer_invalid': 'Type the customer’s whole handle or their account id.',
};

const say = (code: string): string => `${WORDS[code] ?? 'svc-agents refused this read.'} (${code})`;
const audit = (n: number): string => `${n} audit ${n === 1 ? 'row' : 'rows'} written for this read`;
const requestId = (kind: string): string => `agents-log:${kind}:${crypto.randomUUID()}`;

export function AgentsLogDesk({ csrf, reasons, reasonsRefusal }: { csrf: string; reasons: readonly string[]; reasonsRefusal: string | null }) {
  const [customer, setCustomer] = useState('');
  const [reason, setReason] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [tool, setTool] = useState('');
  const [page, setPage] = useState<Page | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [transcriptProblem, setTranscriptProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(body: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; code: string }> {
    const response = await fetch('/api/agents-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': csrf },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!response) return { ok: false, code: 'admin.upstream_unavailable' };
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, code: (data as { code?: string } | null)?.code ?? `http.${response.status}` };
    return { ok: true, data };
  }

  async function read(who: string, filter: { outcome: Outcome | ''; tool: string }) {
    setBusy(true);
    setTranscript(null);
    setTranscriptProblem(null);
    const answer = await post({ action: 'actions', customer: who, reason, outcome: filter.outcome, tool: filter.tool, requestId: requestId('actions') });
    setBusy(false);
    if (!answer.ok) {
      setPage(null);
      setProblem(say(answer.code));
      return;
    }
    setProblem(null);
    setSearched(who);
    setPage(answer.data as Page);
  }

  async function exportRows() {
    if (!searched) return;
    const answer = await post({ action: 'export', customer: searched, reason, outcome, tool, requestId: requestId('export') });
    if (!answer.ok) {
      setProblem(say(answer.code));
      return;
    }
    const { csv } = answer.data as { csv: string };
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `agent-actions-${searched}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function openTranscript(actionId: string) {
    setTranscript(null);
    const answer = await post({ action: 'transcript', actionId, reason, requestId: requestId('transcript') });
    if (!answer.ok) {
      setTranscriptProblem(say(answer.code));
      return;
    }
    setTranscriptProblem(null);
    setTranscript(answer.data as Transcript);
  }

  return (
    <div className="dk-stack" data-testid="agents-log">
      <h1>Agent action log</h1>
      <p className="dk-muted">
        One customer’s agent actions as svc-agents recorded them: what ran, what was refused and why. Every read needs a reason
        from the owner’s list and is written to the audit log. Prompt text is never listed.
      </p>
      {reasonsRefusal && (
        <p className="adm-callout" data-tone="warn" role="status">
          {say(reasonsRefusal)}
        </p>
      )}
      <form
        className="adm-callout"
        data-tone="info"
        aria-label="Search the agent log"
        onSubmit={(event) => {
          event.preventDefault();
          const ref = customerReference(customer);
          if ('error' in ref) {
            setProblem(ref.error);
            return;
          }
          setOutcome('');
          setTool('');
          void read(customer.trim(), { outcome: '', tool: '' });
        }}
      >
        <label>
          Customer reference (handle or account id)
          <input value={customer} onChange={(event) => setCustomer(event.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <label>
          Reason
          <select value={reason} onChange={(event) => setReason(event.target.value)}>
            <option value="">Pick a reason</option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="adm-btn" data-tone="primary" disabled={busy}>
          Search
        </button>
        {problem && (
          <p role="alert" className="dk-muted">
            {problem}
          </p>
        )}
      </form>

      {page && searched && (
        <>
          <p data-testid="log-read-audit">{audit(page.auditRows)}</p>
          <div className="dk-row">
            <label>
              Outcome
              <select
                value={outcome}
                onChange={(event) => {
                  const next = event.target.value as Outcome | '';
                  setOutcome(next);
                  void read(searched, { outcome: next, tool });
                }}
              >
                <option value="">All outcomes</option>
                {OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {OUTCOME_WORD[o]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tool
              <select
                value={tool}
                onChange={(event) => {
                  setTool(event.target.value);
                  void read(searched, { outcome, tool: event.target.value });
                }}
              >
                <option value="">All tools</option>
                {page.tools.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="adm-btn" onClick={() => void exportRows()}>
              Export CSV
            </button>
          </div>
          <section aria-label="Agent actions for this customer">
            {page.items.length === 0 ? (
              <p className="dk-muted">No agent action matches this search.</p>
            ) : (
              <div className="dk-table-wrap">
                <table className="dk-table">
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">Tool</th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Refusal code</th>
                      <th scope="col">Input digest</th>
                      <th scope="col">Transcript</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((row) => (
                      <tr key={row.id} data-action-id={row.id}>
                        <td>{row.occurredAt}</td>
                        <td data-testid="action-tool">{row.tool}</td>
                        <td data-testid="action-outcome">{OUTCOME_WORD[row.outcome]}</td>
                        <td data-testid="action-refusal">{row.refusalCode ?? '—'}</td>
                        <td data-testid="action-digest">{row.inputDigest ?? '—'}</td>
                        <td>
                          {row.kind === 'completion' && row.outcome === 'executed' ? (
                            <button type="button" className="adm-btn" onClick={() => void openTranscript(row.id)}>
                              Open transcript
                            </button>
                          ) : (
                            <span className="dk-muted">No prompt text for this action</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {page.more && <p className="dk-muted">More actions match than one read shows ({page.limit}). Narrow the filter.</p>}
          </section>
        </>
      )}

      {transcriptProblem && (
        <p role="alert" className="adm-callout" data-tone="warn">
          {transcriptProblem}
        </p>
      )}
      {transcript && (
        <section aria-label="Transcript" className="adm-callout" data-tone="info">
          <p data-testid="transcript-read-audit">{audit(transcript.auditRows)}</p>
          <p>
            Digest of this text: <code data-testid="transcript-digest">{transcript.digest}</code>
          </p>
          <p>
            {transcript.digest === transcript.inputDigest
              ? 'It matches the action row’s input digest.'
              : 'It does not match the action row’s input digest.'}{' '}
            Kept until {transcript.expiresAt}.
          </p>
          <pre data-testid="transcript-text">{transcript.text}</pre>
        </section>
      )}
    </div>
  );
}
