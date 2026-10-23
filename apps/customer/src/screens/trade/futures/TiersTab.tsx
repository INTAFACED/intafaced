import { Amount, EmptyState, Table, type TableColumn } from '@intafaced/ui';
import { fmtAmount, fmtPct, fmtPctPoints } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import type { RiskTiers } from './api';
import { LoadGate, TabHeader } from './HistoryTab';
import { riskCopy } from './risk-copy';
import { percentOfBps } from './tabs-logic';

type TierRow = RiskTiers['tiers'][number];

/**
 * The owner's maintenance tiers for the chosen contract (D-margin-03). While the ladder is unset the read refuses
 * `trade.ladder_unset` and this says "Tiers not published": opens refuse on the same code, so nothing here is a default.
 */
export function TiersTab({ tiers, quote }: { tiers: Loadable<RiskTiers>; quote: string }) {
  const { t } = riskCopy.useCopy();
  const notional = (value: string | null, last: boolean) =>
    last ? t('Tier any size') : value === null ? t('Tier no depth') : `${fmtAmount(value, { places: 2 })} ${quote}`;

  const columns: TableColumn<TierRow>[] = [
    { id: 'tier', header: t('Tier col'), value: (row) => String(row.tier) },
    {
      id: 'share',
      header: t('Tier share col'),
      numeric: true,
      value: (row) =>
        row.uptoDepthBps === null ? t('Tier any size') : fmtPctPoints(percentOfBps(row.uptoDepthBps), { places: 2, signed: false }),
    },
    {
      id: 'long',
      header: t('Tier long col'),
      numeric: true,
      cell: (row) => <Amount value={notional(row.notionalUpto.long, row.uptoDepthBps === null)} />,
    },
    {
      id: 'short',
      header: t('Tier short col'),
      numeric: true,
      cell: (row) => <Amount value={notional(row.notionalUpto.short, row.uptoDepthBps === null)} />,
    },
    { id: 'rate', header: t('Tier rate col'), numeric: true, value: (row) => fmtPct(row.maintenanceRate, { places: 2, signed: false }) },
  ];

  return (
    <section aria-label={t('Tiers heading')} className="flex flex-col">
      <TabHeader title={t('Tiers heading')} load={tiers} />
      <LoadGate
        load={tiers}
        thing={t('Thing tiers')}
        refused={(code) =>
          code === 'trade.ladder_unset' ? (
            <EmptyState variant="unavailable" size="inline" title={t('Tiers unset title')} reason={t('Tiers unset reason')} code={code} />
          ) : null
        }
      >
        {(data) => (
          <>
            <Table label={t('Tiers table')} density="dense" columns={columns} rows={data.tiers} getRowId={(row) => String(row.tier)} />
            <p className="m-0 px-3 pt-2 text-xs text-fg-2">
              {data.maxLeverage === null ? t('Tiers leverage unset') : t('Tiers leverage note', { cap: fmtAmount(data.maxLeverage) })}
            </p>
            <p className="m-0 px-3 pb-2 text-xs text-fg-2">
              {data.formula}. {t('Tiers basis')}
            </p>
          </>
        )}
      </LoadGate>
    </section>
  );
}
