import { AssetIcon } from '@intafaced/ui/lit';
import { fmtChangeLine } from './deps';
import { moneyCopy } from './copy';
import { ChangeLine, signOf } from './money-parts';
import { moversOf } from './movers-model';
import type { MoneyRow, MoneyView } from './portfolio-source';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

/** The words a change's direction is read out in. */
export function spokenOf(copy: Copy): Record<'up' | 'down' | 'flat', string> {
  return { up: copy.t('Up'), down: copy.t('Down'), flat: copy.t('No change') };
}

function MoverList({
  title,
  rows,
  empty,
  hidden,
  side,
  copy,
}: {
  title: string;
  rows: MoneyRow[];
  empty: string;
  hidden: boolean;
  side: string;
  copy: Copy;
}) {
  return (
    <div className="lt-stack" data-side={side}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="lt-hint">{empty}</p>
      ) : (
        <ol className="lt-rows">
          {rows.map((row) => (
            <li key={row.asset} data-asset={row.asset}>
              <span className="lt-actions">
                <AssetIcon asset={row.asset} size="sm" />
                <span>{row.asset}</span>
                <ChangeLine
                  text={fmtChangeLine(row.usdChange24h, row.changeRatio)}
                  sign={signOf(row.usdChange24h)}
                  hidden={hidden}
                  spoken={spokenOf(copy)}
                />
              </span>
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
    <section id="movers" data-testid="money-card" className="lt-stack" aria-labelledby="money-movers-title">
      <header data-testid="money-card__head" className="lt-title-row">
        <h2 id="money-movers-title">{t('Movers')}</h2>
        <span className="lt-hint">{sinceLabel}</span>
      </header>
      <p className="lt-hint">{t('Movers note')}</p>
      <div className="lt-figures">
        <MoverList title={t('Best')} side="best" rows={movers.best} empty={t('None rose')} hidden={hidden} copy={copy} />
        <MoverList title={t('Worst')} side="worst" rows={movers.worst} empty={t('None fell')} hidden={hidden} copy={copy} />
      </div>
      {movers.flat.length > 0 ? (
        <p className="lt-hint" data-testid="movers-flat">
          {t('Movers flat', { assets: movers.flat.map((row) => row.asset).join(', ') })}
        </p>
      ) : null}
      {movers.unranked.length > 0 ? (
        <p className="lt-hint" data-testid="movers-unranked">
          {t('Movers unranked', { assets: movers.unranked.join(', ') })}
        </p>
      ) : null}
    </section>
  );
}
