import { registerRefusals } from '../../refusal';
import { requestsCopy } from './requests-copy';

/** Plain words for the refusals an information-request answer can meet. The codes never reach the screen. */
registerRefusals({
  'pay.kyb_answer_file_infected': () => requestsCopy.t('rInfected'),
  'pay.kyb_scan_unconfigured': () => requestsCopy.t('rScanUnset'),
  'pay.kyb_scan_failed': () => requestsCopy.t('rScanFailed'),
  'pay.kyb_request_already_answered': () => requestsCopy.t('rAnswered'),
  'pay.kyb_request_closed': () => requestsCopy.t('rClosed'),
  'pay.kyb_request_not_found': () => requestsCopy.t('rNotFound'),
  'pay.kyb_answer_empty': () => requestsCopy.t('rEmpty'),
  'pay.kyb_file_invalid': () => requestsCopy.t('rFileInvalid'),
});
