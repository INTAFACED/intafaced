import { useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/ui';
import { ServiceOffNotice, NOT_CONNECTED_CODES, type NotConnectedCode } from '../../shared/service-off';
import { useSession } from '../session/session';
import { letterRequestSchema, taxStatementsSchema, type LineTotal } from './contracts';
import { DepthPanel } from './DepthParts';
import { statementExtrasCopy } from './statement-extras-copy';

const outside = (code: string | null | undefined): NotConnectedCode | null =>
  code && (NOT_CONNECTED_CODES as readonly string[]).includes(code) ? (code as NotConnectedCode) : null;

/** Per coin, the net of a set of lines, as the bank folded them (J-bank-16 #1). The same list under a statement and on Activity. */
export function LineTotals({ totals, testId }: { totals: readonly LineTotal[]; testId: string }) {
  const { t } = statementExtrasCopy.useCopy();
  return (
    <div data-testid={testId} className="bd-stack">
      <p className="money-caption">{t('totalsTitle')}</p>
      {totals.length === 0 ? (
        <p>{t('totalsNone')}</p>
      ) : (
        <ul>
          {totals.map((total) => (
            <li key={total.asset} data-asset={total.asset} data-net={total.net}>
              {t('totalLine', { asset: total.asset, net: total.net, lines: String(total.lines) })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Said = { kind: 'off'; code: NotConnectedCode } | { kind: 'refused'; words: string; code: string | null } | null;

/**
 * J-bank-16 #2 (BK-acct-07): an ownership letter or a balance certificate. The bank answers; while no banking partner is
 * connected it refuses `rail.bank`, shown as the one service-off notice, and nothing is made.
 */
export function StatementLetters() {
  const { t } = statementExtrasCopy.useCopy();
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said>(null);

  async function ask(kind: 'ownership' | 'balance') {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    const result = await api.mutate('bank', 'letters.request', { kind }, letterRequestSchema);
    setBusy(false);
    if (result.ok) return;
    const code = outside(result.code);
    setSaid(code ? { kind: 'off', code } : { kind: 'refused', words: t('letterRefused'), code: result.code ?? null });
  }

  return (
    <DepthPanel title={t('lettersTitle')} lead={t('lettersLead')}>
      <section className="bd-stack" data-testid="statement-letters" aria-label={t('lettersTitle')}>
        <div className="actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void ask('ownership')}>
            {t('letterOwnership')}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void ask('balance')}>
            {t('letterBalance')}
          </Button>
        </div>
        <p role="status" aria-live="polite">
          {busy ? t('letterAsking') : ''}
        </p>
        {said?.kind === 'off' && <ServiceOffNotice code={said.code} action={t('letterAction')} role="status" />}
        {said?.kind === 'refused' && (
          <p role="alert" className="error-text" data-code={said.code ?? undefined}>
            {said.words}
          </p>
        )}
      </section>
    </DepthPanel>
  );
}

type Tax = { kind: 'loading' } | { kind: 'list'; count: number } | Exclude<Said, null>;

/**
 * J-bank-16 #3 (BK-acct-07): tax statements for a year. They come from a tax calculation provider; while none is
 * connected the bank refuses `vendor.tax`, shown as the one service-off notice. No tax figure is worked out here.
 */
export function TaxStatements() {
  const { t } = statementExtrasCopy.useCopy();
  const { api } = useSession();
  const thisYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(thisYear);
  const [tax, setTax] = useState<Tax>({ kind: 'loading' });
  // The copy function is new on every render; reading it through a ref keeps the read from restarting each render,
  // which left the panel on "Opening tax statements…" for good (J-bank-16 #3).
  const words = useRef(t);
  words.current = t;

  useEffect(() => {
    let live = true;
    setTax({ kind: 'loading' });
    void api.query('bank', 'statements.tax.list', { year }, taxStatementsSchema).then((result) => {
      if (!live) return;
      if (result.ok) return setTax({ kind: 'list', count: result.data.items.length });
      const code = outside(result.code);
      setTax(code ? { kind: 'off', code } : { kind: 'refused', words: words.current('taxRefused'), code: result.code ?? null });
    });
    return () => {
      live = false;
    };
  }, [api, year]);

  return (
    <DepthPanel title={t('taxTitle')} lead={t('taxLead')}>
      <section className="bd-stack" data-testid="tax-statements" aria-label={t('taxTitle')}>
        <label className="field">
          <span>{t('taxYear')}</span>
          <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
            {Array.from({ length: 6 }, (_, back) => thisYear - back).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        {tax.kind === 'loading' && <p role="status">{t('taxLoading')}</p>}
        {tax.kind === 'list' && tax.count === 0 && <p role="status">{t('taxEmpty')}</p>}
        {tax.kind === 'off' && <ServiceOffNotice code={tax.code} action={t('taxAction')} role="status" />}
        {tax.kind === 'refused' && (
          <p role="alert" className="error-text" data-code={tax.code ?? undefined}>
            {tax.words}
          </p>
        )}
      </section>
    </DepthPanel>
  );
}
