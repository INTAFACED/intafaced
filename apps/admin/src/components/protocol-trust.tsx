'use client';

import { useCallback, useEffect, useState } from 'react';
import { ADDRESS_LABEL_KINDS, type ProtocolComplianceReport } from '@intafaced/contracts/protocol-address-risk';
import type { ProtocolAuditProducts } from '@intafaced/contracts/protocol-blockers';
import type { TokensList } from '@intafaced/contracts/protocol-tokens';
import { formatAsOf } from '@/lib/as-of';
import { TRUST_TABS, TRUST_TAB_WAITS, pendingReview, publishedWords, reportWords, type TrustTab } from '@/lib/protocol-trust/model';
import './desk.css';

type Part<T> = { ok: true; data: T } | { ok: false; message: string };
interface TrustRead {
  asOf: string;
  reports: Part<{ asOf: string; chainId: number; reports: ProtocolComplianceReport[] }>;
  tokens: Part<TokensList>;
  audit: Part<ProtocolAuditProducts>;
}

const tabId = (tab: TrustTab) => `trust-tab-${tab.toLowerCase().replace(/[^a-z]+/g, '-')}`;

async function post(body: Record<string, string>): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch('/api/protocol-ops/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { ok: boolean; message?: string };
  } catch {
    return { ok: false, message: 'The answer was lost. Reload to see what is stored; nothing is repeated automatically.' };
  }
}

function Failed({ message }: { message: string }) {
  return (
    <div className="adm-callout" data-tone="warn" role="status">
      <strong>Could not load this</strong>
      <p>{message} Nothing is shown rather than a guess.</p>
    </div>
  );
}

