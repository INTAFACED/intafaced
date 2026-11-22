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
  const { monthly, resource, reload } = useSubscriptionPriceChoices(portal, mandate);
  if (!monthly) return <p className="muted">{t('subPriceNotMonthly')}</p>;
  if (resource.status === 'loading') return <PortalLoading />;
  if (resource.status === 'failed') return <PortalFailure result={resource.failure} retry={reload} />;
  const choices = resource.data?.items ?? [];
  if (choices.length === 0 && !value) return <p className="muted">{t('subPriceNoMatch')}</p>;
  return (
    <SelectField
      label={t('subPrice')}
      hint={t('subPriceHint')}
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={subscriptionPriceOptions(choices, value, t)}
    />
  );
}

/**
 * The picker's read: the catalogue's matching monthly prices, asked only for a monthly mandate. The portal's picker
 * above and its kit view (`../flow/subscription-parts.tsx`) both run this.
 */
export function useSubscriptionPriceChoices(portal: PortalApi, mandate: { id: string; assetId: string; amount: string; cadence: string }) {
  const monthly = mandate.cadence === 'monthly';
  const { resource, reload } = useResource(
    (signal) =>
      monthly ? portal.monthlyPriceChoices(mandate.assetId, mandate.amount, signal) : Promise.resolve({ ok: true as const, data: null }),
    `portal:catalog:subscription-prices:${mandate.id}`,
  );
  return { monthly, resource, reload };
}

/** The picker's choices: none, the price a recovered create was sent with, then each offered price. */
export function subscriptionPriceOptions(
  choices: readonly PricedProduct[],
  value: string,
  t: ReturnType<typeof c.useCopy>['t'],
): ReadonlyArray<readonly [string, string]> {
  // A create being recovered keeps the price it was sent with, even once that price is no longer offered: the select
  // says so rather than showing "No catalogue price" over a request that names one.
  const kept = value && !choices.some((choice) => choice.price.id === value) ? [[value, t('subPriceKept')] as const] : [];
  return [['', t('subPriceNone')], ...kept, ...choices.map((choice) => [choice.price.id, optionText(choice)] as const)];
}

export const optionText = ({ price, product }: PricedProduct) => c.t('subPriceOption', { product: product.name, price: priceWords(price) });

/** The label of the subscription fact below, in the catalogue's words. */
export const subscriptionPriceLabel = () => c.t('subPriceFact');

/**
 * The price a subscription runs on, read by its id: archived prices and archived products still read, and say so, so a
 * subscription started before a replacement still names what it was sold at.
 */
export function SubscriptionPriceFact({ portal, priceId }: { portal: PortalApi; priceId: string | null | undefined }) {
  const { t } = c.useCopy();
  const { resource, reload } = useSubscriptionPriceRead(portal, priceId);
  if (!priceId) return <>{t('subPriceNoneFact')}</>;
  if (resource.status === 'loading') return <PortalLoading />;
  if (resource.status === 'failed') return <PortalFailure result={resource.failure} retry={reload} />;
  const read = resource.data;
  if (!read) return <>{t('subPriceNoneFact')}</>;
  const marks = subscriptionPriceMarks(read, t);
  return (
    <a className="text-link" href={`/pay/products/${encodeURIComponent(read.product.id)}`}>
      {optionText(read)}
      {marks.length > 0 && ` (${marks.join(', ')})`}
    </a>
  );
}

/** The fact's read: the price by its id, archived ones included. The fact above and its kit view both run this. */
export function useSubscriptionPriceRead(portal: PortalApi, priceId: string | null | undefined) {
  return useResource(
    (signal) => (priceId ? portal.pricedProduct(priceId, signal) : Promise.resolve({ ok: true as const, data: null })),
    `portal:catalog:subscription-price:${priceId ?? 'none'}`,
  );
}

/** What the fact adds after the price when it or its product is archived. */
export function subscriptionPriceMarks(read: PricedProduct, t: ReturnType<typeof c.useCopy>['t']): string[] {
  return [
    ...(read.price.status === 'archived' ? [t('subPriceArchived')] : []),
    ...(read.product.status === 'archived' ? [t('subPriceProductArchived')] : []),
  ];
}
