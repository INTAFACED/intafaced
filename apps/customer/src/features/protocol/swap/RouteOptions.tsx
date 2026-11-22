import type { ProtocolRouteLeg, ProtocolRouteOptions, ProtocolSwapToken } from '@intafaced/contracts/protocol-swap';
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
    return leg.reason === 'stale' ? t('routeStale') : leg.reason === 'unreadable' ? t('routeUnreadable') : t('routeNoLiquidity');
  };
  const headers = [t('routePool'), t('routeFee'), t('routeOut'), t('routeStatus'), t('routeExclude')];
  const isExcluded = (pool: string) => excluded.some((item) => item.toLowerCase() === pool.toLowerCase());
  return (
    <>
      <p>{t('routesNote', { block: routes.blockNumber })}</p>
      <div tabIndex={0} role="region" aria-label={t('routesTitle')}>
        <table className="lt-table">
          <thead>
            <tr>
              {headers.map((head) => (
                <th key={head} scope="col">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {routes.legs.map((leg) => (
              <tr key={leg.pool} data-route-status={leg.status}>
                <td data-label={headers[0]} className="lt-mono">
                  {shortContract(leg.pool)}
                </td>
                <td data-label={headers[1]}>{bpsToPercent(leg.feeBps)}%</td>
                <td data-label={headers[2]}>
                  {leg.quote === null ? '—' : `${formatUnits(BigInt(leg.quote.amountOut), tokenOut.decimals)} ${tokenOut.name}`}
                </td>
                <td data-label={headers[3]}>{status(leg)}</td>
                <td data-label={headers[4]}>
                  <label>
                    <input type="checkbox" checked={isExcluded(leg.pool)} onChange={(event) => onExclude(leg.pool, event.target.checked)} />{' '}
                    {t('routeExclude')}
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
