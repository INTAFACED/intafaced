// volt-room: /wallet/receive
import { useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { MonitorTemplate, QrCode } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { networkLabel } from '../blockers';
import { Panel } from '../volt/parts';
import { walletCopy } from './copy';
import { APP_CHAIN_ID } from './eip1193';
import { receivePayload } from './transfer';
import { useWallet } from './WalletProvider';
import { useWalletFrame } from './wallet-frame';

/**
 * Receive (/wallet/receive) on the monitor template, inside the wallet's sections: the connected wallet's address, a code
 * a phone wallet can scan (EIP-681 on the app's network) and the network named, because tokens sent on another network
 * do not arrive (D-portfolio-wallet-03).
 */
export function ReceiveRoom() {
  const frame = useWalletFrame('receive');
  return (
    <div lang={frame.lang} data-route="wallet">
      <MonitorTemplate
        title={frame.title}
        description={frame.description}
        state={{ kind: 'ready' }}
        mode="pro"
        figures={[]}
        actions={frame.sections}
        panels={
          <>
            {frame.banner}
            <ReceivePanel />
          </>
        }
      />
    </div>
  );
}

function ReceivePanel() {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const network = networkLabel(APP_CHAIN_ID).name;
  const address = wallet.status === 'connected' ? wallet.address : null;

  return (
    <Panel title={t('receiveTitle')}>
      <section aria-label={t('receiveTitle')}>
        <p className="lt-hint">{t('receiveNote')}</p>
        {!address ? (
          <p className="lt-hint">{t('needsWallet')}</p>
        ) : (
          <>
            <dl className="lt-kv">
              <div>
                <dt>{t('receiveAddress')}</dt>
                <dd>
                  <bdi className="lt-mono" dir="ltr" data-receive-address>
                    {address}
                  </bdi>
                </dd>
              </div>
            </dl>
            <QrCode value={receivePayload(address)} label={t('receiveCode')} failed={t('qrFailed')} />
            <p className="lt-hint" role="note">
              {t('receiveWarning', { network })}
            </p>
            <Button
              tone="secondary"
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
