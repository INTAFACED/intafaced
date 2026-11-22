import { useState } from 'react';
import { z } from 'zod';
import { useUnsavedForm } from './portal/useUnsavedForm';
import { DEFAULT_ASSET, useAssetChoices } from './portal/payments/asset-choices';
import type { PortalApi } from './portal/api';
import { extensionCopy } from './portal/extension-copy';
import type { BusinessPayApi } from './pay-api';
import { validatedMutation } from './BusinessPay';
import * as s from './schemas';

/** Has the person typed anything? The asset starts on the default, so only a different asset counts: an untouched form never warns. */
export function mandateFormDirty(form: {
  customer: string;
  asset: string;
  amount: string;
  ceiling: string;
  starts: string;
  ends: string;
  rail: string;
  reference: string;
}): boolean {
  const { asset, ...typed } = form;
  return asset !== DEFAULT_ASSET || Object.values(typed).some(Boolean);
}

/**
 * The state of the "Record a customer mandate" form, its one call and its reset: `MerchantBilling.tsx`'s `CreateMandate`
 * and its kit view (`billing-flow/CreateMandate.tsx`) both run this, so the two draw the same form over the same code.
 */
export function useMandateForm({ pay, refresh, portal }: { pay: BusinessPayApi; refresh: () => void; portal?: PortalApi }) {
  const [expanded, setExpanded] = useState(false);
  const [customer, setCustomer] = useState('');
  const [asset, setAsset] = useState(DEFAULT_ASSET);
  const assets = useAssetChoices(portal, pay.authority?.merchantId, asset);
  const [amount, setAmount] = useState('');
  const [ceiling, setCeiling] = useState('');
  const [cadence, setCadence] = useState('monthly');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [rail, setRail] = useState('');
  const [reference, setReference] = useState('');
  const [created, setCreated] = useState('');
  useUnsavedForm(
    expanded && mandateFormDirty({ customer, asset, amount, ceiling, starts, ends, rail, reference }),
    extensionCopy.t('draftWarning'),
  );
  const perform = () =>
    validatedMutation(
      pay,
      'mandate.create',
      {
        merchantId: pay.authority!.merchantId,
        customerId: customer,
        assetId: asset,
        amount,
        cadence,
        startsAt: starts ? new Date(starts).toISOString() : '',
        ...(ends ? { endsAt: new Date(ends).toISOString() } : {}),
        ...(ceiling ? { ceiling } : {}),
        ...(rail ? { railAdapter: rail } : {}),
        ...(reference ? { railMandateRef: reference } : {}),
      },
      z.object({
        merchantId: s.id,
        customerId: z.string().min(1).max(128),
        assetId: s.asset,
        amount: s.positiveAmount,
        ceiling: s.amount.optional(),
        cadence: z.enum(['daily', 'weekly', 'monthly']),
        startsAt: z.string().datetime({ offset: true }),
        endsAt: z.string().datetime({ offset: true }).optional(),
        railAdapter: z.string().max(64).optional(),
        railMandateRef: z.string().max(256).optional(),
      }),
      s.mandateSchema,
      'pay:write',
      'mandate-create',
    );
  const disabled = !customer || !amount || !asset || !starts || Boolean(pay.access('pay:write'));
  const onConfirmed = (data: z.infer<typeof s.mandateSchema>) => {
    setCreated(data.id);
    setCustomer('');
    setAsset(DEFAULT_ASSET);
    setAmount('');
    setCeiling('');
    setStarts('');
    setEnds('');
    setRail('');
    setReference('');
    refresh();
    setExpanded(false);
  };
  return {
    expanded,
    setExpanded,
    customer,
    setCustomer,
    asset,
    setAsset,
    assets,
    amount,
    setAmount,
    ceiling,
    setCeiling,
    cadence,
    setCadence,
    starts,
    setStarts,
    ends,
    setEnds,
    rail,
    setRail,
    reference,
    setReference,
    created,
    perform,
    disabled,
    onConfirmed,
  };
}
