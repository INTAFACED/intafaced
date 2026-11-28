// volt-room: /pay/invoices/new
// volt-room: portal:invoice-new
import { useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { TextAreaField } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../../app/location';
import type { PortalApi } from '../api';
import { DateTime } from '../ui/DateTime';
import { FlowRoom } from '../volt/FlowRoom';
import { BackLink, Facts, MoneyText, Section, SelectField } from '../volt/parts';
import { Review } from '../volt/Review';
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
} from './invoice-model';
import { paymentsCopy as c } from './copy';
import { DEFAULT_ASSET, useAssetChoices } from './asset-choices';
import { invoiceHref, LineTable } from './Invoices';
import './refusals';
import type { InvoiceLine } from './schemas';

/** `/pay/invoices/new` on the flow template: creates a draft invoice for roles with `invoices.write`. */
export function InvoiceNewRoom({ portal }: { portal: PortalApi }) {
  return <FlowRoom need="invoices.write">{({ merchantId }) => <InvoiceCreate portal={portal} merchantId={merchantId} />}</FlowRoom>;
}

/** `/pay/invoices/new`: an amount (or line items that add up to it), who it is for, when it is due. Review shows the exact total; a lost reply is safe to resend. */
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
    <div className="lt-stack">
      <BackLink href="/pay/invoices">{t('inv_back')}</BackLink>
      <Section title={t('inv_createTitle')} description={t('inv_createBody')}>
        <div data-testid="form-stack" className="lt-stack">
          <div className="lt-field-row">
            {hasLines ? (
              <div data-testid="pp-line-total" className="lt-field" role="group" aria-label={t('inv_fieldTotal')}>
                <span>{t('inv_fieldTotal')}</span>
                <strong className="lt-num">{total ? <MoneyText value={total} asset={asset} /> : '—'}</strong>
                <small>{shown('lineItems') ?? t('inv_hintTotal')}</small>
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
          <fieldset className="lt-group lt-stack">
            <legend>{t('inv_linesTitle')}</legend>
            <p className="lt-muted">{t(hasLines ? 'inv_linesBody' : 'inv_linesBodyEmpty')}</p>
            {draft.lineItems.map((line, index) => {
              const problem = touched.lineItems ? lineProblem(line) : null;
              const amount = lineAmount(line);
              return (
                <div className="lt-field-row" role="group" aria-label={t('inv_lineN', { n: index + 1 })} key={index}>
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
                    <strong className="lt-num">{amount ? <MoneyText value={amount} asset={asset} /> : '—'}</strong>
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
            <div className="lt-actions">
              <Button
                tone="secondary"
                onClick={() => setLines([...draft.lineItems, blankLine()])}
                disabled={draft.lineItems.length >= MAX_INVOICE_LINES}
              >
                {t(hasLines ? 'inv_lineAdd' : 'inv_linesStart')}
              </Button>
            </div>
          </fieldset>
          <div className="lt-field-row">
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
          <TextAreaField
            label={t('inv_fieldDescription')}
            rows={3}
            maxLength={2000}
            value={draft.description}
            onChange={set('description')}
            hint={t('inv_hintDescription')}
            error={shown('description')}
          />
          <Review
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
                      [t('inv_colAmount'), <MoneyText value={total} asset={asset} />],
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
    </div>
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
