import { useResource } from '../../../../shared/resource';
import type { PricedProduct } from '@intafaced/contracts/merchant-catalog';
import type { PortalApi } from '../api';
import { PortalFailure, PortalLoading, SelectField } from '../components';
import { catalogCopy as c } from './copy';
import { priceWords } from './Prices';

/**
 * The catalogue price a subscription starts on (M-adv-payments-core-20, J-merchant-03 step 4). Offered are the active
 * monthly fixed prices of active products whose asset and amount are the chosen mandate's, since what a subscription
 * charges is its mandate's amount; an archived product or a replaced price is never offered. The choice is optional.
 */
export function SubscriptionPricePicker({
  portal,
  mandate,
  value,
  onChange,
  disabled,
}: {
  portal: PortalApi;
  mandate: { id: string; assetId: string; amount: string; cadence: string };
  value: string;
  onChange: (priceId: string) => void;
  disabled?: boolean;
}) {
  const { t } = c.useCopy();
  const monthly = mandate.cadence === 'monthly';
  const { resource, reload } = useResource(
    (signal) =>
      monthly ? portal.monthlyPriceChoices(mandate.assetId, mandate.amount, signal) : Promise.resolve({ ok: true as const, data: null }),
    `portal:catalog:subscription-prices:${mandate.id}`,
  );
  if (!monthly) return <p className="muted">{t('subPriceNotMonthly')}</p>;
  if (resource.status === 'loading') return <PortalLoading />;
  if (resource.status === 'failed') return <PortalFailure result={resource.failure} retry={reload} />;
  const choices = resource.data?.items ?? [];
  if (choices.length === 0 && !value) return <p className="muted">{t('subPriceNoMatch')}</p>;
  // A create being recovered keeps the price it was sent with, even once that price is no longer offered: the select
  // says so rather than showing "No catalogue price" over a request that names one.
  const kept = value && !choices.some((choice) => choice.price.id === value) ? [[value, t('subPriceKept')] as const] : [];
  return (
    <SelectField
      label={t('subPrice')}
      hint={t('subPriceHint')}
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={[['', t('subPriceNone')], ...kept, ...choices.map((choice) => [choice.price.id, optionText(choice)] as const)]}
    />
  );
}

const optionText = ({ price, product }: PricedProduct) => c.t('subPriceOption', { product: product.name, price: priceWords(price) });

/** The label of the subscription fact below, in the catalogue's words. */
export const subscriptionPriceLabel = () => c.t('subPriceFact');

/**
 * The price a subscription runs on, read by its id: archived prices and archived products still read, and say so, so a
 * subscription started before a replacement still names what it was sold at.
 */
export function SubscriptionPriceFact({ portal, priceId }: { portal: PortalApi; priceId: string | null | undefined }) {
  const { t } = c.useCopy();
  const { resource, reload } = useResource(
    (signal) => (priceId ? portal.pricedProduct(priceId, signal) : Promise.resolve({ ok: true as const, data: null })),
    `portal:catalog:subscription-price:${priceId ?? 'none'}`,
  );
  if (!priceId) return <>{t('subPriceNoneFact')}</>;
  if (resource.status === 'loading') return <PortalLoading />;
  if (resource.status === 'failed') return <PortalFailure result={resource.failure} retry={reload} />;
  const read = resource.data;
  if (!read) return <>{t('subPriceNoneFact')}</>;
  const marks = [
    ...(read.price.status === 'archived' ? [t('subPriceArchived')] : []),
    ...(read.product.status === 'archived' ? [t('subPriceProductArchived')] : []),
  ];
  return (
    <a className="text-link" href={`/pay/products/${encodeURIComponent(read.product.id)}`}>
      {optionText(read)}
      {marks.length > 0 && ` (${marks.join(', ')})`}
    </a>
  );
}
