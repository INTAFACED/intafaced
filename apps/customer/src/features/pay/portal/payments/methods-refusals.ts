import { registerRefusals } from '../refusal';
import { methodsCopy } from './methods-copy';

/** Plain words for the refusals saving the payment methods can meet. The codes never reach the screen. */
registerRefusals({
  'pay.checkout_methods_stale': () => methodsCopy.t('rStale'),
  'pay.checkout_methods_interactive_only': () => methodsCopy.t('rInteractive'),
  'pay.checkout_method_rule_inverted': () => methodsCopy.t('rInverted'),
});
