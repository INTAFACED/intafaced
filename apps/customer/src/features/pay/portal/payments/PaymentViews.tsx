import { useState } from 'react';
import {
  PAYMENT_UNMASK_REASON_MIN,
  PAYMENT_VIEW_COLUMNS,
  PAYMENT_VIEW_DEFAULT_COLUMNS,
  paymentViewColumnSchema,
  paymentViewFiltersSchema,
  type PaymentView,
  type PaymentViewColumn,
  type PaymentViewFilters,
} from '@intafaced/contracts/pay-payment-views';
import { Button, Checkbox, Field } from '@intafaced/ui/lit';
import { TextAreaField } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../../shared/resource';
import { Failure, SelectField } from '../volt/parts';
import { Review } from '../volt/Review';
import { readyAccess, useOptionalMerchantAccess } from '../access/MerchantAccess';
import type { PortalApi } from '../api';
import { useUrlParam } from '../hooks';
import type { Payment } from '../schemas';
import type { ListFilters } from '../ui/FilterRow';
import { portalCopy as c } from './copy';

/** The columns the list draws, as the address holds them (`cols=amount,status`). Unknown names are dropped; none means the default set. */
export function usePaymentColumns(): [PaymentViewColumn[], (next: readonly PaymentViewColumn[]) => void] {
  const [raw, setRaw] = useUrlParam('cols');
  return [parseColumns(raw), (next) => setRaw(next.join(','))];
}

export function parseColumns(raw: string): PaymentViewColumn[] {
  const picked = raw
    .split(',')
    .map((name) => paymentViewColumnSchema.safeParse(name.trim()))
    .flatMap((r) => (r.success ? [r.data] : []));
  const unique = PAYMENT_VIEW_COLUMNS.filter((name) => picked.includes(name));
  return unique.length > 0 ? unique : [...PAYMENT_VIEW_DEFAULT_COLUMNS];
}

/** The list's filters as a view keeps them. A custom date range is not kept: a view holds a rolling window or none. */
export function viewFiltersOf(filters: ListFilters): PaymentViewFilters {
  const parsed = paymentViewFiltersSchema.safeParse({
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.asset ? { assetId: filters.asset } : {}),
    ...(filters.date === 'today' || filters.date === '7d' || filters.date === '30d' ? { date: filters.date } : {}),
  });
  return parsed.success ? parsed.data : {};
}

function applyView(view: PaymentView, filters: ListFilters, setColumns: (next: readonly PaymentViewColumn[]) => void) {
  filters.setStatus(view.filters.status ?? '');
  filters.setSearch(view.filters.search ?? '');
  filters.setAsset(view.filters.assetId ?? '');
  filters.setDate(view.filters.date ?? '');
  filters.setFrom('');
  filters.setTo('');
  setColumns(view.columns);
}

/**
 * Saved views on the payments list (M-adv-payments-core-01): choose one to put its filters and columns back, pick the
 * columns, and save what is on the list under a name. Sharing a view with the team is for the owner and admins; anyone
 * else sees the choice switched off with the reason.
 */
