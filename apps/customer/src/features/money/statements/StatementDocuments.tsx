import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Button } from '@intafaced/ui/lit';
import { useSession } from '../../session';
import { refusalCopy } from '../../../data';
import { decodeBase64, saveFile, shortFingerprint } from '../../../screens/money/statement-model';
import { statementFileSchema, statementJobsSchema, type StatementJob } from '../contracts';
import { statementCentreCopy } from '../statement-centre-copy';
import { statementDocumentsCopy } from '../statement-documents-copy';
import { refusedWords } from '../statement-refusals';

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
    const result = await api.query('bank', 'statements.jobs.list', undefined, statementJobsSchema);
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
    const result = await api.query('bank', 'statements.jobs.download', { id: job.id }, statementFileSchema);
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
    <section data-testid="statement-documents" aria-label={t('title')}>
      <h4>{t('title')}</h4>
      <p>{t('lead')}</p>
      {load.kind === 'loading' ? (
        <p role="status">…</p>
      ) : load.kind === 'failed' ? (
        <div>
          <p role="alert" data-code={load.code ?? undefined}>
            {t('loadFailed')} {load.words}
          </p>
          <div className="lt-actions">
            <Button type="button" tone="secondary" onClick={() => void read()}>
              {t('retry')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {!load.enabled && <p data-code="bank.statement_jobs_unset">{t('off')}</p>}
          {load.items.length === 0 ? (
            <p data-testid="statement-documents-empty">{t('empty')}</p>
          ) : (
            <ul role="list">
              {load.items.map((job) => (
                <li key={job.id} data-job={job.id} data-state={job.state}>
                  <strong>
                    {centre.t(`report_${job.report}`)} · {job.format.toUpperCase()}
                  </strong>
                  <span className="lt-hint">{t('range', { from: job.from.slice(0, 10), to: job.to.slice(0, 10) })}</span>
                  <span data-testid="statement-document-state">{t(`state_${job.state}`)}</span>
                  {job.state === 'failed' && job.errorCode && (
                    <span className="lt-hint" data-code={job.errorCode}>
                      {refusedWords(centre.t, job.errorCode, job.errorCode)}
                    </span>
                  )}
                  {job.attempts > 1 && job.state === 'ready' && (
                    <span className="lt-hint">{t('retried', { attempts: String(job.attempts) })}</span>
                  )}
                  {job.state === 'ready' && job.sha256 && (
                    <span className="lt-hint">
                      {t('lines', { count: String(job.rowCount ?? 0), fingerprint: shortFingerprint(job.sha256) })}
                    </span>
                  )}
                  {job.state === 'ready' && (
                    <div className="lt-actions">
                      <Button type="button" tone="secondary" onClick={() => void download(job)}>
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
            <Button type="button" tone="quiet" onClick={() => void read()}>
              <RefreshCw size={16} aria-hidden="true" />
              {t('refresh')}
            </Button>
          </div>
        </>
      )}
      {said && (
        <p role={said.ok ? 'status' : 'alert'} data-code={said.code ?? undefined}>
          {said.words}
        </p>
      )}
    </section>
  );
}
