import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button, Field } from '@intafaced/ui/lit';
import { SelectField } from '@intafaced/ui/lit/templates';
import { refusalCopy } from './deps';
import { moneyCopy } from './copy';
import { decodeBase64, lastFullMonth, monthIsOver, monthRange, saveFile, shortFingerprint } from './statement-model';
import { useSession } from '../../features/session/session';
import { statementCentreCopy } from '../../features/money/statement-centre-copy';
import { BANK_STATEMENTS_EXPORT } from '@intafaced/contracts/bank-statements-procedures';

type Outcome = { kind: 'done'; filename: string; rows: number; fingerprint: string } | { kind: 'error'; words: string } | null;

/**
 * A statement from the bank: the month's posted lines as a signed PDF or CSV, with a fingerprint that support can check.
 * It lists lines; it does not state a balance. Only a finished month is offered, so the file is never half a month.
 */
export function StatementPanel() {
  const { t } = moneyCopy.useCopy();
  const centre = statementCentreCopy.useCopy();
  const { api } = useSession();
  const [month, setMonth] = useState(() => lastFullMonth(new Date()));
  const [format, setFormat] = useState<'pdf' | 'csv'>('pdf');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const range = monthRange(month);
  const over = monthIsOver(month, new Date());
  const problem = range === null ? t('Statement month needed') : !over ? t('Statement month unfinished') : null;

  async function download() {
    if (busy || !range || !over) return;
    setBusy(true);
    setOutcome(null);
    const result = await api.call(BANK_STATEMENTS_EXPORT, { from: range.from, to: range.to, format });
    setBusy(false);
    if (!result.ok) {
      const code = result.code ?? '';
      const words =
        code === 'bank.statement_too_large'
          ? t('Statement too large')
          : code === 'bank.statement_unavailable'
            ? t('Statement unavailable')
            : refusalCopy(code || result.reason).title;
      setOutcome({ kind: 'error', words });
      return;
    }
    const bytes = decodeBase64(result.data.bodyBase64);
    if (!bytes) {
      setOutcome({ kind: 'error', words: t('Statement unreadable') });
      return;
    }
    saveFile(bytes, result.data.contentType, result.data.filename);
    setOutcome({
      kind: 'done',
      filename: result.data.filename,
      rows: result.data.rowCount,
      fingerprint: shortFingerprint(result.data.sha256),
    });
  }

  return (
    <form
      className="lt-stack"
      aria-label={t('Statement')}
      onSubmit={(event) => {
        event.preventDefault();
        void download();
      }}
    >
      <h2 className="lt-heading">{t('Statement')}</h2>
      <p className="lt-hint">{t('Statement hint')}</p>
      <p className="lt-hint">
        <a className="lt-link" href="/bank/statements">
          {centre.t('activityLink')}
        </a>{' '}
        {centre.t('activityLinkHint')}
      </p>
      <div className="lt-toolbar">
        <Field
          type="month"
          label={t('Statement month')}
          value={month}
          max={lastFullMonth(new Date())}
          onChange={(event) => setMonth(event.target.value)}
        />
        <SelectField
          label={t('Statement format')}
          value={format}
          options={[
            { value: 'pdf', label: 'PDF' },
            { value: 'csv', label: 'CSV' },
          ]}
          onChange={(value) => setFormat(value as 'pdf' | 'csv')}
        />
        <Button type="submit" tone="secondary" disabled={busy || problem !== null}>
          <Download size={16} aria-hidden="true" />
          {t('Download statement')}
        </Button>
      </div>
      <p className="lt-hint" role="status" aria-live="polite">
        {problem ??
          (busy
            ? t('Statement preparing')
            : outcome?.kind === 'done'
              ? t('Statement done', { name: outcome.filename, count: outcome.rows, fingerprint: outcome.fingerprint })
              : outcome?.kind === 'error'
                ? outcome.words
                : '')}
      </p>
    </form>
  );
}
