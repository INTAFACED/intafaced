import { registerRefusals } from '../refusal';
import { catalogCopy } from './copy';

/** Plain words for the refusals adding a product, its image or its prices can meet. The codes never reach the screen. */
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
  'pay.price_not_found': () => catalogCopy.t('rPriceNotFound'),
  'pay.price_archived': () => catalogCopy.t('rPriceArchived'),
  'pay.product_archived': () => catalogCopy.t('rProductArchived'),
  'pay.price_amount_invalid': () => catalogCopy.t('rPriceAmountInvalid'),
  'pay.price_amount_required': () => catalogCopy.t('rPriceAmountRequired'),
  'pay.price_amount_not_chosen': () => catalogCopy.t('rPriceAmountNotChosen'),
  'pay.price_bounds_required': () => catalogCopy.t('rPriceBoundsRequired'),
  'pay.price_bounds_invalid': () => catalogCopy.t('rPriceBoundsInvalid'),
  'pay.price_bounds_not_fixed': () => catalogCopy.t('rPriceBoundsNotFixed'),
  'pay.price_customer_chosen_one_time': () => catalogCopy.t('rPriceChosenOneTime'),
  'pay.price_amount_below_minimum': () => catalogCopy.t('rPriceBelowMinimum'),
  'pay.price_amount_above_maximum': () => catalogCopy.t('rPriceAboveMaximum'),
  'pay.product_has_prices': () => catalogCopy.t('rHasPrices'),
  'pay.product_deleted': () => catalogCopy.t('rProductDeleted'),
  'pay.subscription_price_terms_differ': () => catalogCopy.t('rSubscriptionPriceTerms'),
});
