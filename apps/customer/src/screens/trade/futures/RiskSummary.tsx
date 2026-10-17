import { StatusChip } from '@intafaced/ui';
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
    <section aria-label={t('Risk summary')} className="flex flex-col gap-2 border-t border-line px-4 py-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg">{t('Risk summary')}</h2>
        <StatusChip
          asOf={positions.status === 'ready' ? positions.asOf : null}
          now={now}
          staleAfterMs={STALE_AFTER_MS.positions}
          refused={positions.status === 'refused' || positions.status === 'error'}
        />
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          [t('Free balance'), money(freeOf(balances, asset))],
          [t('Margin posted'), money(totals?.collateral)],
          [t('Unrealised PnL'), money(totals?.unrealizedPnl)],
          [t('Open positions'), totals ? String(totals.count) : UNKNOWN],
          [t('Worst margin ratio'), worst && worst.marginRatioPct ? `${worst.marginRatioPct}% · ${bandWords[worst.band]}` : UNKNOWN],
          [t('Margin calls open'), open === null ? UNKNOWN : String(open)],
        ].map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-fg-2">{label}</dt>
            <dd className="if-num truncate text-base text-fg">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-fg-2">{t('Risk unknown hint')}</p>
    </section>
  );
}
