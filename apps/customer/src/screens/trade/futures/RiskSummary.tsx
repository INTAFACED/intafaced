import { FreshnessChip } from '@intafaced/ui/lit/templates';
import type { Position } from '@intafaced/exchange-contract/schemas';
import type { BalanceEntry } from '../../../data/derive';
import { UNKNOWN, fmtAmount } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { STALE_AFTER_MS, type MarginCalls } from './data';
import { deskCopy } from './desk-copy';
import { totalsOf, worstHealth } from './model';

/** Free balance of one asset, or null when balances are not known. */
export function freeOf(balances: Loadable<Record<string, BalanceEntry>>, asset: string): string | null {
  return balances.status === 'ready' ? (balances.data[asset]?.free ?? '0') : null;
}

interface Props {
  asset: string;
  positions: Loadable<Position[]>;
  balances: Loadable<Record<string, BalanceEntry>>;
  calls: Loadable<MarginCalls>;
  now: number;
}

/**
 * Account risk under the ticket (Binance margin-ratio panel). Every figure is a sum of published position fields; one unknown
 * input makes the whole figure "—" (never a partial sum). Health band is the worst across live positions.
 */
export function RiskSummary({ asset, positions, balances, calls, now }: Props) {
  const { t } = deskCopy.useCopy();
  const list = positions.status === 'ready' ? positions.data : null;
  const totals = list ? totalsOf(list) : null;
  const worst = list ? worstHealth(list) : null;
  const open = calls.status === 'ready' ? Object.values(calls.data).filter((c) => c !== null).length : null;
  const bandWords = {
    ok: t('Band ok'),
    watch: t('Band watch'),
    danger: t('Band danger'),
    liquidation: t('Band liquidation'),
    unknown: t('Band unknown'),
  } as const;
  const money = (v: string | null | undefined) => (v === null || v === undefined ? UNKNOWN : `${fmtAmount(v, { places: 4 })} ${asset}`);
  return (
    <section aria-label={t('Risk summary')} className="lt-panel">
      <div className="lt-panel-head">
        <h2 className="lt-panel-title">{t('Risk summary')}</h2>
        <FreshnessChip
          asOf={positions.status === 'ready' ? positions.asOf : null}
          now={now}
          staleAfterMs={STALE_AFTER_MS.positions}
          refused={positions.status === 'refused' || positions.status === 'error'}
        />
      </div>
      <dl className="lt-stats">
        {[
          [t('Free balance'), money(freeOf(balances, asset))],
          [t('Margin posted'), money(totals?.collateral)],
          [t('Unrealised PnL'), money(totals?.unrealizedPnl)],
          [t('Open positions'), totals ? String(totals.count) : UNKNOWN],
          [t('Worst margin ratio'), worst && worst.marginRatioPct ? `${worst.marginRatioPct}% · ${bandWords[worst.band]}` : UNKNOWN],
          [t('Margin calls open'), open === null ? UNKNOWN : String(open)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="lt-num">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="lt-note">{t('Risk unknown hint')}</p>
    </section>
  );
}
