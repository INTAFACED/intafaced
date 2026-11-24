import { useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../../../session';
import { Button } from '@intafaced/ui/lit';
import { Field } from '../../ui-kit';
import { PayDetails, PaySection } from '../../components';
import { PortalReview } from '../ui/PortalReview';
import { validatedRecordMutation } from '../../BusinessPay';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import * as s from '../../schemas';
import { BackLink, Facts, SelectField } from '../components';
import { useUnsavedForm } from '../useUnsavedForm';
import { w3cCopy } from './copy';
import type { PortalApi } from '../api';
import { DateTime } from '../ui/DateTime';
import type { PricedProduct } from '@intafaced/contracts/merchant-catalog';
import { LinkPricePicker } from '../catalog/LinkPrice';
import { catalogCopy } from '../catalog/copy';
import { priceWords } from '../catalog/Prices';
import { useAssetChoices } from './asset-choices';
import { addressOf } from './checkout-address';
import { LinkAddress } from './LinkAddress';
import { definite } from './not-available';
import { afterWords } from './link-model';
import { PAY_MERCHANT_CREATE_LINK } from '@intafaced/contracts/pay-merchant-procedures';

export { addressOf };
export { fullSnippet, linkState, settleDeactivate } from './link-model';
export { LinksView } from './LinkList';

/**
 * An after-payment page the service will take: it parses as an address, is https, and names a host (the same test as
 * svc-pay's `parseLinkConfirmation`).
 */
export function isHttpsPage(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0 && parsed.href.startsWith('https://');
  } catch {
    return false;
  }
}

/**
 * A `datetime-local` value ("2026-10-17T18:30") is the merchant's own clock. Convert it to the exact moment (an ISO time in
 * UTC) the service stores. An unreadable value is returned as typed, so the form's own check refuses it.
 */
export function expiryIso(local: string): string {
  const at = new Date(local);
  return Number.isFinite(at.getTime()) ? at.toISOString() : local;
}

/** Matches the mounted createLink input, with a stricter UI requirement to pair a fixed amount and its asset. */
export const createLinkInputSchema = z
  .object({
    merchantId: s.id,
    label: z.string().trim().min(1).max(120),
    profileId: s.id.optional(),
    amount: s.positiveAmount.optional(),
    currency: s.asset.optional(),
    priceId: s.id.optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    maxUses: z.number().int().min(1).max(1_000_000).optional(),
    /** After payment: a message, or the business's own https page. The service checks both again. */
    confirmation: z
      .union([
        z.object({ kind: z.literal('message'), message: z.string().trim().min(1).max(500) }).strict(),
        z
          .object({
            kind: z.literal('redirect'),
            url: z.string().trim().max(2048).refine(isHttpsPage),
          })
          .strict(),
      ])
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.amount && !value.currency) context.addIssue({ code: 'custom', path: ['currency'], message: 'asset' });
  });

/** `/pay/links/new`: the way back to the links and the new link's form. The list and one link's page are `./LinkList`. */
export function Links({
  portal,
  merchantId,
  authority,
}: {
  portal: PortalApi;
  merchantId: string;
  authority: PayBusinessAuthority | null;
}) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createBusinessPayApi(api, userId, authority), [api, userId, authority]);
  const { t } = w3cCopy.useCopy();
  return (
    <div className="lt-stack">
      <BackLink href="/pay/links">{t('backLinks')}</BackLink>
      <PaymentLinkForm pay={pay} merchantId={merchantId} portal={portal} />
    </div>
  );
}

/**
 * Shown when a create request was sent but its answer was lost. One button sends the very same request again: the service
 * recognises it, so it returns the link it already made instead of a second one.
 */