/** One report's row: who filed it (compliance only), what they wrote, refused duplicates, and its label reviews. */
function ReportRow({
  report,
  onAsk,
  onApprove,
}: {
  report: ProtocolComplianceReport;
  onAsk: (report: ProtocolComplianceReport) => void;
  onApprove: (reviewId: string) => void;
}) {
  const pending = pendingReview(report);
  const duplicate = reportWords(report);
  return (
    <tr>
      <td>
        <code>{report.address}</code>
      </td>
      <td>{report.kind}</td>
      <td>{report.note ?? 'No note'}</td>
      <td>
        <code data-testid="reporter">{report.reporterId}</code>
        <div className="dk-muted">Hidden from the public: the public page shows a count only.</div>
      </td>
      <td>{formatAsOf(report.createdAt)}</td>
      <td>
        {duplicate && <div>{duplicate}</div>}
        {publishedWords(report).map((w) => (
          <div key={w}>{w}</div>
        ))}
        {pending && (
          <div>
            Pending a second reviewer: {pending.kind}, asked by <code>{pending.requesterId}</code>
          </div>
        )}
        {!duplicate && !pending && publishedWords(report).length === 0 && <span className="dk-muted">Open</span>}
      </td>
      <td>
        {pending ? (
          <button type="button" className="adm-btn" onClick={() => onApprove(pending.id)}>
            Approve label
          </button>
        ) : report.status === 'open' ? (
          <button type="button" className="adm-btn" onClick={() => onAsk(report)}>
            Publish label
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function ScamReports({ read, reload }: { read: TrustRead['reports']; reload: () => void }) {
  const [asking, setAsking] = useState<ProtocolComplianceReport | null>(null);
  const [kind, setKind] = useState<string>('phishing');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!read.ok) return <Failed message={read.message} />;
  const send = async (body: Record<string, string>) => {
    if (busy) return;
    setBusy(true);
    const result = await post(body);
    setBusy(false);
    if (result.ok) {
      setProblem(null);
      setAsking(null);
      setReason('');
      reload();
    } else setProblem(result.message ?? 'svc-protocol refused this.');
  };
  return (
    <div className="dk-stack">
      <p className="dk-muted">
        Reports people filed about an address on chain {read.data.chainId}, read {formatAsOf(read.data.asOf)}. A label is public only after
        a second person approves it.
      </p>
      {read.data.reports.length === 0 ? (
        <p role="status">No report has been filed on this network.</p>
      ) : (
        <table className="adm-table" aria-label="Reports">
          <thead>
            <tr>
              <th>Address</th>
              <th>Kind</th>
              <th>What they wrote</th>
              <th>Reporter</th>
              <th>Filed</th>
              <th>State</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {read.data.reports.map((r) => (
              <ReportRow
                key={r.id}
                report={r}
                onAsk={(report) => {
                  setAsking(report);
                  setProblem(null);
                }}
                onApprove={(reviewId) => void send({ op: 'approve', reviewId })}
              />
            ))}
          </tbody>
        </table>
      )}
      {asking && (
        <form
          className="dk-stack"
          aria-label="Publish a label"
          onSubmit={(e) => {
            e.preventDefault();
            void send({ op: 'ask', reportId: asking.id, kind, reason });
          }}
        >
          <p>
            Label for <code>{asking.address}</code>. You ask; a second reviewer approves.
          </p>
          <div className="adm-field">
            <label htmlFor="trust-label-kind">Label</label>
            <select id="trust-label-kind" className="adm-input" value={kind} onChange={(e) => setKind(e.target.value)}>
              {ADDRESS_LABEL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor="trust-label-reason">Reason (shown with it)</label>
            <textarea
              id="trust-label-reason"
              className="adm-textarea"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <button type="submit" className="adm-btn" disabled={busy || reason.trim().length === 0}>
            Ask a second reviewer
          </button>
        </form>
      )}
      {problem && (
        <p role="alert" className="dk-muted">
          {problem}
        </p>
      )}
    </div>
  );
}

function TrustCriteria({ read }: { read: TrustRead['tokens'] }) {
  return (
    <div className="dk-stack">
      <div className="adm-callout" data-tone="warn" role="status">
        <strong>Trust criteria not set · owner.decision</strong>
        <p>The owner has not set the criteria a tier is judged by, so every token reads unknown. Nothing is guessed.</p>
      </div>
      {!read.ok ? (
        <Failed message={read.message} />
      ) : read.data.tokens.length === 0 ? (
        <p role="status">No token is traded in the factory’s pools on this network.</p>
      ) : (
        <table className="adm-table" aria-label="Tokens">
          <thead>
            <tr>
              <th>Token</th>
              <th>Address</th>
              <th>Trust</th>
            </tr>
          </thead>
          <tbody>
            {read.data.tokens.map((row) => (
              <tr key={row.token.address}>
                <td>
                  {row.token.name} ({row.token.symbol})
                </td>
                <td>
                  <code>{row.token.address}</code>
                </td>
                <td data-testid="trust">unknown</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AuditRoom({ read }: { read: TrustRead['audit'] }) {
  return (
    <div className="dk-stack">
      {!read.ok ? (
        <Failed message={read.message} />
      ) : (
        <table className="adm-table" aria-label="Products">
          <thead>
            <tr>
              <th>Product</th>
              <th>External audit</th>
            </tr>
          </thead>
          <tbody>
            {read.data.products.map((p) => (
              <tr key={p.product}>
                <td>{p.product}</td>
                <td data-testid="external-audit">
                  {p.external ? (
                    <>
                      External audit: {p.external.id}, signed by {p.external.signedBy} on {p.external.signedAt}
                      {p.external.scope ? `, scope: ${p.external.scope}` : ''}
                      {p.external.reportUrl && /^https?:\/\//.test(p.external.reportUrl) ? (
                        <>
                          {' '}
                          <a href={p.external.reportUrl} rel="noreferrer noopener" target="_blank">
                            report
                          </a>
                        </>
                      ) : null}
                    </>
                  ) : (
                    'External audit: not done'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(['Disclosure policy', 'Terms'] as const).map((what) => (
        <section key={what} aria-label={what} className="adm-callout" data-tone="warn" data-code="owner.decision">
          <p role="status">
            <strong>{what} not set · owner.decision</strong>
          </p>
          <p>No {what.toLowerCase()} text is recorded, so none is shown, and nothing says it is in force.</p>
        </section>
      ))}
    </div>
  );
}

/**
 * The Protocol trust desk (J-dex-protocol-30): scam reports and their two-reviewer labels, the trust criteria, and the
 * audit and disclosure room, read from svc-protocol as the signed-in founder. The other tabs name what they wait for.
 */
export function ProtocolTrust() {
  const [tab, setTab] = useState<TrustTab>('Scam reports');
  const [read, setRead] = useState<TrustRead | null>(null);
  const [lost, setLost] = useState(false);
  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/protocol-ops/trust', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setRead((await res.json()) as TrustRead);
      setLost(false);
    } catch {
      setLost(true);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const wait = TRUST_TAB_WAITS[tab];
  return (
    <div className="dk-stack" data-testid="protocol-trust">
      <div role="tablist" aria-label="Trust and safety" className="dk-row">
        {TRUST_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={tabId(t)}
            aria-selected={t === tab}
            aria-controls={`${tabId(t)}-panel`}
            className="adm-btn"
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${tabId(tab)}-panel`} aria-labelledby={tabId(tab)} className="dk-stack">
        {lost && (
          <p role="alert" className="dk-muted">
            The console could not reach its own server for this desk. {read ? `This is the read from ${formatAsOf(read.asOf)}.` : ''}
          </p>
        )}
        {wait ? (
          <div className="adm-callout" data-tone="warn" role="status">
            <strong>{tab}</strong>
            <p>{wait}</p>
          </div>
        ) : !read ? (
          <p role="status">{lost ? 'Nothing is shown rather than a guess.' : 'Reading…'}</p>
        ) : tab === 'Scam reports' ? (
          <ScamReports read={read.reports} reload={() => void reload()} />
        ) : tab === 'Trust criteria' ? (
          <TrustCriteria read={read.tokens} />
        ) : (
          <AuditRoom read={read.audit} />
        )}
      </div>
    </div>
  );
}
