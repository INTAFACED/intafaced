import { ChangeText, CoinIcon, fmtChangeLine } from './deps';
import { moneyCopy } from './copy';
import { moversOf } from './movers-model';
import type { MoneyRow, MoneyView } from './portfolio-source';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

function MoverList({
  title,
  rows,
  empty,
  hidden,
  side,
}: {
  title: string;
  rows: MoneyRow[];
  empty: string;
  hidden: boolean;
  side: string;
}) {
  return (
    <div className="money-movers__side" data-side={side}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="money-card__note">{empty}</p>
      ) : (
        <ol>
          {rows.map((row) => (
            <li key={row.asset} className="money-movers__row" data-asset={row.asset}>
              <CoinIcon asset={row.asset} size={24} />
              <span className="money-movers__coin">{row.asset}</span>
              <ChangeText value={fmtChangeLine(row.usdChange24h, row.changeRatio)} hidden={hidden} className="money-today" />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Best and worst movers today, from the same valuation as the total. Nothing when no coin other than cash is held. */
export function Movers({ view, hidden, copy, sinceLabel }: { view: MoneyView; hidden: boolean; copy: Copy; sinceLabel: string }) {
  const { t } = copy;
  const movers = moversOf(view);
  const anyCrypto = movers.best.length + movers.worst.length + movers.flat.length + movers.unranked.length > 0;
  if (!anyCrypto) return null;
  return (
    <section id="movers" data-testid="money-card" className="money-card" aria-labelledby="money-movers-title">
      <header data-testid="money-card__head" className="money-card__head">
        <h2 id="money-movers-title">{t('Movers')}</h2>
        <span className="money-card__note">{sinceLabel}</span>
      </header>
      <p className="money-card__note">{t('Movers note')}</p>
      <div className="money-movers">
        <MoverList title={t('Best')} side="best" rows={movers.best} empty={t('None rose')} hidden={hidden} />
        <MoverList title={t('Worst')} side="worst" rows={movers.worst} empty={t('None fell')} hidden={hidden} />
      </div>
      {movers.flat.length > 0 ? (
        <p className="money-card__note" data-testid="movers-flat">
          {t('Movers flat', { assets: movers.flat.map((row) => row.asset).join(', ') })}
        </p>
      ) : null}
      {movers.unranked.length > 0 ? (
        <p className="money-card__note" data-testid="movers-unranked">
          {t('Movers unranked', { assets: movers.unranked.join(', ') })}
        </p>
      ) : null}
    </section>
  );
}
