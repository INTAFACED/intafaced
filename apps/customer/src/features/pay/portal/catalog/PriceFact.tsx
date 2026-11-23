import { useResource } from '../../../../shared/resource';
import type { PricedProduct } from '@intafaced/contracts/merchant-catalog';
import type { PortalApi } from '../api';
import { Failure, Loading } from '../volt/parts';
import { catalogCopy as c } from './copy';
import { priceWords } from './Prices';

/** A catalogue price in words with its product: "TEST Tote bag · 25.00 USDC". */
export const pricedProductText = ({ price, product }: PricedProduct) =>
  c.t('subPriceOption', { product: product.name, price: priceWords(price) });

/**
 * The price a subscription or a payment link runs on, read by its id: archived prices and archived products still read,
 * and say so, so a subscription started before a replacement still names what it was sold at.
 */
export function SubscriptionPriceFact({ portal, priceId }: { portal: PortalApi; priceId: string | null | undefined }) {
  const { t } = c.useCopy();
  const { resource, reload } = useResource(
    (signal) => (priceId ? portal.pricedProduct(priceId, signal) : Promise.resolve({ ok: true as const, data: null })),
    `portal:catalog:subscription-price:${priceId ?? 'none'}`,
  );
  if (!priceId) return <>{t('subPriceNoneFact')}</>;
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const read = resource.data;
  if (!read) return <>{t('subPriceNoneFact')}</>;
  const marks = [
    ...(read.price.status === 'archived' ? [t('subPriceArchived')] : []),
    ...(read.product.status === 'archived' ? [t('subPriceProductArchived')] : []),
  ];
  return (
    <a className="lt-link" href={`/pay/products/${encodeURIComponent(read.product.id)}`}>
      {pricedProductText(read)}
      {marks.length > 0 && ` (${marks.join(', ')})`}
    </a>
  );
}
