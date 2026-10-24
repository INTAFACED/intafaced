import { registerRefusals } from '../../refusal';
import { categoryCopy } from './category-copy';

/** Plain words for the refusals choosing a category, or paying under one, can meet. The codes never reach the screen. */
registerRefusals({
  'pay.business_category_policy_unset': () => categoryCopy.t('rUnset'),
  'pay.category_policy_changed': () => categoryCopy.t('rChanged'),
  'pay.category_not_found': () => categoryCopy.t('rNotFound'),
  'pay.category_locked': () => categoryCopy.t('rLocked'),
  'pay.category_prohibited': () => categoryCopy.t('rProhibited'),
  'pay.reserve_terms_unset': () => categoryCopy.t('rReserveUnset'),
  'pay.category_rail_refused': () => categoryCopy.t('rRailRefused'),
});
