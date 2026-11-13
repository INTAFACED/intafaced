'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ADDRESS_LABEL_KINDS,
  HUMAN_TOKEN_TIERS,
  type ProtocolComplianceReport,
  type ProtocolOnboardingChecklist,
  type ProtocolTokenTiersOutput,
} from '@intafaced/contracts/protocol-address-risk';
import type { ProtocolAuditProducts } from '@intafaced/contracts/protocol-blockers';
import type { TokensList } from '@intafaced/contracts/protocol-tokens';
import { formatAsOf } from '@/lib/as-of';
import { founderMutationHeaders } from '@/lib/founder-browser';
import {
  TRUST_TABS,
  TRUST_TAB_WAITS,
  missingItemWords,
  pendingReview,
  publishedWords,
  reportWords,
  tierDay,
  tierWords,
  type TrustTab,
} from '@/lib/protocol-trust/model';
import './desk.css';

type Part<T> = { ok: true; data: T } | { ok: false; message: string };
interface TrustRead {
  asOf: string;
  reports: Part<{ asOf: string; chainId: number; reports: ProtocolComplianceReport[] }>;
  tokens: Part<TokensList>;
  audit: Part<ProtocolAuditProducts>;
  tiers: Part<ProtocolTokenTiersOutput>;
  onboarding: Part<{ asOf: string; chainId: number; checklists: ProtocolOnboardingChecklist[] }>;
}

const tabId = (tab: TrustTab) => `trust-tab-${tab.toLowerCase().replace(/[^a-z]+/g, '-')}`;

