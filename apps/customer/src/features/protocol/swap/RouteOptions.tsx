import type { ProtocolRouteLeg, ProtocolRouteOptions, ProtocolSwapToken } from '@intafaced/contracts/protocol-swap';
import { DataTable } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { shortContract } from '../wallet/transfer';
import { swapCopy } from './copy';
import { bpsToPercent, formatUnits } from './swap-math';

/**
 * Manual mode's "Route options" (J-dex-protocol-02 #4): every factory pool for the pair, as the service ranked them for
 * this amount at one block. Nothing is dropped: the best leg leads, each other usable leg says how much less it gives,
 * an excluded pool keeps its row, and a pool that cannot be used says why. Excluding a pool re-reads the quote without it.
 */
export function RouteOptions({
  routes,
  tokenOut,
  excluded,
  onExclude,
}: {
  routes: ProtocolRouteOptions;
  tokenOut: ProtocolSwapToken;
  excluded: readonly string[];
  onExclude: (pool: string, out: boolean) => void;
}) {
  const { language } = usePreferences();
  const { t } = swapCopy.forLocale(language);
  const status = (leg: ProtocolRouteLeg): string => {
    if (leg.status === 'best') return t('routeBest');
    if (leg.status === 'excluded') return t('routeExcluded');
    if (leg.status === 'lost')
      return t('routeLost', { amount: formatUnits(BigInt(leg.shortfall ?? '0'), tokenOut.decimals), token: tokenOut.name });
    return leg.reason === 'stale' ? t('routeStale') : t('routeNoLiquidity');
  };
  const isExcluded = (pool: string) => excluded.some((item) => item.toLowerCase() === pool.toLowerCase());
  return (
    <>
      <p>{t('routesNote', { block: routes.blockNumber })}</p>
      <DataTable label={t('routesTitle')} headers={[t('routePool'), t('routeFee'), t('routeOut'), t('routeStatus'), t('routeExclude')]}>
        {routes.legs.map((leg) => (
          <tr key={leg.pool} data-route-status={leg.status}>
            <td className="numeric">{shortContract(leg.pool)}</td>
            <td className="numeric">{bpsToPercent(leg.feeBps)}%</td>
            <td className="numeric">
              {leg.amountOut === null ? '—' : `${formatUnits(BigInt(leg.amountOut), tokenOut.decimals)} ${tokenOut.name}`}
            </td>
            <td>{status(leg)}</td>
            <td>
              <label>
                <input type="checkbox" checked={isExcluded(leg.pool)} onChange={(event) => onExclude(leg.pool, event.target.checked)} />{' '}
                {t('routeExclude')}
              </label>
            </td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}
