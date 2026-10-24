import { registerRefusals } from '../refusal';
import { catalogCopy } from './copy';

/** Plain words for the refusals adding a product or its image can meet. The codes never reach the screen. */
registerRefusals({
  'pay.product_id_taken': () => catalogCopy.t('rIdTaken'),
  'pay.product_not_found': () => catalogCopy.t('rNotFound'),
  'pay.product_event_details_required': () => catalogCopy.t('rEventRequired'),
  'pay.product_event_details_not_event': () => catalogCopy.t('rEventNotEvent'),
  'pay.product_image_rules_unset': () => catalogCopy.t('rImageRulesUnset'),
  'pay.product_image_too_large': () => catalogCopy.t('rImageTooLarge'),
  'pay.product_image_type_refused': () => catalogCopy.t('rImageType'),
  'pay.product_image_unreadable': () => catalogCopy.t('rImageUnreadable'),
  'pay.product_image_not_found': () => catalogCopy.t('rImageNotFound'),
  'pay.catalog_interactive_only': () => catalogCopy.t('rInteractive'),
});
