import { Button, EmptyState } from '@intafaced/ui';
import { navigate } from '../../../app/location';
import { tabsCopy } from './tabs-copy';

const SPOT_DESK = '/trade/spot/BTC-USDT';

/** Futures rests no orders (positions open and close at the accepted mark). The tab says so and points to where orders live. */
export function OrdersTab() {
  const { t } = tabsCopy.useCopy();
  return (
    <section className="flex flex-col items-center gap-2 pb-4">
      <EmptyState variant="unavailable" title={t('Orders title')} reason={t('Orders reason')} />
      <Button
        variant="secondary"
        size={32}
        nativeButton={false}
        render={
          <a
            href={SPOT_DESK}
            onClick={(event) => {
              // Plain clicks stay inside the app; modified clicks keep the browser's own new-tab behaviour.
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate(SPOT_DESK);
            }}
          />
        }
      >
        {t('Orders link')}
      </Button>
    </section>
  );
}
