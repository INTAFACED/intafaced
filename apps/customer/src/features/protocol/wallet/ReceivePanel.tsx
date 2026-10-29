import { useMemo, useState } from 'react';
import { Button, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { encodeQr, qrPath } from '../../pay/personal/qr';
import { networkLabel } from '../blockers';
import { walletCopy } from './copy';
import { APP_CHAIN_ID } from './eip1193';
import { receivePayload } from './transfer';
import { useWallet } from './WalletProvider';

/**
 * Receive: the connected wallet's address, a code a phone wallet can scan (EIP-681 on the app's network) and the network
 * named, because tokens sent on another network do not arrive (D-portfolio-wallet-03).
 */
export function ReceivePanel() {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const network = networkLabel(APP_CHAIN_ID).name;
  const address = wallet.status === 'connected' ? wallet.address : null;
  const drawn = useMemo(() => {
    if (!address) return null;
    try {
      return qrPath(encodeQr(receivePayload(address), 'M'), 4);
    } catch {
      return null;
    }
  }, [address]);

  return (
    <Panel title={t('receiveTitle')}>
      <section aria-label={t('receiveTitle')}>
        <p className="muted">{t('receiveNote')}</p>
        {!address ? (
          <p className="muted">{t('needsWallet')}</p>
        ) : (
          <>
            <dl className="protocol-facts">
              <div>
                <dt>{t('receiveAddress')}</dt>
                <dd className="numeric" data-receive-address>
                  {address}
                </dd>
              </div>
            </dl>
            {drawn ? (
              <div className="protocol-qr">
                <svg viewBox={`0 0 ${drawn.size} ${drawn.size}`} role="img" aria-label={t('receiveCode')} shapeRendering="crispEdges">
                  <path d={drawn.d} fill="currentColor" />
                </svg>
              </div>
            ) : (
              <p role="alert">{t('qrFailed')}</p>
            )}
            <p role="note">{t('receiveWarning', { network })}</p>
            <Button
              variant="secondary"
              onClick={() => {
                if (!navigator.clipboard) return setCopied('failed');
                navigator.clipboard.writeText(address).then(
                  () => setCopied('copied'),
                  () => setCopied('failed'),
                );
              }}
            >
              {t('receiveCopy')}
            </Button>
            {copied !== 'idle' && <p role="status">{copied === 'copied' ? t('receiveCopied') : t('receiveCopyFailed')}</p>}
          </>
        )}
      </section>
    </Panel>
  );
}
