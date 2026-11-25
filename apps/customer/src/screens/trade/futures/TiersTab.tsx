import { Amount } from '@intafaced/ui/lit';
import { Table, type Column } from '@intafaced/ui/lit/templates';
import { fmtAmount, fmtPct, fmtPctPoints } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import type { RiskTiers } from './api';
import { LoadGate, TabHeader } from './HistoryTab';
import { riskCopy } from './risk-copy';
import { tabsCopy } from './tabs-copy';
import { percentOfBps } from './tabs-logic';
import { RegionNote } from './notes';

type TierRow = RiskTiers['tiers'][number];

/**
 * The owner's maintenance tiers for the chosen contract (D-margin-03). While the ladder is unset the read refuses
 * `trade.ladder_unset` and this says "Tiers not published": opens refuse on the same code, so nothing here is a default.
 */
export function TiersTab({ tiers, quote }: { tiers: Loadable<RiskTiers>; quote: string }) {
  const { t } = riskCopy.useCopy();
  const tabs = tabsCopy.useCopy();
  const notional = (value: string | null, last: boolean) =>
    last ? t('Tier any size') : value === null ? t('Tier no depth') : `${fmtAmount(value, { places: 2 })} ${quote}`;

  const columns: Column<TierRow>[] = [
    { key: 'tier', label: t('Tier col'), cell: (row) => String(row.tier) },
    {
      key: 'share',
      label: t('Tier share col'),
      align: 'end',
      cell: (row) =>
        row.uptoDepthBps === null ? t('Tier any size') : fmtPctPoints(percentOfBps(row.uptoDepthBps), { places: 2, signed: false }),
    },
    {
      key: 'long',
      label: t('Tier long col'),
      align: 'end',
      cell: (row) => <Amount value={notional(row.notionalUpto.long, row.uptoDepthBps === null)} />,
    },
    {
      key: 'short',
      label: t('Tier short col'),
      align: 'end',
      cell: (row) => <Amount value={notional(row.notionalUpto.short, row.uptoDepthBps === null)} />,
    },
    { key: 'rate', label: t('Tier rate col'), align: 'end', cell: (row) => fmtPct(row.maintenanceRate, { places: 2, signed: false }) },
  ];

  return (
    <section aria-label={t('Tiers heading')} className="lt-stack">
      <TabHeader title={t('Tiers heading')} load={tiers} />
      <LoadGate
        load={tiers}
        thing={t('Thing tiers')}
        refused={(code) =>
          code === 'trade.ladder_unset' ? (
            <RegionNote variant="unavailable" title={t('Tiers unset title')} reason={t('Tiers unset reason')} code={code} />
          ) : null
        }
      >
        {(data) => (
          <>
            <Table
              caption={t('Tiers table')}
              mode="pro"
              dense
              columns={columns}
              rows={data.tiers}
              rowKey={(row) => String(row.tier)}
              empty={<RegionNote title={tabs.t('Nothing to show')} />}
            />
            <p className="lt-note">
              {data.maxLeverage === null ? t('Tiers leverage unset') : t('Tiers leverage note', { cap: fmtAmount(data.maxLeverage) })}
            </p>
            <p className="lt-note">
              {data.formula}. {t('Tiers basis')}
            </p>
          </>
        )}
      </LoadGate>
    </section>
  );
}
