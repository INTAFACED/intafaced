// volt-room: /pay/invoices/new
// volt-room: portal:invoice-new
import { useState } from 'react';
import { Button, Field, TextArea } from '@intafaced/ui/lit';
import { FlowTemplate, KeyValue, Table } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../../app/location';
import type { PortalApi } from '../api';
import {
  blankDraft,
  blankLine,
  draftAmount,
  draftProblems,
  dueAtOf,
  invoiceBody,
  lineAmount,
  lineProblem,
  localDay,
  MAX_INVOICE_LINES,
  useBodyRequestId,
  type DraftField,
  type InvoiceDraft,
  type LineDraft,
} from '../payments/invoice-model';
import { paymentsCopy as c } from '../payments/copy';
import { DEFAULT_ASSET, useAssetChoices } from '../payments/asset-choices';
import '../payments/refusals';
import type { InvoiceLine } from '../payments/schemas';
import { Actions, DateTime, Facts, Section, SelectField } from './parts';
import { ExactMoney } from './payments-parts';
import { PortalReview } from './review';

const invoiceHref = (id: string) => `/pay/invoices/${encodeURIComponent(id)}`;

/**
 * `/pay/invoices/new`, on the flow template: an amount (or line items that add up to it), who it is for, when it is due.
 * Review shows the exact total; a lost reply is safe to resend.
 */
export function InvoiceCreate({ portal, merchantId }: { portal: PortalApi; merchantId?: string }) {
  const { t } = c.useCopy();
  const [draft, setDraft] = useState<InvoiceDraft>(() => blankDraft(DEFAULT_ASSET));
  const [touched, setTouched] = useState<Partial<Record<DraftField, boolean>>>({});
  const today = localDay(new Date());
  const problems = draftProblems(draft, today);
  const ready = Object.keys(problems).length === 0;
  const request = useBodyRequestId('invoice-create', invoiceBody(draft));
  const shown = (key: DraftField) => (touched[key] && problems[key] ? t(`inv_problem_${problems[key]!}`) : undefined);
  const assets = useAssetChoices(portal, merchantId, draft.assetId);
  const hasLines = draft.lineItems.length > 0;
  const total = draftAmount(draft);
  const set = (key: Exclude<DraftField, 'lineItems'>) => (value: string) => {
    setDraft({ ...draft, [key]: key === 'assetId' ? value.toUpperCase() : value });
    setTouched({ ...touched, [key]: true });
  };
  const setLines = (lineItems: LineDraft[]) => {
    setDraft({ ...draft, lineItems });
    setTouched({ ...touched, lineItems: true });
  };
  const setLine = (index: number, patch: Partial<LineDraft>) =>
    setLines(draft.lineItems.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  const asset = draft.assetId.trim();
  return (
    <FlowTemplate
      framed
      title={t('inv_createTitle')}
      state={{ kind: 'ready' }}
      step={
        <Section title={t('inv_createTitle')} description={t('inv_createBody')}>
          <div data-testid="form-stack">
            <div>
              {hasLines ? (
                <div data-testid="pp-line-total" className="lt-field" role="group" aria-label={t('inv_fieldTotal')}>
                  <span>{t('inv_fieldTotal')}</span>
                  <strong>{total ? <ExactMoney value={total} asset={asset} /> : '—'}</strong>
                  <span className="lt-hint">{shown('lineItems') ?? t('inv_hintTotal')}</span>
                </div>
              ) : (
                <Field
                  label={t('inv_fieldAmount')}
                  inputMode="decimal"
                  value={draft.amount}
                  onChange={(e) => set('amount')(e.target.value)}
                  hint={t('inv_hintAmount')}
                  error={shown('amount')}
                />
              )}
              <SelectField
                label={t('inv_fieldAsset')}
                value={draft.assetId}
                onChange={set('assetId')}
                hint={shown('assetId') ?? t('inv_hintAsset')}
                options={assets.map((a) => [a, a] as const)}
              />
            </div>
            <fieldset>
              <legend>{t('inv_linesTitle')}</legend>
              <p className="lt-hint">{t(hasLines ? 'inv_linesBody' : 'inv_linesBodyEmpty')}</p>
              {draft.lineItems.map((line, index) => {
                const problem = touched.lineItems ? lineProblem(line) : null;
                const amount = lineAmount(line);
                return (
                  <div role="group" aria-label={t('inv_lineN', { n: index + 1 })} key={index}>
                    <SelectField
                      label={t('inv_lineKind')}
                      value={line.kind}
                      onChange={(value) => setLine(index, { kind: value === 'credit' ? 'credit' : 'charge' })}
                      options={[
                        ['charge', t('inv_kindCharge')],
                        ['credit', t('inv_kindCredit')],
                      ]}
                    />
                    <Field
                      label={t('inv_lineDescription')}
                      value={line.description}
                      maxLength={500}
                      onChange={(e) => setLine(index, { description: e.target.value })}
                      error={problem === 'description' ? t('inv_lineProblem_description') : undefined}
                    />
                    <Field
                      label={t('inv_lineQuantity')}
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => setLine(index, { quantity: e.target.value })}
                      error={problem === 'quantity' ? t('inv_lineProblem_quantity') : undefined}
                    />
                    <Field
                      label={t('inv_lineUnit')}
                      inputMode="decimal"
                      value={line.unitAmount}
                      onChange={(e) => setLine(index, { unitAmount: e.target.value })}
                      error={
                        problem === 'unitAmount'
                          ? t('inv_lineProblem_unitAmount')
                          : problem === 'places'
                            ? t('inv_lineProblem_places')
                            : undefined
                      }
                    />
                    <div className="lt-field">
                      <span>{t('inv_lineAmount')}</span>
                      <strong>{amount ? <ExactMoney value={amount} asset={asset} /> : '—'}</strong>
                    </div>
                    <Button
                      tone="quiet"
                      aria-label={t('inv_lineRemoveN', { n: index + 1 })}
                      onClick={() => setLines(draft.lineItems.filter((_, i) => i !== index))}
                    >
                      {t('inv_lineRemove')}
                    </Button>
                  </div>
                );
              })}
              <Actions>
                <Button
                  tone="secondary"
                  onClick={() => setLines([...draft.lineItems, blankLine()])}
                  disabled={draft.lineItems.length >= MAX_INVOICE_LINES}
                >
                  {t(hasLines ? 'inv_lineAdd' : 'inv_linesStart')}
                </Button>
              </Actions>
            </fieldset>
            <div>
              <Field
                label={t('inv_fieldCustomer')}
                value={draft.customerRef}
                onChange={(e) => set('customerRef')(e.target.value)}
                hint={t('inv_hintCustomer')}
                error={shown('customerRef')}
              />
              <Field
                label={t('inv_fieldEmail')}
                type="email"
                autoComplete="off"
                value={draft.customerEmail}
                onChange={(e) => set('customerEmail')(e.target.value)}
                hint={t('inv_hintEmail')}
                error={shown('customerEmail')}
              />
            </div>
            <Field
              label={t('inv_fieldDue')}
              type="date"
              min={today}
              value={draft.dueDate}
              onChange={(e) => set('dueDate')(e.target.value)}
              hint={t('inv_hintDue')}
              error={shown('dueDate')}
            />
            <TextArea
              label={t('inv_fieldDescription')}
              rows={3}
              maxLength={2000}
              value={draft.description}
              onChange={set('description')}
              hint={shown('description') ? undefined : t('inv_hintDescription')}
              error={shown('description')}
            />
            <PortalReview
              title={t('inv_create')}
              variant="primary"
              description={t('inv_reviewCreateBody')}
              disabled={!ready}
              disabledReason={t('inv_fixFields')}
              review={
                ready && (
                  <>
                    <Facts
                      items={[
                        [t('inv_colAmount'), <ExactMoney value={total} asset={asset} />],
                        [t('inv_colCustomer'), draft.customerRef.trim() || '—'],
                        [t('inv_fieldEmail'), draft.customerEmail.trim() || '—'],
                        [t('inv_colDue'), draft.dueDate ? <DateTime value={dueAtOf(draft.dueDate)} dayOnly /> : t('inv_noDue')],
                        [t('inv_colDescription'), draft.description.trim() || '—'],
                        [t('inv_colStatus'), t('inv_willBeDraft')],
                      ]}
                    />
                    {hasLines && <LineTable lines={reviewLines(draft)} asset={asset} total={total} />}
                  </>
                )
              }
              perform={() => {
                request.sent();
                return portal.createInvoice({ requestId: request.id, ...invoiceBody(draft) });
              }}
              onConfirmed={(invoice) => {
                request.renew();
                navigate(invoiceHref(invoice.id));
              }}
            />
          </div>
        </Section>
      }
      actions={
        <a className="lt-link" href="/pay/invoices">
          ← {t('inv_back')}
        </a>
      }
    />
  );
}

