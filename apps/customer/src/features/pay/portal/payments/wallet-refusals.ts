import { registerRefusals } from '../refusal';
import { walletCopy } from './wallet-copy';

/** Plain words for the refusals saving the receiving wallet can meet. The codes never reach the screen. */
registerRefusals({
  'pay.receiving_wallet_private_key': () => walletCopy.t('rPrivateKey'),
  'pay.receiving_wallet_invalid': () => walletCopy.t('rInvalid'),
  'pay.receiving_wallet_stale': () => walletCopy.t('rStale'),
  'pay.receiving_wallet_interactive_only': () => walletCopy.t('rInteractive'),
});
