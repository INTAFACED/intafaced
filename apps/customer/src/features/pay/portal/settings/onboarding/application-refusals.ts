import { registerRefusals } from '../../refusal';
import { applicationCopy } from './application-copy';

/** Plain words for the refusals the business application can meet. The codes never reach the screen. */
registerRefusals({
  'pay.kyb_requirements_unset': () => applicationCopy.t('rTypeUnset'),
  'pay.kyb_country_not_served': () => applicationCopy.t('rCountry'),
  'pay.kyb_application_exists': () => applicationCopy.t('rExists'),
  'pay.kyb_section_version_conflict': () => applicationCopy.t('rVersion'),
  'pay.kyb_application_submitted': () => applicationCopy.t('rSubmitted'),
  'pay.kyb_incomplete': () => applicationCopy.t('rIncomplete'),
  'pay.kyb_documents_missing': () => applicationCopy.t('rDocsMissing'),
  'pay.kyb_upload_rules_unset': () => applicationCopy.t('rRulesUnset'),
  'pay.kyb_doc_key_unset': () => applicationCopy.t('rStoreUnset'),
  'pay.kyb_document_too_large': () => applicationCopy.t('rTooLarge'),
  'pay.kyb_document_type_refused': () => applicationCopy.t('rType'),
  'pay.kyb_document_key_unknown': () => applicationCopy.t('rDocUnknown'),
  'pay.kyb_document_empty': () => applicationCopy.t('rDocEmpty'),
  'pay.kyb_document_same_file': () => applicationCopy.t('rSameFile'),
  'pay.kyb_application_not_found': () => applicationCopy.t('rNotFound'),
  'pay.kyb_application_changed': () => applicationCopy.t('rChanged'),
  'pay.kyb_invalid': () => applicationCopy.t('rKybInvalid'),
});