/** The lines as the review shows them: each with its exact signed amount. */
function reviewLines(draft: InvoiceDraft): InvoiceLine[] {
  return draft.lineItems.map((line) => ({
    kind: line.kind,
    description: line.description.trim(),
    quantity: line.quantity.trim(),
    unitAmount: line.unitAmount.trim(),
    amount: lineAmount(line) ?? '0',
  }));
}

/** The lines of the invoice under review, a credit marked as one, with the exact total underneath (`Invoices.tsx`'s `LineTable` on the kit). */
function LineTable({ lines, asset, total }: { lines: readonly InvoiceLine[]; asset: string; total: string }) {
  const { t } = c.useCopy();
  const rows = lines.map((line, index) => ({ line, index }));
  return (
    <>
      <Table
        caption={t('inv_linesTitle')}
        rows={rows}
        rowKey={(row) => String(row.index)}
        columns={[
          {
            key: 'item',
            label: t('inv_colItem'),
            cell: ({ line }) => (
              <>
                {line.description}
                {line.kind === 'credit' && <span className="lt-hint">{t('inv_kindCredit')}</span>}
              </>
            ),
          },
          { key: 'quantity', label: t('inv_lineQuantity'), align: 'end', cell: ({ line }) => line.quantity },
          { key: 'unit', label: t('inv_lineUnit'), align: 'end', cell: ({ line }) => <ExactMoney value={line.unitAmount} asset={asset} /> },
          { key: 'amount', label: t('inv_lineAmount'), align: 'end', cell: ({ line }) => <ExactMoney value={line.amount} asset={asset} /> },
        ]}
      />
      <KeyValue
        rows={[
          {
            label: t('inv_fieldTotal'),
            total: true,
            value: (
              <strong>
                <ExactMoney value={total} asset={asset} />
              </strong>
            ),
          },
        ]}
      />
    </>
  );
}
