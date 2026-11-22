import { useId } from 'react';

import { Button, Select } from '@intafaced/ui/lit';

import { ServiceOffNotice as KitServiceOffNotice, type NotConnectedCode } from '@intafaced/ui/lit/templates';

import { serviceOffCopy } from '../../../shared/service-off';

import { type LineTotal } from '../contracts';

import { statementExtrasCopy } from '../statement-extras-copy';

import { useStatementLetters, useTaxStatements } from '../StatementExtras';

/**
 * The statement room's own drawing of `LineTotals`, `StatementLetters` and `TaxStatements` (../StatementExtras.tsx, which
 * other rooms still draw): the same calls, words and states, in the Volt kit.
 */

/** The one service-off notice (HM-shell-03), in the words `ServiceOffNotice` in shared/service-off says it. */
function ServiceOff({ code, action, role }: { code: NotConnectedCode; action: string; role?: 'note' | 'status' }) {
  const { t } = serviceOffCopy.useCopy();
  return <KitServiceOffNotice code={code} sentence={t('sentence', { action, dependency: t(code) })} role={role} />;
}

/** Per coin, the net of a set of lines, as the bank folded them (J-bank-16 #1). The same list under a statement and on Activity. */
export function LineTotals({ totals, testId }: { totals: readonly LineTotal[]; testId: string }) {
  const { t } = statementExtrasCopy.useCopy();
  return (
    <div data-testid={testId}>
      <p>{t('totalsTitle')}</p>
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

/**
 * J-bank-16 #2 (BK-acct-07): an ownership letter or a balance certificate. The bank answers; while no banking partner is
 * connected it refuses `rail.bank`, shown as the one service-off notice, and nothing is made.
 */
export function StatementLetters() {
  const { t, busy, said, ask } = useStatementLetters();
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <h3 id={heading}>{t('lettersTitle')}</h3>
      <p>{t('lettersLead')}</p>
      <section data-testid="statement-letters" aria-label={t('lettersTitle')}>
        <div className="lt-actions">
          <Button type="button" tone="secondary" disabled={busy} onClick={() => void ask('ownership')}>
            {t('letterOwnership')}
          </Button>
          <Button type="button" tone="quiet" disabled={busy} onClick={() => void ask('balance')}>
            {t('letterBalance')}
          </Button>
        </div>
        <p role="status" aria-live="polite">
          {busy ? t('letterAsking') : ''}
        </p>
        {said?.kind === 'off' && <ServiceOff code={said.code} action={t('letterAction')} role="status" />}
        {said?.kind === 'refused' && (
          <p role="alert" data-code={said.code ?? undefined}>
            {said.words}
          </p>
        )}
      </section>
    </section>
  );
}

/**
 * J-bank-16 #3 (BK-acct-07): tax statements for a year. They come from a tax calculation provider; while none is
 * connected the bank refuses `vendor.tax`, shown as the one service-off notice. No tax figure is worked out here.
 */
export function TaxStatements() {
  const { t, thisYear, year, setYear, tax } = useTaxStatements();
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <h3 id={heading}>{t('taxTitle')}</h3>
      <p>{t('taxLead')}</p>
      <section data-testid="tax-statements" aria-label={t('taxTitle')}>
        <Select
          label={t('taxYear')}
          value={String(year)}
          onChange={(event) => setYear(Number(event.target.value))}
          options={Array.from({ length: 6 }, (_, back) => String(thisYear - back)).map((y) => [y, y] as const)}
        />
        {tax.kind === 'loading' && <p role="status">{t('taxLoading')}</p>}
        {tax.kind === 'list' && tax.count === 0 && <p role="status">{t('taxEmpty')}</p>}
        {tax.kind === 'off' && <ServiceOff code={tax.code} action={t('taxAction')} role="status" />}
        {tax.kind === 'refused' && (
          <p role="alert" data-code={tax.code ?? undefined}>
            {tax.words}
          </p>
        )}
      </section>
    </section>
  );
}
