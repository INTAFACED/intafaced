import type { PricedProduct } from '@intafaced/contracts/merchant-catalog';
import { useResource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { PortalLoading, SelectField } from '../components';
import { catalogCopy as c } from './copy';
import { priceWords } from './Prices';

/**
 * The catalogue price a new payment link sells (M-catalogue-03, J-merchant-04 step 2). Offered are the active one-time
 * fixed prices of active products, newest first: a link takes one payment of one amount. Picking one sets the link's
 * amount and asset to the price's; picking none leaves them to the form. The choice is optional.
 */
export function LinkPricePicker({
  portal,
  value,
  onChange,
  disabled,
}: {
  portal: PortalApi;
  value: string;
  onChange: (choice: PricedProduct | null) => void;
  disabled?: boolean;
}) {
  const { t } = c.useCopy();
  const { resource, reload } = useResource((signal) => portal.linkPriceChoices(signal), 'portal:catalog:link-prices');
  if (resource.status === 'loading') return <PortalLoading />;
  // The price is optional, so a catalogue that cannot be read (a role without products.read, say) leaves the form usable:
  // the field says why it is empty, and the amount is set by hand.
  if (resource.status === 'failed')
    return (
      <div className="field">
        <span>{t('linkPrice')}</span>
        <p className="muted" role="note">
          {t('linkPriceUnreadable', { reason: resource.failure.message })}{' '}
          <button type="button" className="text-link" onClick={reload}>
            {t('linkPriceRetry')}
          </button>
        </p>
      </div>
    );
  const choices = resource.data.items;
  if (choices.length === 0 && !value) return <p className="muted">{t('linkPriceNoChoices')}</p>;
  // A create being recovered keeps the price it was sent with, even once that price is no longer offered.
  const kept = value && !choices.some((choice) => choice.price.id === value) ? [[value, t('linkPriceKept')] as const] : [];
  return (
    <SelectField
      label={t('linkPrice')}
      hint={resource.data.more ? `${t('linkPriceHint')} ${t('linkPriceMore', { count: choices.length })}` : t('linkPriceHint')}
      value={value}
      disabled={disabled}
      onChange={(id) => (id === value ? undefined : onChange(choices.find((choice) => choice.price.id === id) ?? null))}
      options={[
        ['', t('linkPriceNone')],
        ...kept,
        ...choices.map(
          (choice) => [choice.price.id, t('linkPriceOption', { product: choice.product.name, price: priceWords(choice.price) })] as const,
        ),
      ]}
    />
  );
}
