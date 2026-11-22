import { useMemo, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { QrCode } from '@intafaced/ui/lit/templates';
import type { PricedProduct } from '@intafaced/contracts/merchant-catalog';
import { useResource } from '../../../../shared/resource';
import { encodeQr, qrPath } from '../../../../shared/qr';
import type { PortalApi } from '../api';
import { catalogCopy } from '../catalog/copy';
import { priceWords } from '../catalog/Prices';
import { layoutCopy } from '../home-layout/copy';
import { useCanShowExact } from '../presentation';
import { useExactMoneyScope } from '../ui/ExactMoneyScope';
import { formatMoney, isRounded } from '../ui/format';
import { paymentsCopy } from '../payments/copy';
import { isWebAddress } from '../payments/LinkAddress';
import { Actions, CopyReference, Loading, SelectField } from './parts';

/**
 * The payments flow rooms' kit views (Create link, Create invoice) of the portal parts `parts.tsx` lacks: the amount
 * with its "Show exact" (`components.tsx`'s `Money`), the catalogue price picker (`catalog/LinkPrice.tsx`) and a link's
 * checkout address (`payments/LinkAddress.tsx`). Each keeps its original's words, states, ids and handlers.
 */

/**
 * An amount and its asset code (`components.tsx`'s `Money`, drawn through `MoneyDisplay`): exact inside a review, with
 * "(exact)" when the compact figure would round; elsewhere compact, with a "Show exact" toggle on a page that offers it.
 */
export function ExactMoney({ value, asset }: { value: string; asset: string }) {
  const canShowExact = useCanShowExact();
  const inReview = useExactMoneyScope();
  const [exact, setExact] = useState(false);
  const { t } = layoutCopy.useCopy();
  const compact = formatMoney(value, asset);
  const full = formatMoney(value, asset, { exact: true });
  const unit = <span lang="zxx">{asset}</span>;
  if (inReview)
    return (
      <span className="lt-mono" data-money="">
        <span data-slot="amount" dir="ltr">
          {full}
        </span>{' '}
        {unit}
        {isRounded(value, asset) && <span> ({t('exactTag')})</span>}
      </span>
    );
  return (
    <span className="lt-mono" data-money="">
      <span data-slot="amount" dir="ltr">
        {exact && canShowExact ? full : compact}
      </span>
      {unit}
      {canShowExact && isRounded(value, asset) && (
        <Button tone="quiet" aria-pressed={exact} onClick={() => setExact(!exact)}>
          {t(exact ? 'hideExact' : 'showExact')}
        </Button>
      )}
    </span>
  );
}

/**
 * The catalogue price a new payment link sells (M-catalogue-03, J-merchant-04 step 2): `catalog/LinkPrice.tsx`'s
 * picker on the kit. Offered are the active one-time fixed prices of active products, newest first. Picking one sets the
 * link's amount and asset to the price's; picking none leaves them to the form. The choice is optional.
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
  const { t } = catalogCopy.useCopy();
  const { resource, reload } = useResource((signal) => portal.linkPriceChoices(signal), 'portal:catalog:link-prices');
  if (resource.status === 'loading') return <Loading />;
  // The price is optional, so a catalogue that cannot be read (a role without products.read, say) leaves the form usable:
  // the field says why it is empty, and the amount is set by hand.
  if (resource.status === 'failed')
    return (
      <div className="lt-field">
        <span>{t('linkPrice')}</span>
        <p className="lt-hint" role="note">
          {t('linkPriceUnreadable', { reason: resource.failure.message })}{' '}
          <Button tone="quiet" onClick={reload}>
            {t('linkPriceRetry')}
          </Button>
        </p>
      </div>
    );
  const choices = resource.data.items;
  if (choices.length === 0 && !value) return <p className="lt-hint">{t('linkPriceNoChoices')}</p>;
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

/** A QR code for a checkout address, on the kit's QR tile (`payments/LinkAddress.tsx`'s `AddressQr`). */
function AddressQr({ value }: { value: string }) {
  const { t } = paymentsCopy.useCopy();
  const drawn = useMemo(() => {
    try {
      return qrPath(encodeQr(value, 'M'), 2);
    } catch {
      return null;
    }
  }, [value]);
  return <QrCode d={drawn?.d ?? null} size={drawn?.size ?? 0} label={t('lk_qrLabel')} failed={t('lk_qrFailed')} />;
}

/** The checkout address of a payment link, with the three things a merchant does with it: copy it, open it, scan it. */
export function LinkAddress({ url }: { url: string }) {
  const { t } = paymentsCopy.useCopy();
  return (
    <div data-testid="link-address">
      <CopyReference value={url} what={t('lk_addressWhat')} />
      <Actions>
        {isWebAddress(url) && (
          <a
            className="lt-button"
            data-slot="button"
            data-variant="secondary"
            data-tone="secondary"
            data-size="md"
            role="link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('lk_open')}
          </a>
        )}
      </Actions>
      <AddressQr value={url} />
    </div>
  );
}
