import { registerRefusals } from '../refusal';
import { paymentsCopy } from './copy';

/** Plain words for the service's invoice refusals. A code never reaches the screen. */
registerRefusals({
  'pay.invoice_not_found': () => paymentsCopy.t('inv_r_notFound'),
  'pay.invoice_amount_invalid': () => paymentsCopy.t('inv_r_amount'),
  'pay.invoice_asset_invalid': () => paymentsCopy.t('inv_r_asset'),
  'pay.invoice_text_invalid': () => paymentsCopy.t('inv_r_text'),
  'pay.invoice_status_invalid': () => paymentsCopy.t('inv_r_status'),
  'pay.invoice_paid': () => paymentsCopy.t('inv_r_paid'),
  'pay.invoice_void': () => paymentsCopy.t('inv_r_void'),
  'pay.invoice_already_sent': () => paymentsCopy.t('inv_r_alreadySent'),
  'pay.invoice_not_draft': () => paymentsCopy.t('inv_r_notDraft'),
  'pay.invoice_payment_link_unwired': () => paymentsCopy.t('inv_r_linkUnwired'),
  'pay.invoice_link_deactivate_failed': () => paymentsCopy.t('inv_r_linkDeactivate'),
  'pay.invoice_link_reissue_conflict': () => paymentsCopy.t('inv_r_reissueConflict'),
  'pay.invoice_payment_not_found': () => paymentsCopy.t('inv_r_paymentNotFound'),
  'pay.invoice_payment_not_paid': () => paymentsCopy.t('inv_r_paymentNotPaid'),
  'pay.invoice_payment_mismatch': () => paymentsCopy.t('inv_r_paymentMismatch'),
  'pay.invoice_payment_already_applied': () => paymentsCopy.t('inv_r_paymentApplied'),
});
