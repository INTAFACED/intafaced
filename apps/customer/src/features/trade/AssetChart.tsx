import { CopyText } from './copy';
import { useMemo } from 'react';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { EmptyState, Failure, Loading } from '../../shared/ui';
import { createTradeApi } from './trade-api';
import { MarketChart } from './Chart';
import './trade.css';

export function AssetChart({ asset, symbol }: { asset: string; symbol?: string }) {
  const transport = useApi(),
    api = useMemo(() => createTradeApi(transport), [transport]),
    { userId } = useSession();
  const catalogue = useResource((signal) => api.markets(signal), `asset-chart:${asset}:${symbol ?? ''}`);
  if (catalogue.resource.status === 'loading') return <Loading label={<CopyText k={'loadingAssetMarkets'} />} />;
  if (catalogue.resource.status === 'failed') return <Failure result={catalogue.resource.failure} retry={catalogue.reload} />;
  const market = catalogue.resource.data.find((row) => row.spot && !row.paper && (symbol ? row.symbol === symbol : row.base === asset));
  if (!market)
    return (
      <EmptyState title={<CopyText k={'noPublishedMarketHistory'} />}>
        <CopyText k="thisHoldingHasNoPublishedLiveSpotMarketToSupplyIts" />
      </EmptyState>
    );
  return (
    <div className="asset-chart">
      <MarketChart
        key={`${market.id}:${userId ?? 'signed-out'}`}
        api={api}
        market={market}
        orders={[]}
        accountKey={userId ?? 'signed-out'}
        onStagePrice={() => {
          location.href = `/exchange?asset=${encodeURIComponent(asset)}`;
        }}
      />
    </div>
  );
}
