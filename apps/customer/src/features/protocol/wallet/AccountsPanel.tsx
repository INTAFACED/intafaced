import { useMemo, type ReactNode } from 'react';
import { Button, DataTable, EmptyState, Failure, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi, useSession } from '../../session/session';
import { useVenueMode } from '../../trade/use-venue-mode';
import { venueApi } from '../../trade/venue-api';
import { AsOfLine, TestMark } from '../../trade/venue/VenueKit';
import { createProtocolApi } from '../api';
import { safetyCopy } from './safety-copy';
import { walletCopy } from './copy';
import { useWallet } from './WalletProvider';

/**
 * /wallet/accounts (D-portfolio-wallet-02): the accounts the connected wallet controls on this network, read from the
 * service (its smart account by CREATE2 and whether it has code); the wallet's own sub-accounts on the trading venue,
 * as the venue lists them (J-dex-protocol-08 #4); and the multi-signature control, visible and disabled with its real
 * blocker until the multi-signature contract exists. Nothing here is a custodial balance: INTAFACED holds no sub-account.
 */
export function AccountsPanel() {
  const { language } = usePreferences();
  const { t } = safetyCopy.forLocale(language);
  const { t: tw } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const connected = wallet.status === 'connected' ? wallet.address : null;
  // A wallet on another network is told so: the accounts read here are this network's, not the wallet's current one.
  const wrongNetwork = connected !== null && wallet.guard !== null && wallet.guard !== undefined && !wallet.guard.ok;
  const owner = wrongNetwork ? null : connected;
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
                <EmptyState title={wrongNetwork ? t('accountsWrongNetwork') : tw('needsWallet')} />
              </td>
            </tr>
          </DataTable>
        )}
        <VenueSubAccounts owner={owner} />
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
  const { resource, reload } = useResource((signal) => api.predictAccount(owner, signal), `wallet:accounts:${owner.toLowerCase()}`);
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
          ) : isFactoryUnset(resource.failure.message) ? (
            t('accountFactoryUnset')
          ) : (
            <Failure result={resource.failure} retry={reload} />
          )}
        </td>
      </tr>
    </DataTable>
  );
}

/**
 * The wallet's own sub-accounts on the trading venue, read on its main venue account through svc-trade's user-venue door
 * (`/venue/sub-accounts`): each with the name and address the venue gives it, the venue named, with the venue's as-of
 * time. Signed out, with the door off, or with the venue down, it says which, and lists nothing.
 */
function VenueSubAccounts({ owner }: { owner: string | null }) {
  const { language } = usePreferences();
  const { t } = safetyCopy.forLocale(language);
  const { userId } = useSession();
  const mode = useVenueMode();
  let body: ReactNode;
  if (!userId) body = <p className="muted">{t('venueSubsSignIn')}</p>;
  else if (mode.mode === 'checking') body = <p role="status">{t('venueSubsChecking')}</p>;
  else if (mode.mode === 'off') body = <p className="muted">{t('venueSubsOff')}</p>;
  else if (!mode.status.available)
    body = (
      <p role="alert" data-code={mode.status.refusal.code}>
        {t('venueSubsDown', { detail: mode.status.refusal.detail })}
      </p>
    );
  else if (!owner) body = null;
  else body = <VenueSubAccountList owner={owner} venueName={mode.status.venue.displayName} test={mode.status.test} />;
  return (
    <section data-section="venue-sub-accounts">
      <h3>{t('venueSubsTitle')}</h3>
      {body}
    </section>
  );
}

function VenueSubAccountList({ owner, venueName, test }: { owner: string; venueName: string; test: boolean }) {
  const { language } = usePreferences();
  const { t } = safetyCopy.forLocale(language);
  const { api } = useSession();
  const venue = useMemo(() => venueApi(api), [api]);
  const { resource, reload } = useResource((signal) => venue.subAccounts(owner, signal), `wallet:venue-subs:${owner.toLowerCase()}`);
  const headers = [t('hdr_name'), t('hdr_address')];
  return (
    <>
      <p data-testid="venue-subs-venue">
        {t('venueSubsOn', { venue: venueName })} <TestMark test={test} />
      </p>
      {resource.status === 'loading' ? (
        <p role="status">{t('accountReading')}</p>
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={reload} />
      ) : (
        <>
          <DataTable label={t('venueSubsTitle')} headers={headers}>
            {resource.data.value.length === 0 ? (
              <tr>
                <td colSpan={headers.length}>
                  <EmptyState title={t('venueSubsNone', { venue: venueName })} />
                </td>
              </tr>
            ) : (
              resource.data.value.map((sub) => (
                <tr key={sub.subAccount} data-sub-account={sub.subAccount}>
                  <td>{sub.name}</td>
                  <td className="numeric">{sub.subAccount}</td>
                </tr>
              ))
            )}
          </DataTable>
          <AsOfLine asOf={resource.data.asOf} />
        </>
      )}
    </>
  );
}

/**
 * svc-protocol's `requireAccountFactoryConfigured` refusal (PRECONDITION_FAILED, no typed code on the wire): named as the
 * factory not being deployed. Every other failure, a region refusal or a network that did not answer included, is shown
 * by the shared Failure, which reads its code.
 */
export function isFactoryUnset(message: string): boolean {
  return /factory\/implementation is not configured/i.test(message);
}
