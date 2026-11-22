import { z } from 'zod';
import { Button } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../../shared/api';
import type { mandateSchema, subscriptionSchema } from '../../schemas';
import type { PortalApi } from '../api';
import { Details } from '../../p2p-flow/parts';
import { catalogCopy } from '../catalog/copy';
import {
  optionText,
  subscriptionPriceMarks,
  subscriptionPriceOptions,
  useSubscriptionPriceChoices,
  useSubscriptionPriceRead,
} from '../catalog/SubscriptionPrice';
import { cadenceLabel, pathLabel } from '../payments/Subscriptions';
import { useSubscriptionCheck } from '../payments/subscription-check';
import { extensionCopy as c } from '../payments/copy';
import { DateTime, Failure, Loading, MoneyText, SelectField } from './parts';

/**
 * The subscription create room's own parts, drawn from the kit: the kit views of `../catalog/SubscriptionPrice.tsx`'s
 * picker and fact, and of `../payments/Subscriptions.tsx`'s terms and recovery check. Each runs its original's hook
 * and says the same words.
 */
type Subscription = z.infer<typeof subscriptionSchema>;
type Mandate = z.infer<typeof mandateSchema>;

/** `SubscriptionPricePicker`: the catalogue price a subscription starts on; the choice is optional. */
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
  const { t } = catalogCopy.useCopy();
  const { monthly, resource, reload } = useSubscriptionPriceChoices(portal, mandate);
  if (!monthly) return <p className="lt-hint">{t('subPriceNotMonthly')}</p>;
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const choices = resource.data?.items ?? [];
  if (choices.length === 0 && !value) return <p className="lt-hint">{t('subPriceNoMatch')}</p>;
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

/** `SubscriptionPriceFact`: the price a subscription runs on, read by its id; archived ones still read, and say so. */
export function SubscriptionPriceFact({ portal, priceId }: { portal: PortalApi; priceId: string | null | undefined }) {
  const { t } = catalogCopy.useCopy();
  const { resource, reload } = useSubscriptionPriceRead(portal, priceId);
  if (!priceId) return <>{t('subPriceNoneFact')}</>;
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const read = resource.data;
  if (!read) return <>{t('subPriceNoneFact')}</>;
  const marks = subscriptionPriceMarks(read, t);
  return (
    <a className="lt-link" href={`/pay/products/${encodeURIComponent(read.product.id)}`}>
      {optionText(read)}
      {marks.length > 0 && ` (${marks.join(', ')})`}
    </a>
  );
}

/** `SubscriptionTerms`: the mandate's terms a subscription runs on, the same rows for the choice and its review. */
export function SubscriptionTerms({ mandate: m, path }: { mandate: Mandate; path: string }) {
  return (
    <Details
      values={[
        [c.t('customer'), m.customerId],
        [c.t('chargePath'), path ? pathLabel(path) : c.t('unavailable')],
        [c.t('amount'), <MoneyText value={m.amount} asset={m.assetId} />],
        [c.t('cadence'), cadenceLabel(m.cadence)],
        [c.t('mandateStart'), <DateTime value={m.startsAt} />],
        [c.t('mandateEnd'), m.endsAt ? <DateTime value={m.endsAt} /> : c.t('openEnded')],
        [c.t('authorizedCeiling'), m.ceiling !== null ? <MoneyText value={m.ceiling} asset={m.assetId} /> : c.t('noCeiling')],
      ]}
    />
  );
}

/** `SubscriptionRecovery`: a create whose reply was lost, and the one button that asks what became of it. */
export function SubscriptionRecovery({
  check,
  onKnown,
  onSettled,
  outcomeShown = false,
}: {
  /** True when the review above already says the outcome is not confirmed: the general notice is then left out. */
  outcomeShown?: boolean;
  check: (current: () => boolean) => Promise<ApiResult<Subscription>>;
  onKnown: (subscription: Subscription) => void;
  onSettled?: (result: ApiResult<Subscription>) => void;
}) {
  const { busy, message, run } = useSubscriptionCheck({ check, onKnown, onSettled });
  return (
    <div>
      {/* One message about the unconfirmed request: the latest check's answer replaces the general notice. */}
      {(message || !outcomeShown) && <p role="status">{message || c.t('unresolvedSubscription')}</p>}
      <Button disabled={busy} onClick={() => void run()}>
        {c.t('checkSubscriptionOriginal')}
      </Button>
    </div>
  );
}
