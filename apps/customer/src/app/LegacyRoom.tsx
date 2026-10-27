import { lazy, Suspense } from 'react';
import { RoomLoading } from '../shared/ui';
import { appCopy } from './app-copy';

const TradeRoutes = lazy(() => import('../features/trade').then((module) => ({ default: module.TradeRoutes })));
const PayRoutes = lazy(() => import('../features/pay').then((module) => ({ default: module.PayRoutes })));
const MoneyRoutes = lazy(() => import('../features/money').then((module) => ({ default: module.MoneyRoutes })));
export const preloadAccountRoutes = () => import('../features/account/AccountRoutes').then((module) => ({ default: module.AccountRoutes }));
const AccountRoutes = lazy(preloadAccountRoutes);
const MoreRoutes = lazy(() => import('../features/more').then((module) => ({ default: module.MoreRoutes })));

export type LegacyArea = 'money' | 'trade' | 'pay' | 'more' | 'person';

/**
 * Renders an old view inside the new shell. Its element selectors (`button`, `a`, `h1`, `table`, …)
 * are scoped to `.legacy-room` in `shared/styles.css`, so they cannot reach new screens.
 * `path` is the OLD route path plus query (for example `/exchange/BTC-USDT`), because the old views read it.
 */
export function LegacyRoom({ area, path }: { area: LegacyArea; path: string }) {
  const { t } = appCopy.useCopy();
  const view =
    area === 'money' ? (
      <MoneyRoutes path={path} />
    ) : area === 'trade' ? (
      <TradeRoutes path={path} />
    ) : area === 'pay' ? (
      <PayRoutes path={path} />
    ) : area === 'more' ? (
      <MoreRoutes path={path} />
    ) : (
      <AccountRoutes path={path} />
    );
  return (
    <div className={area === 'pay' ? 'if-business' : 'legacy-room'}>
      <Suspense
        fallback={
          <div data-testid="page" className="page">
            <RoomLoading label={t('Opening room')} />
          </div>
        }
      >
        {view}
      </Suspense>
    </div>
  );
}
