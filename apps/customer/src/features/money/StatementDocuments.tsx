import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Button } from '../../shared/ui';
import { useSession } from '../session';
import { refusalCopy } from '../../data';
import { decodeBase64, saveFile, shortFingerprint } from '../../screens/money/statement-model';
import { type StatementJob } from './contracts';
import { statementCentreCopy } from './statement-centre-copy';
import { statementDocumentsCopy } from './statement-documents-copy';
import { refusedWords } from './statement-refusals';
import { BANK_STATEMENTS_JOBS_LIST, BANK_STATEMENTS_JOBS_DOWNLOAD } from '@intafaced/contracts/bank-statements-procedures';

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; words: string; code: string | null }
  | { kind: 'loaded'; enabled: boolean; items: StatementJob[] };

/** How often the list is read again while a document is still being made. */
const WATCH_MS = 3_000;

/**
 * The document centre on `/bank/statements` (PF-statements-02): every background export the person asked for, newest first,
 * with where it is (waiting, being made, ready, could not be made) and a download once it is ready. `version` changes when
 * the centre above asks for a new one, so the list reads again at once. With background exports off in this build the
 * panel says so, with the bank's code, and lists what was made before.
 */
export function StatementDocuments({ version }: { version: number }) {
  const { t } = statementDocumentsCopy.useCopy();
  const centre = statementCentreCopy.useCopy();
  const { api } = useSession();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [said, setSaid] = useState<{ words: string; code: string | null; ok: boolean } | null>(null);

  // Reads can overlap (the watch, a new request, Refresh): only the latest one asked for may set the list.
  const latest = useRef(0);
  const read = useCallback(async () => {
    const asked = ++latest.current;
    const result = await api.call(BANK_STATEMENTS_JOBS_LIST, undefined);
    if (asked !== latest.current) return;
    if (!result.ok) {
      const code = result.code ?? null;
      setLoad({ kind: 'failed', words: refusalCopy(code ?? result.reason).title, code });
      return;
    }
    setLoad({ kind: 'loaded', enabled: result.data.enabled, items: result.data.items });
  }, [api]);

  useEffect(() => {
    void read();
  }, [read, version]);

  const open = load.kind === 'loaded' && load.items.some((job) => job.state === 'queued' || job.state === 'rendering');
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void read(), WATCH_MS);
    return () => clearInterval(timer);
  }, [open, read]);

  async function download(job: StatementJob) {
    setSaid(null);
    const result = await api.call(BANK_STATEMENTS_JOBS_DOWNLOAD, { id: job.id });
    if (!result.ok) {
      const code = result.code ?? null;
      const words =
        code === 'bank.statement_job_not_ready'
          ? t('notReady')
          : code === 'bank.statement_job_not_found'
            ? t('notFound')
            : refusalCopy(code ?? result.reason).title;
      setSaid({ words, code, ok: false });
      return;
    }
    const bytes = decodeBase64(result.data.bodyBase64);
    if (!bytes) return setSaid({ words: centre.t('unreadable'), code: null, ok: false });
    saveFile(bytes, result.data.contentType, result.data.filename);
    setSaid({ words: t('downloaded', { name: result.data.filename }), code: null, ok: true });
  }

  return (
    <section className="lt-stack" data-testid="statement-documents" aria-label={t('title')}>
      <h4>{t('title')}</h4>
      <p className="lt-muted">{t('lead')}</p>
      {load.kind === 'loading' ? (
        <p role="status">…</p>
      ) : load.kind === 'failed' ? (
        <div className="lt-stack">
          <p role="alert" className="error-text" data-code={load.code ?? undefined}>
            {t('loadFailed')} {load.words}
          </p>
          <div className="lt-actions">
            <Button type="button" variant="secondary" onClick={() => void read()}>
              {t('retry')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {!load.enabled && (
            <p className="lt-muted" data-code="bank.statement_jobs_unset">
              {t('off')}
            </p>
          )}
          {load.items.length === 0 ? (
            <p className="lt-muted" data-testid="statement-documents-empty">
              {t('empty')}
            </p>
          ) : (
            <ul className="lt-stack" role="list">
              {load.items.map((job) => (
                <li key={job.id} className="bd-card" data-job={job.id} data-state={job.state}>
                  <strong>
                    {centre.t(`report_${job.report}`)} · {job.format.toUpperCase()}
                  </strong>
                  <span className="lt-muted">{t('range', { from: job.from.slice(0, 10), to: job.to.slice(0, 10) })}</span>
                  <span data-testid="statement-document-state">{t(`state_${job.state}`)}</span>
                  {job.state === 'failed' && job.errorCode && (
                    <span className="lt-muted" data-code={job.errorCode}>
                      {refusedWords(centre.t, job.errorCode, job.errorCode)}
                    </span>
                  )}
                  {job.attempts > 1 && job.state === 'ready' && (
                    <span className="lt-muted">{t('retried', { attempts: String(job.attempts) })}</span>
                  )}
                  {job.state === 'ready' && job.sha256 && (
                    <span className="lt-muted">
                      {t('lines', { count: String(job.rowCount ?? 0), fingerprint: shortFingerprint(job.sha256) })}
                    </span>
                  )}
                  {job.state === 'ready' && (
                    <div className="lt-actions">
                      <Button type="button" variant="secondary" onClick={() => void download(job)}>
                        <Download size={16} aria-hidden="true" />
                        {t('download')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="lt-actions">
            <Button type="button" variant="ghost" onClick={() => void read()}>
              <RefreshCw size={16} aria-hidden="true" />
              {t('refresh')}
            </Button>
          </div>
        </>
      )}
      {said && (
        <p role={said.ok ? 'status' : 'alert'} className={said.ok ? 'money-caption' : 'error-text'} data-code={said.code ?? undefined}>
          {said.words}
        </p>
      )}
    </section>
  );
}