function LinkRecovery({
  pay,
  original,
  onFinished,
  onSettled,
}: {
  pay: BusinessPayApi;
  original: () => z.infer<typeof createLinkInputSchema> | null;
  onFinished: (link: z.infer<typeof s.newLinkSchema>) => void;
  onSettled: () => void;
}) {
  const { t } = w3cCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <div className="lt-stack">
      <p className="pp-callout" role="status">
        {t('lk_unresolved')}
      </p>
      <Button
        tone="secondary"
        disabled={busy}
        onClick={async () => {
          const body = original();
          if (!body) {
            setMessage(t('lk_unresolvedNeedsForm'));
            return;
          }
          setBusy(true);
          try {
            const result = definite(
              await validatedRecordMutation(pay, PAY_MERCHANT_CREATE_LINK, body, createLinkInputSchema, 'pay:write', 'link-create'),
            );
            if (result.ok) onFinished(result.data);
            else setMessage(result.reason === 'uncertain' || result.reason === 'aborted' ? t('lk_stillUnresolved') : result.message);
            onSettled();
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('lk_checkOriginal')}
      </Button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
export function PaymentLinkForm({ pay, merchantId, portal }: { pay: BusinessPayApi; merchantId: string; portal?: PortalApi }) {
  const { t } = w3cCopy.useCopy();
  const [form, setForm] = useState({
    label: '',
    amount: '',
    currency: '',
    priceId: '',
    profileId: '',
    expiry: '',
    maxUses: '',
    afterKind: '',
    afterMessage: '',
    afterUrl: '',
  });
  // The catalogue price picked, as the picker read it: its product's name and price words for the review.
  const [priced, setPriced] = useState<PricedProduct | null>(null);
  const [created, setCreated] = useState<z.infer<typeof s.newLinkSchema> | null>(null);
  const [sent, setSent] = useState(false);
  // Bumped when a lost reply is recovered, so the stale "outcome not confirmed" notice goes with it.
  const [recovered, setRecovered] = useState(0);
  // The details of the request in flight, so "check and finish" can send exactly the same one again.
  const original = useRef<z.infer<typeof createLinkInputSchema> | null>(null);
  const [, refreshLock] = useState(0);
  const lockId = `${pay.authority?.userId}:link-create`;
  const locked = Boolean(pay.authority && pay.guard.status(lockId));
  const assets = useAssetChoices(portal, merchantId, form.currency);
  const parsed = createLinkInputSchema.safeParse({
    merchantId,
    label: form.label,
    ...(form.amount ? { amount: form.amount } : {}),
    ...(form.currency ? { currency: form.currency } : {}),
    ...(form.priceId ? { priceId: form.priceId } : {}),
    ...(form.profileId ? { profileId: form.profileId } : {}),
    ...(form.expiry ? { expiresAt: expiryIso(form.expiry) } : {}),
    ...(form.maxUses ? { maxUses: /^[1-9]\d*$/.test(form.maxUses) ? Number(form.maxUses) : NaN } : {}),
    ...(form.afterKind === 'message' ? { confirmation: { kind: 'message', message: form.afterMessage } } : {}),
    ...(form.afterKind === 'redirect' ? { confirmation: { kind: 'redirect', url: form.afterUrl } } : {}),
  });
  const afterProblem =
    form.afterKind === 'message' && !form.afterMessage.trim()
      ? t('lk_afterMessageBlank')
      : form.afterKind === 'redirect' && !form.afterUrl.trim()
        ? t('lk_afterUrlBlank')
        : form.afterKind === 'redirect' && !isHttpsPage(form.afterUrl.trim())
          ? t('lk_afterUrlNotHttps')
          : undefined;
  const noWrite = pay.access('pay:write') !== null;
  useUnsavedForm(!sent && Object.values(form).some(Boolean), t('unsaved'));
  const fromPrice = Boolean(form.priceId);
  const field = (key: keyof typeof form, label: string, hint: string, required = false, type = 'text', disabled = false) => (
    <Field
      label={`${label}${required ? ' *' : ''}`}
      hint={hint}
      required={required}
      type={type}
      disabled={disabled}
      value={form[key]}
      onChange={(event) => setForm({ ...form, [key]: event.target.value })}
      error={
        form[key] && !parsed.success && parsed.error.issues.some((issue) => issue.path[0] === (key === 'expiry' ? 'expiresAt' : key))
          ? t('invalidLink')
          : undefined
      }
    />
  );
  return (
    <PaySection title={t('linkNew')}>
      {noWrite && (
        <p className="muted pp-note" role="note">
          {t('linkOwnerOnly')}
        </p>
      )}
      <div data-testid="form-stack" className="lt-stack">
        <fieldset className="pp-group">
          <legend>{t('groupCheckout')}</legend>
          {portal && (
            <LinkPricePicker
              portal={portal}
              value={form.priceId}
              disabled={sent}
              onChange={(choice) => {
                // The label follows the product while it is the one a price filled in; a label the owner typed stays.
                const filled = !form.label || form.label === priced?.product.name;
                setPriced(choice);
                setForm(
                  choice
                    ? {
                        ...form,
                        priceId: choice.price.id,
                        label: filled ? choice.product.name : form.label,
                        amount: choice.price.amount ?? '',
                        currency: choice.price.assetId,
                      }
                    : { ...form, priceId: '', label: filled ? '' : form.label, amount: '', currency: '' },
                );
              }}
            />
          )}
          {field('label', t('linkLabel'), t('linkLabelHint'), true)}
          <div className="form-row">
            {field('amount', t('fixedAmount'), fromPrice ? catalogCopy.t('linkPriceSets') : t('fixedAmountHint'), false, 'text', fromPrice)}
            <SelectField
              label={t('lk_asset')}
              value={form.currency}
              onChange={(value) => setForm({ ...form, currency: value })}
              hint={fromPrice ? catalogCopy.t('linkPriceSets') : t('assetHint')}
              disabled={fromPrice}
              options={[['', t('lk_noAsset')], ...assets.map((a) => [a, a] as const)]}
            />
          </div>
          {form.amount && !form.currency && <p className="error-text">{t('invalidAmountAsset')}</p>}
          {field('profileId', t('lk_profile'), t('profileHint'))}
        </fieldset>
        <fieldset className="pp-group">
          <legend>{t('groupAvailability')}</legend>
          {field('expiry', t('expiry'), t('expiryHint'), false, 'datetime-local')}
          {field('maxUses', t('maxUses'), t('maxUsesHint'))}
        </fieldset>
        <fieldset className="pp-group">
          <legend>{t('lk_groupAfter')}</legend>
          <SelectField
            label={t('lk_afterKind')}
            hint={t('lk_afterKindHint')}
            value={form.afterKind}
            // A new choice starts empty: text written for another choice is not kept to come back later.
            onChange={(value) => setForm({ ...form, afterKind: value, afterMessage: '', afterUrl: '' })}
            options={[
              ['', t('lk_afterNone')],
              ['message', t('lk_afterMessage')],
              ['redirect', t('lk_afterRedirect')],
            ]}
          />
          {form.afterKind === 'message' && (
            <Field
              label={`${t('lk_afterMessageLabel')} *`}
              hint={t('lk_afterMessageHint')}
              maxLength={500}
              value={form.afterMessage}
              onChange={(event) => setForm({ ...form, afterMessage: event.target.value })}
              error={afterProblem}
            />
          )}
          {form.afterKind === 'redirect' && (
            <Field
              label={`${t('lk_afterUrlLabel')} *`}
              hint={t('lk_afterUrlHint')}
              type="url"
              inputMode="url"
              maxLength={2048}
              value={form.afterUrl}
              onChange={(event) => setForm({ ...form, afterUrl: event.target.value })}
              error={afterProblem}
            />
          )}
        </fieldset>
        {!parsed.success && <p className="lt-muted">{t('invalidForm')}</p>}
        <div title={noWrite ? t('linkOwnerOnly') : !parsed.success ? t('invalidForm') : undefined}>
          <PortalReview
            key={recovered}
            title={t('reviewLink')}
            description={t('reviewLinkBody')}
            variant="primary"
            disabled={noWrite || !parsed.success || sent || locked}
            review={
              <PayDetails
                values={[
                  ...(priced
                    ? [
                        [
                          catalogCopy.t('linkPrice'),
                          catalogCopy.t('linkPriceOption', { product: priced.product.name, price: priceWords(priced.price) }),
                        ] as [string, string],
                      ]
                    : []),
                  [t('linkLabel'), form.label],
                  [t('amount'), form.amount ? `${form.amount} ${form.currency}` : t('payerChooses')],
                  [t('expiry'), parsed.success && parsed.data.expiresAt ? <DateTime value={parsed.data.expiresAt} /> : t('serviceExpiry')],
                  [t('maxUses'), form.maxUses || t('noUseCap')],
                  [t('lk_afterFact'), afterWords(parsed.success ? parsed.data.confirmation : undefined)],
                ]}
              />
            }
            perform={async () => {
              if (parsed.success) original.current = parsed.data;
              const result = definite(
                await validatedRecordMutation(
                  pay,
                  PAY_MERCHANT_CREATE_LINK,
                  parsed.success ? parsed.data : {},
                  createLinkInputSchema,
                  'pay:write',
                  'link-create',
                ),
              );
              refreshLock((n) => n + 1);
              return result;
            }}
            onConfirmed={(value) => {
              setCreated(value);
              setSent(true);
            }}
          />
        </div>
        {locked && !created && (
          <LinkRecovery
            pay={pay}
            original={() => original.current ?? (parsed.success ? parsed.data : null)}
            onFinished={(value) => {
              setCreated(value);
              setSent(true);
              setRecovered((n) => n + 1);
              refreshLock((n) => n + 1);
            }}
            onSettled={() => refreshLock((n) => n + 1)}
          />
        )}
        {created && (
          <PaySection title={t('publishedOnce')} description={t('publishedOnceBody')}>
            <LinkAddress url={addressOf(created) ?? ''} />
            <Facts
              items={[
                [
                  t('linkId'),
                  <span data-testid="pp-mono" className="pp-copy pp-mono">
                    {created.id}
                  </span>,
                ],
                [t('expiry'), <DateTime value={created.expiresAt} />],
                [t('maxUses'), created.maxUses ?? t('noUseCap')],
              ]}
            />
            <Button tone="secondary" onClick={() => setCreated(null)}>
              {t('hideUrl')}
            </Button>
          </PaySection>
        )}
      </div>
    </PaySection>
  );
}
