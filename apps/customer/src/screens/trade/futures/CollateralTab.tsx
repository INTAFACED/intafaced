import { Amount, EmptyState, Table, type TableColumn } from '@intafaced/ui';
import { fmtAmount } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import type { Collateral } from './api';
import { LoadGate, TabHeader } from './HistoryTab';
import { futuresRefusal } from './refusals';
import { riskCopy } from './risk-copy';
import { percentOfBps } from './tabs-logic';

type CashRow = Collateral['assets'][number];

const REFUSED_NAMES = {
  yield_bearing: 'Refused yield_bearing',
  staked: 'Refused staked',
  lending_idle: 'Refused lending_idle',
} as const;

/**
 * What counts as futures margin for this account (D-margin-02): cash in each settle asset with the platform's haircut
 * and the buying power it leaves, then the balances that are never taken as margin with the rule that refuses them.
 * A blank haircut reads "Haircut not set" and buying power says so: nothing is shown as if it were 0.
 */
export function CollateralTab({ collateral }: { collateral: Loadable<Collateral> }) {
  const { t } = riskCopy.useCopy();
  const money = (value: string, asset: string) => `${fmtAmount(value, { places: 8 })} ${asset}`;

  const columns: TableColumn<CashRow>[] = [
    { id: 'asset', header: t('Collateral asset'), value: (row) => row.asset },
    { id: 'class', header: t('Collateral class'), value: () => t('Collateral cash') },
    {
      id: 'haircut',
      header: t('Collateral haircut'),
      numeric: true,
      value: (row) => (row.haircutBps === null ? t('Collateral haircut unset') : `${percentOfBps(row.haircutBps)}%`),
    },
    { id: 'free', header: t('Collateral free'), numeric: true, cell: (row) => <Amount value={money(row.free, row.asset)} /> },
    { id: 'posted', header: t('Collateral posted'), numeric: true, cell: (row) => <Amount value={money(row.posted, row.asset)} /> },
    {
      id: 'committed',
      header: t('Collateral committed'),
      numeric: true,
      cell: (row) => <Amount value={money(row.committed, row.asset)} />,
    },
    {
      id: 'power',
      header: t('Collateral buying power'),
      numeric: true,
      cell: (row) => <Amount value={row.buyingPower === null ? t('Collateral buying power unset') : money(row.buyingPower, row.asset)} />,
    },
  ];

  return (
    <section aria-label={t('Collateral heading')} className="flex flex-col">
      <TabHeader title={t('Collateral heading')} load={collateral} />
      <LoadGate load={collateral} thing={t('Thing collateral')}>
        {(data) => (
          <>
            <Table
              label={t('Collateral table')}
              density="dense"
              columns={columns}
              rows={data.assets}
              getRowId={(row) => row.asset}
              emptyState={<EmptyState size="inline" title={t('Collateral table')} />}
            />
            <p className="m-0 px-3 pt-2 text-xs text-fg-2">{t('Collateral note')}</p>
            {data.assets.some((row) => row.haircutBps === null) ? (
              <p role="status" className="m-0 px-3 pt-1 text-xs text-warn" data-code="trade.haircut_unset">
                {t('Collateral unset note')}
              </p>
            ) : null}
            <h4 className="m-0 px-3 pt-3 text-xs font-medium text-fg">{t('Refused heading')}</h4>
            <ul aria-label={t('Refused heading')} className="m-0 flex list-none flex-col gap-1 px-3 pb-2 pt-1">
              {data.refusedClasses.map((r) => {
                const words = futuresRefusal({ code: r.code ?? undefined });
                const name = REFUSED_NAMES[r.collateralClass as keyof typeof REFUSED_NAMES];
                return (
                  <li key={r.collateralClass} className="text-xs text-fg-2" data-code={r.code ?? undefined}>
                    <span className="text-fg">{name ? t(name) : r.collateralClass}</span>: {words.title}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </LoadGate>
    </section>
  );
}
