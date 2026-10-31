import type { Resource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import { PortalLoading } from '../components';
import { EntityList } from '../ui/EntityList';
import { MoneyText } from '../ui/MoneyText';
import { MoneyFailure } from './common';
import { mc } from './copy';
import type { SettlementAssets } from './settlement-assets-api';

type Row = { assetCode: string; clearing: string; available: string };

/**
 * J-merchant-07 #1: every balance, once per asset. The assets the business holds come from the snapshot; each other
 * asset it can settle in comes from svc-pay's own list, with the ledger's figures (a new business reads 0 for each).
 * A list that is not set, or a ledger that cannot be read, is a refusal in words, never a zero.
 */
export function AllBalances({
  held,
  enabled,
  retry,
  test,
}: {
  held: readonly Row[];
  enabled: Resource<SettlementAssets>;
  retry: () => void;
  test: boolean;
}) {
  const { t } = mc.useCopy();
  // Two reads merge here: `held` is the snapshot's (assets the business has held), `enabled` is the settlement-assets
  // read (every asset it settles in, from the ledger), each read at its own moment. A held asset keeps the snapshot's
  // figures; only an asset the snapshot lacks is taken from the second read, so no asset is listed twice.
  const extra = enabled.status === 'ready' ? enabled.data.assets.filter((a) => !held.some((h) => h.assetCode === a.assetCode)) : [];
  const rows = [...held, ...extra];
  return (
    <PaySection title={t('balAllTitle')} description={held.length === 0 && enabled.status === 'ready' ? t('balAllZeroBody') : undefined}>
      {rows.length > 0 && (
        <EntityList
          label={t('balAllTitle')}
          rows={rows}
          rowKey={(b) => b.assetCode}
          columns={[
            { header: t('colAsset'), cell: (b) => b.assetCode },
            { header: t('balAvailable'), cell: (b) => <MoneyText value={b.available} asset={b.assetCode} test={test} /> },
            { header: t('balClearing'), cell: (b) => <MoneyText value={b.clearing} asset={b.assetCode} test={test} /> },
          ]}
          card={(b) => ({
            title: b.assetCode,
            amount: <MoneyText value={b.available} asset={b.assetCode} test={test} />,
            status: (
              <span className="muted">
                {t('balClearing')} <MoneyText value={b.clearing} asset={b.assetCode} test={test} />
              </span>
            ),
          })}
        />
      )}
      {enabled.status === 'loading' && held.length === 0 && <PortalLoading rows={2} />}
      {enabled.status === 'failed' && <MoneyFailure result={enabled.failure} retry={retry} />}
    </PaySection>
  );
}
