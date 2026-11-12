'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchCertDesigns, fetchIssuedCerts, postCertDeskChange } from '@/lib/academy/cert-designs-browser';
import type { AcademyCertDesign, CertDeskReply, CertDesignsView, IssuedCertsView } from '@/lib/academy/cert-designs-model';
import { Failed } from '@/components/academy-courses-desk';

/**
 * CERTIFICATE DESIGNS AND THE ISSUED LIST (AC-certificates-03).
 *
 * A design is what a published certificate prints: title, body, signatories, the disclaimer, language, size and hours of
 * effort. Every save is a new revision with its reason. Activation is a separate move and svc-academy refuses it with no
 * signatory or a blank disclaimer (the wording is the owner's; nothing is filled in here). An active design that is edited
 * stays active under its new revision, and every certificate already issued keeps printing the revision it was issued
 * under, which this page says before and after the save. The issued list counts every certificate by status, and an
 * export is a stored snapshot of the whole list with its time and SHA-256. Logo, template and serial-number format are
 * later parts.
 */

function Outcome({ reply }: { reply: CertDeskReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone={reply.warning ? 'warn' : 'ok'} data-testid="cert-desk-outcome" data-code="">
        <strong>Done: {reply.what}</strong>
        {reply.warning && <p data-testid="cert-design-warning">{reply.warning}</p>}
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="cert-desk-outcome"
      data-code={reply.code ?? ''}
    >
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}

type Draft = {
  title: string;
  body: string;
  signatories: Array<{ name: string; role: string }>;
  disclaimer: string;
  language: string;
  size: 'a4' | 'letter';
  effortHours: string;
};

const draftOf = (row: AcademyCertDesign): Draft => {
  const c = row.design?.current;
  return {
    title: c?.title ?? row.title,
    body: c?.body ?? '',
    signatories: c?.signatories.map((s) => ({ ...s })) ?? [],
    disclaimer: c?.disclaimer ?? '',
    language: c?.language ?? 'en',
    size: c?.size ?? 'a4',
    effortHours: c?.effortHours ?? '',
  };
};

function DesignCard({ row, busy, send }: { row: AcademyCertDesign; busy: boolean; send: (body: Record<string, unknown>) => void }) {
  const [draft, setDraft] = useState<Draft>(draftOf(row));
  const [reason, setReason] = useState('');
  const [activateReason, setActivateReason] = useState('');
  const [deactivateReason, setDeactivateReason] = useState('');
  const set = (patch: Partial<Draft>) => setDraft((now) => ({ ...now, ...patch }));
  const setSigner = (i: number, patch: Partial<Draft['signatories'][number]>) =>
    set({ signatories: draft.signatories.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const design = row.design;
  const revision = design?.current.revision ?? 0;
  const active = design?.activeRevision ?? null;
  const issued = row.issuedByRevision.reduce((sum, r) => sum + r.count, 0);
  const state = !design ? 'none' : active === null ? 'draft' : 'active';
  return (
    <section className="dk-stack" data-cert-design={row.certId} data-state={state} aria-labelledby={`h-design-${row.certId}`}>
      <h2 id={`h-design-${row.certId}`}>
        {row.title} <code>{row.certId}</code>
      </h2>
      <p className="dk-muted" data-testid="cert-design-now">
        {!design
          ? 'No design yet. Save one, then activate it.'
          : active === null
            ? `Draft, revision ${revision}, saved ${formatWhen(design.current.savedAt)}: ${design.current.reason}. Not active: no certificate prints it.`
            : `Active, revision ${active}, since ${formatWhen(design.activatedAt ?? design.current.savedAt)}. Certificates issued now print it.`}
      </p>
      <p className="dk-muted" data-testid="cert-design-issued">
        {issued === 0
          ? 'No certificate has been issued yet.'
          : `Issued: ${row.issuedByRevision.map((r) => `${r.count} under ${r.revision === null ? 'no design' : `revision ${r.revision}`}`).join(', ')}.`}
      </p>
      {active !== null && issued > 0 && (
        <div className="adm-callout" data-tone="warn" role="note" data-testid="cert-design-edit-warning">
          <strong>Editing an active design with issued certificates</strong>
          <p>
            Saving makes a new revision that certificates issued from then on print. The {issued} certificate{issued === 1 ? '' : 's'}{' '}
            already issued keep printing the revision they were issued under.
          </p>
        </div>
      )}
      <form
        className="dk-stack"
        data-testid="cert-design-form"
        onSubmit={(e) => {
          e.preventDefault();
          send({
            op: 'saveDesign',
            certId: row.certId,
            revision,
            title: draft.title,
            body: draft.body,
            signatories: draft.signatories,
            // A blank disclaimer is sent blank: a draft may hold none, and activation then refuses it by name.
            disclaimer: draft.disclaimer.trim() === '' ? null : draft.disclaimer,
            language: draft.language.trim(),
            size: draft.size,
            effortHours: draft.effortHours.trim() === '' ? null : draft.effortHours.trim(),
            reason,
          });
        }}
      >
        <label>
          Title
          <input value={draft.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} aria-label="Design title" />
        </label>
        <label>
          Body text
          <textarea value={draft.body} onChange={(e) => set({ body: e.target.value })} maxLength={2000} aria-label="Design body" />
        </label>
        <fieldset className="dk-stack">
          <legend>Signatories</legend>
          {draft.signatories.length === 0 && <p className="dk-muted">No signatory yet. A design needs at least one to be active.</p>}
          {draft.signatories.map((s, i) => (
            <div className="dk-row" key={i} data-testid="cert-signatory">
              <label>
                Name
                <input value={s.name} onChange={(e) => setSigner(i, { name: e.target.value })} aria-label={`Signatory ${i + 1} name`} />
              </label>
              <label>
                Role
                <input value={s.role} onChange={(e) => setSigner(i, { role: e.target.value })} aria-label={`Signatory ${i + 1} role`} />
              </label>
              <button type="button" className="adm-btn" onClick={() => set({ signatories: draft.signatories.filter((_, j) => j !== i) })}>
                Remove signatory {i + 1}
              </button>
            </div>
          ))}
          <div className="dk-row">
            <button
              type="button"
              className="adm-btn"
              disabled={draft.signatories.length >= 4}
              onClick={() => set({ signatories: [...draft.signatories, { name: '', role: '' }] })}
            >
              Add signatory
            </button>
          </div>
        </fieldset>
        <label>
          Disclaimer
          <textarea
            value={draft.disclaimer}
            onChange={(e) => set({ disclaimer: e.target.value })}
            maxLength={2000}
            aria-label="Design disclaimer"
          />
        </label>
        <div className="dk-row">
          <label>
            Language
            <input value={draft.language} onChange={(e) => set({ language: e.target.value })} aria-label="Design language" />
          </label>
          <label>
            Size
            <select value={draft.size} onChange={(e) => set({ size: e.target.value as Draft['size'] })} aria-label="Design size">
              <option value="a4">A4</option>
              <option value="letter">Letter</option>
            </select>
          </label>
          <label>
            Hours of effort
            <input
              value={draft.effortHours}
              onChange={(e) => set({ effortHours: e.target.value })}
              inputMode="decimal"
              aria-label="Design hours of effort"
            />
          </label>
        </div>
        <div className="dk-row">
          <label>
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Design reason" />
          </label>
          <button type="submit" className="adm-btn" disabled={busy}>
            Save design
          </button>
        </div>
      </form>
      {active !== null && (
        <form
          className="dk-row"
          data-testid="cert-design-deactivate"
          onSubmit={(e) => {
            e.preventDefault();
            send({ op: 'deactivateDesign', certId: row.certId, reason: deactivateReason });
          }}
        >
          <label>
            Reason
            <input
              value={deactivateReason}
              onChange={(e) => setDeactivateReason(e.target.value)}
              maxLength={500}
              aria-label="Deactivation reason"
            />
          </label>
          <button type="submit" className="adm-btn" disabled={busy}>
            Deactivate
          </button>
        </form>
      )}
      {design && active !== revision && (
        <form
          className="dk-row"
          data-testid="cert-design-activate"
          onSubmit={(e) => {
            e.preventDefault();
            send({ op: 'activateDesign', certId: row.certId, revision, reason: activateReason });
          }}
        >
          <label>
            Reason
            <input
              value={activateReason}
              onChange={(e) => setActivateReason(e.target.value)}
              maxLength={500}
              aria-label="Activation reason"
            />
          </label>
          <button type="submit" className="adm-btn" disabled={busy}>
            Activate revision {revision}
          </button>
        </form>
      )}
    </section>
  );
}

function useDesk<T>(initial: T | null, reload: () => Promise<T | null>) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<CertDeskReply | null>(null);
  const read = useCallback(async () => {
    const next = await reload();
    if (next) setView(next);
  }, [reload]);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postCertDeskChange(body);
    setReply(answer);
    setBusy(false);
    // Whatever the answer, the page shows what svc-academy holds now.
    await read();
  };
  return { view, busy, reply, send };
}

export function AcademyCertDesigns({ initial }: { initial: CertDesignsView | null }) {
  const { view, busy, reply, send } = useDesk(initial, fetchCertDesigns);
  const part = view?.designs;
  return (
    <div className="dk" data-testid="academy-cert-designs">
      <div className="adm-pagehead">
        <div>
          <h1>Certificate designs</h1>
          <p>
            <Link href="/academy-ops/certificates">Back to certificates</Link> ·{' '}
            <Link href="/academy-ops/certificates/issued">Issued certificates</Link>
          </p>
        </div>
        <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      </div>
      <Outcome reply={reply} />
      {!part && <p className="dk-why">The console could not reach its own server. Nothing is shown rather than a guess.</p>}
      {part?.kind === 'failed' && <Failed title="Could not read the designs" message={part.message} code={part.code} />}
      {part?.kind === 'ok' &&
        (part.data.items.length === 0 ? (
          <p className="dk-muted">svc-academy publishes no certificate, so there is nothing to design.</p>
        ) : (
          part.data.items.map((row) => (
            <DesignCard
              key={`${row.certId}:${row.design?.current.revision ?? 0}:${row.design?.activeRevision ?? 0}`}
              row={row}
              busy={busy}
              send={(b) => void send(b)}
            />
          ))
        ))}
    </div>
  );
}

export function AcademyIssuedCerts({ initial }: { initial: IssuedCertsView | null }) {
  const certificate = initial?.certificate ?? null;
  const reload = useCallback(() => fetchIssuedCerts(certificate), [certificate]);
  const { view, busy, reply, send } = useDesk(initial, reload);
  const issued = view?.issued;
  const exports = view?.exports;
  const next = exports?.kind === 'ok' ? (exports.data.exports[0]?.n ?? 0) + 1 : null;
  return (
    <div className="dk" data-testid="academy-issued-certs">
      <div className="adm-pagehead">
        <div>
          <h1>Issued certificates</h1>
          <p>
            <Link href="/academy-ops/certificates">Back to certificates</Link> ·{' '}
            <Link href="/academy-ops/certificates/designs">Designs</Link>
            {certificate && (
              <>
                {' '}
                · Showing <code>{certificate}</code> only (<Link href="/academy-ops/certificates/issued">all</Link>)
              </>
            )}
          </p>
        </div>
        <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      </div>
      <Outcome reply={reply} />
      {!issued && <p className="dk-why">The console could not reach its own server. Nothing is shown rather than a guess.</p>}
      {issued?.kind === 'failed' && <Failed title="Could not read the issued certificates" message={issued.message} code={issued.code} />}
      {issued?.kind === 'ok' && (
        <>
          <section className="dk-stack" aria-labelledby="h-counts">
            <h2 id="h-counts">Counts</h2>
            <p data-testid="issued-total" data-count={issued.data.total}>
              {issued.data.total} issued in all.
            </p>
            {issued.data.counts.length === 0 ? (
              <p className="dk-muted" data-testid="issued-empty">
                No certificate has been issued{certificate ? ' for this certificate' : ''}: valid 0, revoked 0.
              </p>
            ) : (
              <table className="adm-table" data-testid="issued-counts">
                <thead>
                  <tr>
                    <th>Certificate</th>
                    <th>Valid</th>
                    <th>Revoked</th>
                  </tr>
                </thead>
                <tbody>
                  {issued.data.counts.map((c) => (
                    <tr key={c.certId} data-cert={c.certId}>
                      <td>
                        <code>{c.certId}</code>
                      </td>
                      <td data-status="valid">{c.valid}</td>
                      <td data-status="revoked">{c.revoked}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="dk-stack" aria-labelledby="h-issued">
            <h2 id="h-issued">Newest issued</h2>
            {issued.data.items.length === 0 ? (
              <p className="dk-muted">Nothing to list.</p>
            ) : (
              <>
                {issued.data.items.length < issued.data.total && (
                  <p className="dk-muted">
                    The newest {issued.data.items.length} of {issued.data.total}, as many as one read shows. The export holds them all.
                  </p>
                )}
                <div className="dk-table-wrap">
                  <table className="adm-table" data-testid="issued-list">
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Account</th>
                        <th>Certificate</th>
                        <th>Status</th>
                        <th>Issued</th>
                        <th>Design revision</th>
                      </tr>
                    </thead>
                    <tbody>
                      {issued.data.items.map((r) => (
                        <tr key={r.publicId} data-public-id={r.publicId}>
                          <td>
                            <code>{r.publicId}</code>
                          </td>
                          <td>
                            <code>{r.accountId}</code>
                          </td>
                          <td>
                            <code>{r.certId}</code>
                          </td>
                          <td data-status={r.status}>{r.status === 'revoked' ? 'Revoked' : 'Valid'}</td>
                          <td>{formatWhen(r.grantedAt)}</td>
                          <td>{r.designRevision ?? 'none'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}
      <section className="dk-stack" aria-labelledby="h-exports">
        <h2 id="h-exports">Exports</h2>
        {exports?.kind === 'failed' && <Failed title="Could not read the exports" message={exports.message} code={exports.code} />}
        {exports?.kind === 'ok' && (
          <>
            <div className="dk-row">
              <button
                type="button"
                className="adm-btn"
                disabled={busy || next === null}
                onClick={() => void send({ op: 'makeExport', n: next })}
              >
                Make export {next}
              </button>
            </div>
            {exports.data.exports.length === 0 ? (
              <p className="dk-muted" data-testid="cert-exports-empty">
                No export yet. An export stores every issued certificate as the list reads when you make it.
              </p>
            ) : (
              <table className="adm-table" data-testid="cert-exports">
                <thead>
                  <tr>
                    <th>Export</th>
                    <th>Made</th>
                    <th>Rows</th>
                    <th>SHA-256</th>
                    <th>File</th>
                  </tr>
                </thead>
                <tbody>
                  {exports.data.exports.map((x) => (
                    <tr key={x.n} data-export={x.n}>
                      <td>{x.n}</td>
                      <td>{formatWhen(x.madeAt)}</td>
                      <td data-testid="export-rows">{x.rows}</td>
                      <td>
                        <code>{x.sha256}</code>
                      </td>
                      <td>
                        <a href={`/api/academy-cert-designs?export=${x.n}`} download>
                          Download export {x.n}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </div>
  );
}
