import { useMemo, useState } from 'react';
import { Button, DataTable } from '@intafaced/ui';
import { EmptyState, Field } from '../../ui-kit';
import { useResource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import { useMerchantAccess } from '../access/MerchantAccess';
import type { PortalApi } from '../api';
import { Facts, Gate, Money, PortalFailure, PortalLoading } from '../components';
import { buildCsv, downloadText } from '../csv';
import { useReadAt } from '../hooks';
import { paymentLabel } from '../presentation';
import type { Payment } from '../schemas';
import { AuditPanel } from '../ui/AuditPanel';
import { CopyReference } from '../ui/CopyReference';
import { DateTime } from '../ui/DateTime';
import { DetailHeader } from '../ui/DetailHeader';
import { EntityList } from '../ui/EntityList';
import { dateRange, FilterRow, useListFilters, type DatePreset } from '../ui/FilterRow';
import { Freshness } from '../ui/Freshness';
import { PortalReview } from '../ui/PortalReview';
import { RelatedLinks } from '../ui/RelatedLinks';
import { addressOf } from './Links';
import { StatusChip } from '../ui/StatusChip';
import { Timeline } from '../ui/Timeline';
import { useServerList } from '../ui/useServerList';
import { useDebouncedValue } from '../../../../shared/use-debounced';
import { allowedActions, displayStatus, invoiceEvents, invoiceName, isOverdue, matchingPayments, useRequestId } from './invoice-model';
import { paymentsCopy as c } from './copy';
import './refusals';
import { invoiceDisplayStatuses, type Invoice, type InvoiceLine, type InvoiceLink } from './schemas';
import { InvoiceCreate } from '../flow/InvoiceNewRoom';

export { InvoiceCreate };

const invoiceHref = (id: string) => `/pay/invoices/${encodeURIComponent(id)}`;
const name = (invoice: Invoice) => invoiceName(invoice, (short) => c.t('inv_fallbackName', { short }));

/** `/pay/invoices`: every invoice, newest first, filtered by the service. */
export function Invoices({
  portal,
  route,
  merchantId,
}: {
  portal: PortalApi;
  route: { room: string; param?: string };
  merchantId: string;
}) {
  if (route.room === 'invoice-new') return <InvoiceCreate portal={portal} merchantId={merchantId} />;
  if (route.room === 'invoice' && route.param) return <InvoiceDetail portal={portal} invoiceId={route.param} />;
  return <InvoiceList portal={portal} />;
}

export function InvoiceList({ portal }: { portal: PortalApi }) {
  const { t } = c.useCopy();
  const { can } = useMerchantAccess();
  const filters = useListFilters();
  const range = dateRange(filters.date as DatePreset, Date.now(), { from: filters.from, to: filters.to });
  // Overdue is not stored: ask for sent invoices and keep the ones whose due date has passed.
  const overdueOnly = filters.status === 'overdue';
  const query = {
    status: overdueOnly ? 'sent' : filters.status,
    search: filters.search.trim(),
    assetId: '',
    from: range.from ?? '',
    to: range.to ?? '',
  };
  const list = useServerList(
    (f, cursor, signal) => portal.invoices(f, cursor, signal),
    query,
    (invoice: Invoice) => invoice.id,
  );
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  const filtered = Boolean(filters.status || filters.search || filters.date);
  const now = Date.now();
  const rows = list.state.status === 'ready' ? (overdueOnly ? list.state.items.filter((i) => isOverdue(i, now)) : list.state.items) : [];
  return (
    <div className="stack">
      <Freshness asOf={readAt} />
      <FilterRow
        label={t('inv_listTitle')}
        filters={filters}
        statuses={invoiceDisplayStatuses.map((s) => [s, t(`inv_status_${s}`)] as const)}
        {...(list.state.status === 'ready' ? { shown: rows.length, hasMore: list.state.hasMore } : {})}
      />
      {list.state.status === 'loading' && <PortalLoading />}
      {list.state.status === 'failed' && <PortalFailure result={list.state.failure} retry={() => list.reload()} />}
      {list.state.status === 'ready' &&
        (rows.length === 0 && !list.state.hasMore ? (
          <EmptyState
            title={t(filtered ? 'inv_emptyFilteredTitle' : 'inv_emptyTitle')}
            action={
              !filtered && can('invoices.write') ? (
                <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/invoices/new" />}>
                  {t('inv_create')}
                </Button>
              ) : undefined
            }
          >
            {t(filtered ? 'inv_emptyFilteredBody' : can('invoices.write') ? 'inv_emptyBody' : 'inv_emptyBodyReadOnly')}
          </EmptyState>
        ) : (
          <>
            <EntityList
              label={t('inv_listTitle')}
              rows={rows}
              rowKey={(row) => row.id}
              href={(row) => invoiceHref(row.id)}
              columns={[
                {
                  header: t('inv_colInvoice'),
                  cell: (row) => (
                    <>
                      <strong>{name(row)}</strong>
                      {row.customerRef && row.description && <small className="pay-cell-note">{row.description}</small>}
                    </>
                  ),
                },
                { header: t('inv_colAmount'), cell: (row) => <Money value={row.amount} asset={row.assetId} /> },
                { header: t('inv_colStatus'), cell: (row) => <StatusChip entity="invoice" value={displayStatus(row, now)} /> },
                { header: t('inv_colDue'), cell: (row) => (row.dueAt ? <DateTime value={row.dueAt} dayOnly /> : '—') },
                { header: t('inv_colCreated'), cell: (row) => <DateTime value={row.createdAt} /> },
                { header: t('inv_colSent'), cell: (row) => (row.sentAt ? <DateTime value={row.sentAt} /> : '—') },
              ]}
              card={(row) => ({
                title: name(row),
                time: <DateTime value={row.createdAt} />,
                amount: <Money value={row.amount} asset={row.assetId} />,
                status: <StatusChip entity="invoice" value={displayStatus(row, now)} />,
              })}
            />
            {rows.length === 0 && (
              <p className="muted pp-note" role="status">
                {t('inv_noneLoadedYet')}
              </p>
            )}
            <div className="pp-actions">
              {list.state.hasMore && (
                <Button variant="secondary" onClick={list.loadMore} disabled={list.state.more === 'loading'}>
                  {list.state.more === 'loading' ? t('inv_loadingMore') : t('inv_loadMore')}
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => {
                  if (list.state.status !== 'ready') return;
                  downloadText(
                    'invoices.csv',
                    buildCsv(
                      [
                        'id',
                        'status',
                        'customer',
                        'customer_email',
                        'description',
                        'amount',
                        'asset',
                        'due_at',
                        'created_at',
                        'sent_at',
                        'paid_at',
                        'voided_at',
                      ],
                      rows.map((i) => [
                        i.id,
                        displayStatus(i, now),
                        i.customerRef ?? '',
                        i.customerEmail ?? '',
                        i.description ?? '',
                        i.amount,
                        i.assetId,
                        i.dueAt ?? '',
                        i.createdAt,
                        i.sentAt ?? '',
                        i.paidAt ?? '',
                        i.voidedAt ?? '',
                      ]),
                      { generatedAt: new Date().toISOString(), asOf: readAt ?? '' },
                    ),
                  );
                }}
              >
                {t('exportPage')}
              </Button>
            </div>
            <p className="muted pp-note">
              {t('inv_recurringNote')}{' '}
              <a className="text-link" href="/pay/subscriptions">
                {t('inv_openSubscriptions')}
              </a>
            </p>
          </>
        ))}
    </div>
  );
}

/** The lines of an invoice, a credit shown as a minus, with the exact total underneath. */
function LineTable({ lines, asset, total }: { lines: readonly InvoiceLine[]; asset: string; total: string }) {
  const { t } = c.useCopy();
  return (
    <DataTable label={t('inv_linesTitle')} headers={[t('inv_colItem'), t('inv_lineQuantity'), t('inv_lineUnit'), t('inv_lineAmount')]}>
      {lines.map((line, index) => (
        <tr key={index}>
          <th scope="row">
            {line.description}
            {line.kind === 'credit' && <small className="pay-cell-note">{t('inv_kindCredit')}</small>}
          </th>
          <td className="numeric">{line.quantity}</td>
          <td className="numeric">
            <Money value={line.unitAmount} asset={asset} />
          </td>
          <td className="numeric">
            <Money value={line.amount} asset={asset} />
          </td>
        </tr>
      ))}
      <tr>
        <th scope="row" colSpan={3}>
          {t('inv_fieldTotal')}
        </th>
        <td className="numeric">
          <strong>
            <Money value={total} asset={asset} />
          </strong>
        </td>
      </tr>
    </DataTable>
  );
}

export function InvoiceDetail({ portal, invoiceId }: { portal: PortalApi; invoiceId: string }) {
  const { t } = c.useCopy();
  const query = useResource((signal) => portal.invoice(invoiceId, signal), `portal:invoice:${invoiceId}`);
  const [minted, setMinted] = useState<InvoiceLink | null>(null);
  return (
    <Gate resource={query.resource} retry={query.reload}>
      {(invoice) => (
        <InvoiceDetailView
          portal={portal}
          invoice={invoice}
          minted={minted}
          onChanged={(link) => {
            if (link?.token) setMinted(link);
            query.reload();
          }}
          back={t('inv_back')}
        />
      )}
    </Gate>
  );
}

export function InvoiceDetailView({
  portal,
  invoice,
  minted,
  onChanged,
  back,
}: {
  portal: PortalApi;
  invoice: Invoice;
  minted: InvoiceLink | null;
  onChanged: (link: InvoiceLink | null) => void;
  back: string;
}) {
  const { t } = c.useCopy();
  const { can } = useMerchantAccess();
  const mayWrite = can('invoices.write');
  const actions = allowedActions(invoice.status);
  const send = useRequestId(`invoice:${invoice.id}:send`);
  const reissue = useRequestId(`invoice:${invoice.id}:reissue:${invoice.paymentLinkId ?? ''}`);
  const voided = useRequestId(`invoice:${invoice.id}:void`);
  const summary = (
    <Facts
      items={[
        [t('inv_colAmount'), <Money value={invoice.amount} asset={invoice.assetId} />],
        [t('inv_colCustomer'), invoice.customerRef ?? '—'],
        [t('inv_colDue'), invoice.dueAt ? <DateTime value={invoice.dueAt} dayOnly /> : t('inv_noDue')],
        [t('inv_colDescription'), invoice.description ?? '—'],
      ]}
    />
  );
  const why = mayWrite ? undefined : t('inv_noWrite');
  const sendAction = (
    <PortalReview
      title={t('inv_send')}
      variant="primary"
      description={t('inv_sendBody')}
      review={summary}
      disabled={!mayWrite}
      disabledReason={why}
      perform={() => portal.sendInvoice({ requestId: send.id, invoiceId: invoice.id })}
      onConfirmed={(out) => {
        send.renew();
        onChanged(out.paymentLink);
      }}
    />
  );
  const reissueAction = (
    <PortalReview
      title={t('inv_reissue')}
      variant="secondary"
      description={t('inv_reissueBody')}
      review={summary}
      disabled={!mayWrite}
      disabledReason={why}
      perform={() => portal.reissueInvoiceLink({ requestId: reissue.id, invoiceId: invoice.id })}
      onConfirmed={(out) => {
        reissue.renew();
        onChanged(out.paymentLink);
      }}
    />
  );
  const voidAction = (
    <PortalReview
      title={t('inv_void')}
      variant="sell"
      description={t(invoice.status === 'sent' ? 'inv_voidBodySent' : 'inv_voidBody')}
      review={summary}
      disabled={!mayWrite}
      disabledReason={why}
      perform={() => portal.voidInvoice({ requestId: voided.id, invoiceId: invoice.id })}
      onConfirmed={() => {
        voided.renew();
        onChanged(null);
      }}
    />
  );
  const related = [
    ...(invoice.paymentId ? [{ href: `/pay/payments/${encodeURIComponent(invoice.paymentId)}`, label: t('inv_relPayment') }] : []),
    ...(invoice.paymentLinkId ? [{ href: `/pay/links/${encodeURIComponent(invoice.paymentLinkId)}`, label: t('inv_relLink') }] : []),
    ...(invoice.customerRef ? [{ href: `/pay/customers/${encodeURIComponent(invoice.customerRef)}`, label: t('inv_relCustomer') }] : []),
  ];
  return (
    <div className="stack">
      <DetailHeader
        back={{ href: '/pay/invoices', label: back }}
        title={<Money value={invoice.amount} asset={invoice.assetId} />}
        status={<StatusChip entity="invoice" value={displayStatus(invoice)} />}
        subtitle={name(invoice)}
        action={actions.includes('send') ? sendAction : actions.includes('reissue') ? reissueAction : undefined}
      />
      {isOverdue(invoice) && (
        <p className="pp-callout" role="note">
          {t('inv_overdueNote')}
        </p>
      )}
      {minted?.token && (
        <PaySection title={t('inv_linkShownOnce')} description={t('inv_linkShownOnceBody')}>
          <CopyReference value={addressOf({ token: minted.token }) ?? ''} what={t('inv_relLink')} />
        </PaySection>
      )}
      <PaySection title={t('inv_detailsTitle')}>
        <Facts
          items={[
            [t('inv_colCustomer'), invoice.customerRef ?? '—'],
            [t('inv_fieldEmail'), invoice.customerEmail ?? '—'],
            [t('inv_colDue'), invoice.dueAt ? <DateTime value={invoice.dueAt} dayOnly /> : t('inv_noDue')],
            [t('inv_colDescription'), invoice.description ?? '—'],
            [t('inv_colCreated'), <DateTime value={invoice.createdAt} />],
            [t('inv_colSent'), invoice.sentAt ? <DateTime value={invoice.sentAt} /> : '—'],
            [t('inv_colPaid'), invoice.paidAt ? <DateTime value={invoice.paidAt} /> : '—'],
            [t('inv_colVoided'), invoice.voidedAt ? <DateTime value={invoice.voidedAt} /> : '—'],
          ]}
        />
        {invoice.customerEmail && <p className="muted pp-note">{t('inv_emailMaskedNote')}</p>}
      </PaySection>
      {invoice.lineItems.length > 0 && (
        <PaySection title={t('inv_linesTitle')}>
          <LineTable lines={invoice.lineItems} asset={invoice.assetId} total={invoice.amount} />
        </PaySection>
      )}
      <PaySection title={t('inv_historyTitle')}>
        <Timeline label={t('inv_historyTitle')} items={invoiceEvents(invoice).map((e) => ({ at: e.at, title: t(`inv_event_${e.key}`) }))} />
      </PaySection>
      <RelatedLinks links={related} />
      {(actions.includes('markPaid') || actions.includes('void')) && (
        <PaySection title={t('inv_actionsTitle')}>
          {actions.includes('markPaid') && (
            <MarkPaid portal={portal} invoice={invoice} disabled={!mayWrite} onDone={() => onChanged(null)} />
          )}
          <div className="pp-actions">{voidAction}</div>
        </PaySection>
      )}
      <AuditPanel who={null} at={invoice.updatedAt} />
      <PaySection title={t('inv_referenceTitle')}>
        <CopyReference value={invoice.id} what={t('inv_referenceTitle')} />
      </PaySection>
    </div>
  );
}

/** Pick the paid payment that settled this invoice: same asset, same amount, captured or settled. The service checks the same three things. */
function MarkPaid({ portal, invoice, disabled, onDone }: { portal: PortalApi; invoice: Invoice; disabled: boolean; onDone: () => void }) {
  const { t } = c.useCopy();
  const { access } = useMerchantAccess();
  const merchantId = access.status === 'ready' ? access.merchantId : '';
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState('');
  // The service is asked once typing pauses, not on every key.
  const term = useDebouncedValue(search.trim());
  const key = useMemo(() => `portal:invoice-payments:${invoice.id}:${term}`, [invoice.id, term]);
  const found = useResource((signal) => portal.paymentPage(merchantId, { assetId: invoice.assetId, search: term }, undefined, signal), key);
  const request = useRequestId(`invoice:${invoice.id}:paid:${picked}`);
  const candidates: Payment[] = found.resource.status === 'ready' ? matchingPayments(invoice, found.resource.data.items) : [];
  const chosen = candidates.find((p) => p.id === picked);
  return (
    <fieldset className="pp-group">
      <legend>{t('inv_markPaid')}</legend>
      <p className="muted">{t('inv_markPaidBody')}</p>
      <Field
        label={t('inv_searchPayments')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        hint={t('inv_searchPaymentsHint')}
      />
      {found.resource.status === 'loading' && <PortalLoading rows={2} />}
      {found.resource.status === 'failed' && <PortalFailure result={found.resource.failure} retry={found.reload} />}
      {found.resource.status === 'ready' &&
        (candidates.length === 0 ? (
          <p className="muted" role="status">
            {t('inv_noMatchingPayment')}
          </p>
        ) : (
          <ul className="pp-pick" aria-label={t('inv_markPaid')}>
            {candidates.map((p) => (
              <li key={p.id}>
                <label>
                  <input type="radio" name={`pay-${invoice.id}`} checked={picked === p.id} onChange={() => setPicked(p.id)} />{' '}
                  <strong>{paymentLabel(p)}</strong> · <DateTime value={p.createdAt} /> · <StatusChip entity="payment" value={p.status} />
                </label>
              </li>
            ))}
          </ul>
        ))}
      <PortalReview
        title={t('inv_markPaid')}
        variant="secondary"
        description={t('inv_markPaidReview')}
        disabled={disabled || !chosen}
        disabledReason={disabled ? t('inv_noWrite') : t('inv_pickPayment')}
        review={
          chosen && (
            <Facts
              items={[
                [t('inv_colAmount'), <Money value={invoice.amount} asset={invoice.assetId} />],
                [t('inv_relPayment'), `${paymentLabel(chosen)}`],
                [t('inv_colStatus'), <StatusChip entity="payment" value={chosen.status} />],
              ]}
            />
          )
        }
        perform={() => portal.markInvoicePaid({ requestId: request.id, invoiceId: invoice.id, paymentId: picked })}
        onConfirmed={() => {
          request.renew();
          onDone();
        }}
      />
    </fieldset>
  );
}
