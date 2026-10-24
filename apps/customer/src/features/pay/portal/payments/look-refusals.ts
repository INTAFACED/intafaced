import { registerRefusals } from '../refusal';
import { lookCopy } from './look-copy';

/** Plain words for the refusals saving the checkout look can meet. The codes never reach the screen. */
registerRefusals({
  'pay.checkout_logo_rules_unset': () => lookCopy.t('rRulesUnset'),
  'pay.checkout_logo_too_large': () => lookCopy.t('rTooLarge'),
  'pay.checkout_logo_type_refused': () => lookCopy.t('rType'),
  'pay.checkout_logo_unreadable': () => lookCopy.t('rUnreadable'),
  'pay.checkout_branding_stale': () => lookCopy.t('rStale'),
  'pay.checkout_branding_interactive_only': () => lookCopy.t('rInteractive'),
});
