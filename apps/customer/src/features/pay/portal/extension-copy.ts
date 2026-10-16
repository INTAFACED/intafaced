import { defineCopy } from '../../../shared/i18n';

export const extensionCopy = defineCopy('pay.portal.w3c2', {
  arrives: 'Arrives with the next backend update',
  backHome: 'Back to overview',
  backInvoices: 'Back to invoices',
  invoicesTitle: 'Invoices',
  invoiceTitle: 'Invoice detail',
  invoicesPurpose: 'Track invoices, their payment status and the next action for each customer.',
  openSubscriptions: 'Open subscriptions',
  invoiceGap:
    'Standalone invoice records are not available yet. Open, paid and overdue totals, invoice search and export will appear when the invoice read is connected. No invoice totals are estimated.',
  invoiceDetailGap:
    'This invoice cannot be read yet. Line items, payment applications, due dates and the audit trail need the invoice detail read. This page does not confirm whether the reference exists.',
  invoiceActions: 'Invoice actions',
  invoiceActionsGap:
    'Creating, sending, reminding and voiding standalone invoices need invoice procedures. No invoice has been sent or changed.',
  recurringInvoices: 'Recurring invoice payments',
  recurringInvoicesBody:
    'Existing subscriptions record invoice executions and link to any payment created. Inspect those records from the subscription; they are not standalone invoice balances.',
  createInvoice: 'Create invoice',
  invoiceReason: 'Invoice creation is unavailable until the invoice procedures arrive.',
  reference: 'Reference',
  copy: 'Copy reference',
  copied: 'Copied',
  copyFailed: 'Copy failed. Select the reference and copy it manually.',
});
