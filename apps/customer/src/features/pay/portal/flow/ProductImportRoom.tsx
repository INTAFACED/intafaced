// volt-room: portal:product-import
// volt-room: /pay/products/import
import { useState, type ChangeEvent } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import {
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_IMPORT_MAX_CHARS,
  PRODUCT_IMPORT_MAX_ROWS,
  type MerchantProduct,
  type ProductImport as ImportAnswer,
  type ProductImportProblem,
} from '@intafaced/contracts/merchant-catalog';
import type { PortalApi } from '../api';
import { useMayAddProducts } from '../catalog/access';
import { inMode, useCatalogMode } from '../catalog/mode';
import { catalogCopy as c } from '../catalog/copy';
import { Actions, DateTime, Empty, List, Section } from './parts';

const productHref = (id: string) => `/pay/products/${encodeURIComponent(id)}`;

/**
 * `/pay/products/import` (J-merchant-03 step 5), on the flow template: pick a CSV file, check it (a dry run that writes nothing), then import
 * it. Import is offered only for a file whose check found no problem, and the service checks again and writes all of it
 * or none. The file is its own key: the same file again says when it was imported and lists what it made.
 */
export function ProductImport({ portal }: { portal: PortalApi }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const [mode] = useCatalogMode();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [answer, setAnswer] = useState<ImportAnswer | null>(null);
  const [busy, setBusy] = useState<'check' | 'import' | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  async function picked(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    setAnswer(null);
    setRefused(null);
    setFile(null);
    setNote(null);
    if (!chosen) return;
    const text = chosen.size > PRODUCT_IMPORT_MAX_CHARS * 4 ? null : await chosen.text();
    if (text === null || text.length > PRODUCT_IMPORT_MAX_CHARS) {
      setNote(t('importTooLarge', { max: PRODUCT_IMPORT_MAX_CHARS.toLocaleString('en') }));
      return;
    }
    setFile({ name: chosen.name, text });
  }

  async function send(commit: boolean) {
    if (!file) return;
    setBusy(commit ? 'import' : 'check');
    setRefused(null);
    try {
      const result = await portal.importProducts({ csv: file.text, commit, ...(mode === 'test' ? { mode } : {}) });
      if (result.ok) setAnswer(result.data);
      else {
        setRefused(result.message);
        // A refused import leaves nothing to import: the file is checked again from the start.
        setAnswer(null);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <FlowTemplate
      framed
      title={t('importTitle')}
      state={{ kind: 'ready' }}
      step={
        !may.allowed ? (
          <Empty title={t('importTitle')} body={t(may.unverified ? 'emptyBodyUnverified' : 'emptyBodyReadOnly')} />
        ) : (
          <Section title={t('importTitle')} description={t('importPurpose')}>
            <div data-testid="form-stack">
              {mode === 'test' && <p role="note">{t('testCatalogueImportNote')}</p>}
              <ImportFormat />
              <Field
                label={t('importFile')}
                hint={t('importFileHint', { rows: String(PRODUCT_IMPORT_MAX_ROWS) })}
                type="file"
                accept=".csv,text/csv"
                disabled={busy !== null}
                onChange={(e) => void picked(e)}
              />
              {note && <p role="alert">{note}</p>}
              {file && !answer && (
                <Actions>
                  <Button tone="primary" disabled={busy !== null} onClick={() => void send(false)}>
                    {busy === 'check' ? t('importChecking') : t('importCheck')}
                  </Button>
                </Actions>
              )}
              {refused && <p role="alert">{refused}</p>}
              {file && answer && <ImportAnswerView answer={answer} busy={busy} onImport={() => void send(true)} />}
            </div>
          </Section>
        )
      }
    />
  );
}

/** The columns a file may have, so a merchant can write one without guessing. */
function ImportFormat() {
  const { t } = c.useCopy();
  return (
    <div>
      <p className="lt-hint">{t('importFormat')}</p>
      <p className="lt-hint">{t('importEditedNote')}</p>
      <List
        label={t('importColumnsLabel')}
        rows={PRODUCT_IMPORT_COLUMNS}
        rowKey={(column) => column}
        columns={[
          { header: t('importColColumn'), cell: (column) => <code>{column}</code> },
          { header: t('importColMeaning'), cell: (column) => t(`importColumn_${column}`) },
        ]}
      />
    </div>
  );
}

function ImportAnswerView({ answer, busy, onImport }: { answer: ImportAnswer; busy: 'check' | 'import' | null; onImport: () => void }) {
  const { t } = c.useCopy();
  const [mode] = useCatalogMode();
  if (answer.imported)
    return (
      <div>
        <p role="status">
          {answer.replayed
            ? t(answer.rows === 1 ? 'importReplayedOne' : 'importReplayed', { count: String(answer.rows) })
            : t(answer.rows === 1 ? 'importDoneOne' : 'importDone', { count: String(answer.rows) })}
        </p>
        {answer.importedAt && (
          <p className="lt-hint">
            {t('importedAt')} <DateTime value={answer.importedAt} />
          </p>
        )}
        {answer.products.length < answer.rows && <p className="lt-hint">{t('importSomeDeleted')}</p>}
        <ImportedProducts products={answer.products} />
        <Actions>
          <a className="lt-button lt-button-secondary" href={inMode('/pay/products', mode)}>
            {t('importBack')}
          </a>
        </Actions>
      </div>
    );
  if (answer.problemCount > 0)
    return (
      <div>
        <p role="alert">{t(answer.problemCount === 1 ? 'importProblemsOne' : 'importProblems', { count: String(answer.problemCount) })}</p>
        <ProblemList problems={answer.problems} />
        {answer.problemCount > answer.problems.length && (
          <p className="lt-hint">{t('importProblemsMore', { shown: String(answer.problems.length) })}</p>
        )}
      </div>
    );
  return (
    <div>
      <p role="status">{t(answer.rows === 1 ? 'importReadyOne' : 'importReady', { count: String(answer.rows) })}</p>
      <Actions>
        <Button tone="primary" disabled={busy !== null} onClick={onImport}>
          {busy === 'import'
            ? t('importImporting')
            : t(answer.rows === 1 ? 'importCommitOne' : 'importCommit', { count: String(answer.rows) })}
        </Button>
      </Actions>
    </div>
  );
}

function ProblemList({ problems }: { problems: readonly ProductImportProblem[] }) {
  const { t } = c.useCopy();
  return (
    <List
      label={t('importProblemsLabel')}
      rows={problems}
      rowKey={(p) => `${p.line}:${p.column ?? ''}:${p.problem}`}
      columns={[
        { header: t('importColLine'), cell: (p) => p.line },
        { header: t('importColColumn'), cell: (p) => (p.column ? <code>{p.column}</code> : t('importWholeLine')) },
        { header: t('importColProblem'), cell: (p) => t(`importProblem_${p.problem}`) },
      ]}
    />
  );
}

function ImportedProducts({ products }: { products: readonly MerchantProduct[] }) {
  const { t } = c.useCopy();
  return (
    <List
      label={t('importedLabel')}
      rows={products}
      rowKey={(row) => row.id}
      href={(row) => productHref(row.id)}
      columns={[
        { header: t('colName'), cell: (row) => <strong>{row.name}</strong> },
        { header: t('colType'), cell: (row) => t(`type_${row.type}`) },
        { header: t('colId'), cell: (row) => <code>{row.productKey}</code> },
      ]}
    />
  );
}