export function PaymentViewsBar({
  portal,
  filters,
  columns,
  setColumns,
}: {
  portal: PortalApi;
  filters: ListFilters;
  columns: readonly PaymentViewColumn[];
  setColumns: (next: readonly PaymentViewColumn[]) => void;
}) {
  const { t } = c.useCopy();
  const role = readyAccess(useOptionalMerchantAccess())?.role;
  const mayShare = role === 'owner' || role === 'admin';
  const views = useResource((s) => portal.paymentViews(s), 'portal:payment-views');
  const [viewId, setViewId] = useUrlParam('view');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const items = views.resource.status === 'ready' ? views.resource.data.items : [];
  const chosen = items.find((v) => v.id === viewId) ?? null;
  const columnLabel = (col: PaymentViewColumn) => t(`pv_col_${col}`);
  return (
    <div className="lt-stack">
      <div className="lt-field-row">
        {views.resource.status === 'failed' ? (
          <Failure result={views.resource.failure} retry={views.reload} />
        ) : (
          <SelectField
            label={t('pv_views')}
            value={chosen ? chosen.id : ''}
            disabled={views.resource.status !== 'ready'}
            onChange={(id) => {
              setViewId(id);
              const view = items.find((v) => v.id === id);
              if (view) applyView(view, filters, setColumns);
            }}
            options={[
              ['', t('pv_none')] as const,
              ...items.map((v) => [v.id, v.visibility === 'shared' ? t('pv_sharedName', { name: v.name }) : v.name] as const),
            ]}
          />
        )}
        <Review
          title={t('pv_save')}
          description={t('pv_saveBody')}
          ready={name.trim().length > 0}
          notReadyReason={t('pv_nameNeeded')}
          review={
            <>
              <Field label={t('pv_name')} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              <div>
                <Checkbox checked={mayShare && shared} disabled={!mayShare} onCheckedChange={setShared}>
                  {t('pv_share')}
                </Checkbox>
                {!mayShare && <small className="lt-hint">{t('pv_shareAdminOnly')}</small>}
              </div>
              <p className="lt-hint">{t('pv_keeps', { columns: columns.map(columnLabel).join(', ') })}</p>
              {filters.date === 'custom' && <p className="lt-hint">{t('pv_customLeftOut')}</p>}
            </>
          }
          perform={() =>
            portal.createPaymentView({
              name: name.trim(),
              visibility: mayShare && shared ? 'shared' : 'private',
              filters: viewFiltersOf(filters),
              columns: [...columns],
            })
          }
          onConfirmed={(view) => {
            setName('');
            setShared(false);
            setViewId(view.id);
            views.reload();
          }}
        />
        {chosen?.editable && (
          <Review
            title={t('pv_remove')}
            description={t('pv_removeBody', { name: chosen.name })}
            perform={() => portal.deletePaymentView(chosen.id)}
            onConfirmed={() => {
              setViewId('');
              views.reload();
            }}
          />
        )}
      </div>
      <div>
        <Button tone="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('pv_columns')}
        </Button>
        {open && (
          <fieldset className="lt-actions">
            <legend className="lt-muted">{t('pv_columnsLegend')}</legend>
            {PAYMENT_VIEW_COLUMNS.map((col) => {
              const on = columns.includes(col);
              const last = on && columns.length === 1;
              return (
                <Checkbox
                  key={col}
                  checked={on}
                  disabled={last}
                  title={last ? t('pv_lastColumn') : undefined}
                  onCheckedChange={(checked) =>
                    setColumns(
                      checked ? PAYMENT_VIEW_COLUMNS.filter((x) => x === col || columns.includes(x)) : columns.filter((x) => x !== col),
                    )
                  }
                >
                  {columnLabel(col)}
                </Checkbox>
              );
            })}
          </fieldset>
        )}
      </div>
    </div>
  );
}

/**
 * The payer's email, masked as the service sends it. A role holding `payments.unmask` can ask for it in full with a
 * reason; the service writes the audit line before it answers. Anyone else gets no Unmask control at all.
 */
export function PayerEmailCell({ portal, payment }: { portal: PortalApi; payment: Payment }) {
  const { t } = c.useCopy();
  const access = useOptionalMerchantAccess();
  const canUnmask = Boolean(access?.can('payments.unmask'));
  const [reason, setReason] = useState('');
  const [clear, setClear] = useState<string | null>(null);
  const masked = payment.customerEmail ?? null;
  if (!masked) return <span className="lt-muted">{t('pay_emailNone')}</span>;
  if (clear !== null) return <span data-testid="payer-email-clear">{clear}</span>;
  return (
    <span className="lt-actions">
      <span data-testid="payer-email-masked">{masked}</span>
      {canUnmask && (
        <Review
          title={t('pay_unmask')}
          description={t('pay_unmaskBody')}
          ready={reason.trim().length >= PAYMENT_UNMASK_REASON_MIN}
          notReadyReason={t('pay_unmaskReasonShort')}
          review={
            <TextAreaField
              label={`${t('pay_unmaskReason')} *`}
              value={reason}
              onChange={setReason}
              maxLength={500}
              rows={3}
              hint={t('pay_unmaskReasonHint')}
            />
          }
          perform={() => portal.unmaskPayment({ paymentId: payment.id, field: 'customerEmail', reason: reason.trim() })}
          onConfirmed={(out) => {
            setReason('');
            setClear(out.value ?? t('pay_emailNone'));
          }}
        />
      )}
    </span>
  );
}
