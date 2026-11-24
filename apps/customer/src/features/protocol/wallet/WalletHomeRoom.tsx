// volt-room: /wallet
import { useMemo } from 'react';
import { Button } from '@intafaced/ui/lit';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session';
import { createProtocolApi } from '../api';
import type { ProtocolSnapshot } from '../blockers';
import { protocolCopy } from '../copy';
import { WALLET_SECTIONS } from '../routes';
import { Actions, toSource } from '../volt/answer';
import { Panel } from '../volt/parts';
import { ConnectPanel } from './ConnectPanel';
import { walletCopy } from './copy';
import { PortfolioPanel } from './PortfolioPanel';
import { useWalletFrame } from './wallet-frame';
import { WalletPositions } from './WalletPositions';

/**
 * The wallet's overview (/wallet) on the monitor template, inside the wallet's sections: connect, the connected wallet and
 * its network guard, the portfolio read from the chain, and the smart-account, signing-key and link actions, each disabled
 * with the blocker it waits on.
 */
export function WalletHomeRoom() {
  const frame = useWalletFrame('overview');
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const { t: tp } = protocolCopy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const chain = useResource((signal) => api.chainStatus(signal), 'wallet-room:chain');
  const health = useResource((signal) => api.health(signal), 'wallet-room:health');
  const loading = { status: 'loading' as const };
  const snapshot: ProtocolSnapshot = { chain: toSource(chain), health: toSource(health), audit: loading, indexer: loading, dex: loading };
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
            <Panel title={t('section_embedded')}>
              <p className="lt-hint">{t('embeddedNote')}</p>
              <a className="lt-link" href={WALLET_SECTIONS.embedded}>
                {t('embeddedOpen')}
              </a>
            </Panel>
            <ConnectPanel />
            <PortfolioPanel positions={<WalletPositions />} />
            <Panel title={t('enableTitle')}>
              <p className="lt-hint">{t('enableNote')}</p>
              <Button tone="secondary" disabled aria-disabled="true" title={t('enableBlocked')}>
                {t('enableTitle')}
              </Button>
              <p className="lt-hint" role="note" data-blocker="dex_auth">
                {t('enableBlocked')}
              </p>
            </Panel>
            <Actions actions={['smartAccount']} snapshot={snapshot} t={tp} />
            <Panel title={t('keysTitle')}>
              <p className="lt-hint">{t('keysNote')}</p>
              <p className="lt-hint">
                <strong>{t('linkTitle')}.</strong> {t('linkNote')}
              </p>
            </Panel>
          </>
        }
      />
    </div>
  );
}
