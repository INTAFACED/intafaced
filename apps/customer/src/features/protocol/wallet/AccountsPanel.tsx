import { useMemo } from 'react';
import { Button, DataTable, EmptyState, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session/session';
import { createProtocolApi } from '../api';
import { safetyCopy } from './safety-copy';
import { walletCopy } from './copy';
import { useWallet } from './WalletProvider';

/**
 * /wallet/accounts (D-portfolio-wallet-02): the accounts the connected wallet controls on this network, read from the
 * service (its smart account by CREATE2 and whether it has code), and the multi-signature control, visible and disabled
 * with its real blocker until the multi-signature contract exists. Nothing here is a custodial balance.
 */
export function AccountsPanel() {
  const { language } = usePreferences();
  const { t } = safetyCopy.forLocale(language);
  const { t: tw } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const owner = wallet.status === 'connected' ? wallet.address : null;
  const headers = [t('hdr_account'), t('hdr_address'), t('hdr_status')];
  return (
    <>
      <Panel title={t('subAccountsTitle')}>
        <p className="muted">{t('subAccountsNote')}</p>
        {owner ? (
          <OwnedAccounts owner={owner} headers={headers} />
        ) : (
          <DataTable label={t('subAccountsTitle')} headers={headers}>
            <tr>
              <td colSpan={headers.length}>
                <EmptyState title={tw('needsWallet')} />
              </td>
            </tr>
          </DataTable>
        )}
        <p className="muted">{t('custodialNote')}</p>
      </Panel>
      <Panel title={t('multisigTitle')}>
        <p className="muted">{t('multisigNote')}</p>
        <Button variant="secondary" disabled aria-disabled="true" aria-describedby="wallet-multisig-blocker">
          {t('multisigCreate')}
        </Button>
        <p id="wallet-multisig-blocker" className="protocol-actions__reason" role="note" data-blocker="multisig_contract">
          {t('multisigBlocked')}
        </p>
      </Panel>
    </>
  );
}

function OwnedAccounts({ owner, headers }: { owner: string; headers: string[] }) {
  const { language } = usePreferences();
  const { t } = safetyCopy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const { resource } = useResource((signal) => api.predictAccount(owner, signal), `wallet:accounts:${owner.toLowerCase()}`);
  return (
    <DataTable label={t('subAccountsTitle')} headers={headers}>
      <tr>
        <td>{t('accountWallet')}</td>
        <td className="numeric">{owner}</td>
        <td>{t('accountWalletStatus')}</td>
      </tr>
      <tr data-account="smart">
        <td>{t('accountSmart')}</td>
        <td className="numeric">{resource.status === 'ready' ? resource.data.address : '—'}</td>
        <td>
          {resource.status === 'loading' ? (
            <span role="status">{t('accountReading')}</span>
          ) : resource.status === 'ready' ? (
            resource.data.deployed ? (
              t('accountDeployed')
            ) : (
              t('accountNotDeployed')
            )
          ) : (
            t('accountUnreadable', { reason: smartAccountReason(resource.failure.message) })
          )}
        </td>
      </tr>
    </DataTable>
  );
}

/** The service's refusal in plain words: an unset factory is named as not deployed; anything else as not answering. */
export function smartAccountReason(message: string): string {
  return /factory/i.test(message) ? 'the smart account factory is not deployed on this network' : 'the network did not answer';
}
