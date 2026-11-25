import { type LineTotal } from './contracts';
import { statementExtrasCopy } from './statement-extras-copy';

/** Per coin, the net of a set of lines, as the bank folded them (J-bank-16 #1). The same list under a statement and on Activity. */
export function LineTotals({ totals, testId }: { totals: readonly LineTotal[]; testId: string }) {
  const { t } = statementExtrasCopy.useCopy();
  return (
    <div data-testid={testId} className="lt-stack">
      <p className="lt-muted">{t('totalsTitle')}</p>
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
