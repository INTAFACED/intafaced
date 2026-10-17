import { registerRefusals } from '../../refusal';
import { accountCopy } from './copy';

/** Plain words for the refusals the account pages can meet. The codes never reach the screen. */
registerRefusals({
  'pay.profile_interactive_only': () => accountCopy.t('rProfileInteractive'),
  'pay.profile_version_conflict': () => accountCopy.t('rProfileConflict'),
  'pay.profile_version_invalid': () => accountCopy.t('rProfileConflict'),
  'pay.profile_kyb_pending': () => accountCopy.t('rProfileKybPending'),
  'pay.profile_change_pending': () => accountCopy.t('rProfileChangePending'),
  'pay.profile_compliance_review': () => accountCopy.t('rProfileReview'),
  'pay.profile_change_not_found': () => accountCopy.t('rProfileChangeGone'),
  'pay.profile_change_not_pending': () => accountCopy.t('rProfileChangeGone'),
  'pay.profile_field_invalid': () => accountCopy.t('rProfileField'),
  'pay.change_hash_mismatch': () => accountCopy.t('rProfileChangeGone'),
  'pay.profile_self_approval': () => accountCopy.t('rProfileSelf'),
  'pay.profile_withdraw_forbidden': () => accountCopy.t('rProfileWithdraw'),
  'pay.submerchant_not_onboarded': () => accountCopy.t('rNotPlatform'),
  'pay.submerchant_out_of_scope': () => accountCopy.t('rOutOfScope'),
  'pay.submerchant_grant_lateral': () => accountCopy.t('rGrantLateral'),
  'pay.submerchant_grant_self': () => accountCopy.t('rGrantSelf'),
  'pay.submerchant_grant_redundant': () => accountCopy.t('rGrantRedundant'),
  'pay.submerchant_revoke_redundant': () => accountCopy.t('rRevokeRedundant'),
  'pay.submerchant_reason_required': () => accountCopy.t('rReasonRequired'),
  'pay.submerchant_user_already_merchant': () => accountCopy.t('rAlreadyMerchant'),
  'pay.submerchant_too_deep': () => accountCopy.t('rTooDeep'),
  'pay.submerchant_pricing_invalid': () => accountCopy.t('rFeeInvalid'),
});