async function post(body: Record<string, string | null>): Promise<{ ok: boolean; message?: string }> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return { ok: false, message: `${(error as Error).message} Nothing was sent.` };
  }
  try {
    const res = await fetch('/api/protocol-ops/trust', { method: 'POST', headers, body: JSON.stringify(body) });
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
          aria-label="Second review request"
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

/** Sends one desk write; on success clears the problem and reloads, otherwise keeps the refusal's words. */
function useSend(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const send = async (body: Record<string, string | null>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    const result = await post(body);
    setBusy(false);
    if (result.ok) {
      setProblem(null);
      reload();
      return true;
    }
    setProblem(result.message ?? 'svc-protocol refused this.');
    return false;
  };
  return { busy, problem, setProblem, send };
}

function Problem({ problem }: { problem: string | null }) {
  return problem ? (
    <p role="alert" className="dk-muted">
      {problem}
    </p>
  ) : null;
}

/**
 * Token tiers (D-launch-listing-02, J-dex-protocol-30 #4): a human tier is asked by one person and approved by another,
 * then shown with its day and reason. Removing it returns the token to its prior tier, and every step is an audit row.
 */
function TokenTiers({ tokens, read, reload }: { tokens: TrustRead['tokens']; read: TrustRead['tiers']; reload: () => void }) {
  const { busy, problem, setProblem, send } = useSend(reload);
  const [setting, setSetting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [tier, setTier] = useState<string>('verified');
  const [reason, setReason] = useState('');
  if (!tokens.ok) return <Failed message={tokens.message} />;
  if (!read.ok) return <Failed message={read.message} />;
  const byToken = new Map(read.data.tiers.map((t) => [t.token.toLowerCase(), t]));
  const nameOf = new Map(tokens.data.tokens.map((r) => [r.token.address.toLowerCase(), `${r.token.name} (${r.token.symbol})`]));
  const subject = setting ?? removing;
  return (
    <div className="dk-stack">
      <p className="dk-muted">
        A human tier is a recorded review, not an audit and not an endorsement. One person asks; a different person approves, and only then
        is it shown. Read {formatAsOf(read.data.asOf)}.
      </p>
      {tokens.data.tokens.length === 0 ? (
        <p role="status">No token is traded in the factory’s pools on this network.</p>
      ) : (
        <table className="adm-table" aria-label="Tokens">
          <thead>
            <tr>
              <th>Token</th>
              <th>Address</th>
              <th>Tier</th>
              <th>Why</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {tokens.data.tokens.map((row) => {
              const t = byToken.get(row.token.address.toLowerCase()) ?? null;
              return (
                <tr key={row.token.address}>
                  <td>
                    {row.token.name} ({row.token.symbol})
                  </td>
                  <td>
                    <code>{row.token.address}</code>
                  </td>
                  <td data-testid="tier">{tierWords(t)}</td>
                  <td data-testid="tier-reason">
                    {t?.tier ? t.reason : <span className="dk-muted">No human tier</span>}
                    {t?.pending && (
                      <div className="dk-muted">
                        Pending: {t.pending.reason}, asked by <code>{t.pending.requesterId}</code>
                      </div>
                    )}
                  </td>
                  <td className="dk-row">
                    {t?.pending ? (
                      <button
                        type="button"
                        className="adm-btn"
                        disabled={busy}
                        onClick={() => void send({ op: 'tier-approve', requestId: t.pending!.id })}
                      >
                        Approve tier
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="adm-btn"
                        onClick={() => {
                          setSetting(row.token.address);
                          setRemoving(null);
                          setProblem(null);
                        }}
                      >
                        Set tier
                      </button>
                    )}
                    {t?.tier && (
                      <button
                        type="button"
                        className="adm-btn"
                        onClick={() => {
                          setRemoving(row.token.address);
                          setSetting(null);
                          setProblem(null);
                        }}
                      >
                        Remove tier
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {subject && (
        <form
          className="dk-stack"
          aria-label={setting ? 'Second approval request' : 'Removal request'}
          onSubmit={(e) => {
            e.preventDefault();
            void send(setting ? { op: 'tier-ask', token: setting, tier, reason } : { op: 'tier-remove', token: removing, reason }).then(
              (ok) => {
                if (ok) {
                  setSetting(null);
                  setRemoving(null);
                  setReason('');
                }
              },
            );
          }}
        >
          <p>
            {setting ? 'Tier for ' : 'Remove the human tier of '}
            <code>{subject}</code>.{' '}
            {setting ? 'You ask; a second approver approves.' : 'It returns to the tier it had before, with an audit row.'}
          </p>
          {setting && (
            <div className="adm-field">
              <label htmlFor="trust-tier">Tier</label>
              <select id="trust-tier" className="adm-input" value={tier} onChange={(e) => setTier(e.target.value)}>
                {HUMAN_TOKEN_TIERS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="adm-field">
            <label htmlFor="trust-tier-reason">Reason (what was checked)</label>
            <textarea
              id="trust-tier-reason"
              className="adm-textarea"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <button type="submit" className="adm-btn" disabled={busy || reason.trim().length === 0}>
            {setting ? 'Ask a second approver' : 'Remove the tier'}
          </button>
        </form>
      )}
      <Problem problem={problem} />
      {read.data.audit.length === 0 ? (
        <p className="dk-muted">No tier has been asked for, approved or removed on this network.</p>
      ) : (
        <table className="adm-table" aria-label="Audit">
          <thead>
            <tr>
              <th>When</th>
              <th>Token</th>
              <th>What</th>
              <th>Why</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {read.data.audit.map((a) => (
              <tr key={a.id}>
                <td>{formatAsOf(a.at)}</td>
                <td>{nameOf.get(a.token.toLowerCase()) ?? <code>{a.token}</code>}</td>
                <td>
                  {a.action === 'asked'
                    ? `Asked for ${a.tier}`
                    : a.action === 'approved'
                      ? `Approved ${a.tier} on ${tierDay(a.at)}`
                      : `Removed ${a.tier}, back to ${a.returnedTo ?? 'unknown'}`}
                </td>
                <td>{a.reason}</td>
                <td>
                  <code>{a.actorId}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const CHECKLIST_FIELDS = [
  ['pool', 'Pool name'],
  ['legalEntity', 'Legal entity'],
  ['tokenContract', 'Token contract'],
  ['checkerAddress', 'Checker address'],
  ['wrapperAddress', 'Wrapper address'],
  ['routingRegistration', 'Routing registration'],
] as const;
type ChecklistField = (typeof CHECKLIST_FIELDS)[number][0];

/**
 * Permissioned pool onboarding (D-liquidity-07, J-dex-protocol-30 #9): a checklist with any item blank cannot be approved,
 * and the person who opened it cannot approve it. svc-protocol refuses both; the button only says so first.
 */
function PermissionedPools({ read, reload }: { read: TrustRead['onboarding']; reload: () => void }) {
  const { busy, problem, send } = useSend(reload);
  const blank = Object.fromEntries(CHECKLIST_FIELDS.map(([k]) => [k, ''])) as Record<ChecklistField, string>;
  const [fields, setFields] = useState(blank);
  const [reason, setReason] = useState('');
  if (!read.ok) return <Failed message={read.message} />;
  return (
    <div className="dk-stack">
      <form
        className="dk-stack"
        aria-label="New onboarding checklist"
        onSubmit={(e) => {
          e.preventDefault();
          const body: Record<string, string | null> = { op: 'onboarding-open' };
          for (const [k] of CHECKLIST_FIELDS) body[k] = fields[k].trim() === '' ? null : fields[k].trim();
          void send(body).then((ok) => ok && setFields(blank));
        }}
      >
        <p className="dk-muted">
          An issuer’s permissioned pool is onboarded with this checklist. A blank item stays blank and the checklist cannot be approved.
        </p>
        {CHECKLIST_FIELDS.map(([k, label]) => (
          <div className="adm-field" key={k}>
            <label htmlFor={`trust-onboarding-${k}`}>{label}</label>
            <input
              id={`trust-onboarding-${k}`}
              className="adm-input"
              value={fields[k]}
              onChange={(e) => setFields({ ...fields, [k]: e.target.value })}
            />
          </div>
        ))}
        <button type="submit" className="adm-btn" disabled={busy || fields.pool.trim() === ''}>
          Open the checklist
        </button>
      </form>
      <div className="adm-field">
        <label htmlFor="trust-onboarding-reason">Approval reason</label>
        <input
          id="trust-onboarding-reason"
          className="adm-input"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <Problem problem={problem} />
      {read.data.checklists.length === 0 ? (
        <p role="status">No permissioned pool checklist has been opened on this network.</p>
      ) : (
        <table className="adm-table" aria-label="Onboarding">
          <thead>
            <tr>
              <th>Pool</th>
              <th>Checker address</th>
              <th>State</th>
              <th>Opened by</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {read.data.checklists.map((c) => (
              <tr key={c.id}>
                <td>{c.pool}</td>
                <td>{c.checkerAddress ? <code>{c.checkerAddress}</code> : <span className="dk-muted">blank</span>}</td>
                <td>
                  {c.status === 'approved'
                    ? `Approved by ${c.approvedBy}: ${c.approvalReason}`
                    : c.missing.length > 0
                      ? missingItemWords(c.missing).join(' · ')
                      : 'Complete · waiting for a second person'}
                </td>
                <td>
                  <code>{c.openedBy}</code>
                </td>
                <td>
                  {c.status === 'open' && (
                    <button
                      type="button"
                      className="adm-btn"
                      disabled={busy || c.missing.length > 0 || reason.trim() === ''}
                      title={c.missing.length > 0 ? 'A checklist with a blank item cannot be approved.' : undefined}
                      onClick={() => void send({ op: 'onboarding-approve', checklistId: c.id, reason })}
                    >
                      Approve
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
 * audit and disclosure room, token tiers and permissioned pool onboarding, read from svc-protocol as the signed-in founder. The other tabs name what they wait for.
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
        ) : tab === 'Token tiers' ? (
          <TokenTiers tokens={read.tokens} read={read.tiers} reload={() => void reload()} />
        ) : tab === 'Permissioned pools' ? (
          <PermissionedPools read={read.onboarding} reload={() => void reload()} />
        ) : tab === 'Trust criteria' ? (
          <TrustCriteria read={read.tokens} />
        ) : (
          <AuditRoom read={read.audit} />
        )}
      </div>
    </div>
  );
}
