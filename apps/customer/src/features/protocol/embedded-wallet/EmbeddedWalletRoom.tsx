import { useMemo, useRef, useState } from 'react';
import { Button } from '@intafaced/ui';
import { Tag } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { Refusal, RoomState } from '@intafaced/ui/lit/templates';
import type { ProtocolEmbeddedWalletProvider, ProtocolEmbeddedWalletRecord } from '@intafaced/contracts/protocol-embedded-wallet';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { createVenueWalletApi, type VenueConnection } from '../venue-wallet/venue-wallet-api';
import { venueWalletCopy } from '../venue-wallet/venue-wallet-copy';
import { venueRefusal } from '../venue-wallet/VenueWalletRoom';
import { createEmbeddedWalletApi } from './embedded-wallet-api';
import { embeddedWalletCopy, type EmbeddedWalletCopyKey } from './embedded-wallet-copy';
import { embeddedWalletClient, type ClientFailure } from './provider-client';

/**
 * /wallet/embedded (J-wallet-22, OWNER 237), on the flow template: the signed-in person gets their own self-custody
 * wallet with a passkey and no seed phrase. The room names the provider (where the key is kept), makes the passkey on
 * this device, and asks svc-protocol to have the provider make the person's one wallet; svc-protocol records only the
 * address and the provider's wallet id. Connecting to the venue reuses J-wallet-09's connection: the message is signed by
 * the wallet at the provider, after the person's passkey. Export and recovery are the provider's own, after the passkey;
 * the exported key is shown here and never sent to INTAFACED.
 */

type T = ReturnType<typeof embeddedWalletCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

function codeOf(failure: Failed): string | undefined {
  return failure.code ?? /^([a-z_]+\.[a-z_.]+):/.exec(failure.message ?? '')?.[1];
}

const providerName = (provider: ProtocolEmbeddedWalletProvider | null, t: T) => provider?.displayName ?? t('walletProvider');

/** A service refusal in the room's own words. */
export function embeddedRefusal(failure: Failed, provider: ProtocolEmbeddedWalletProvider | null, t: T): Refusal {
  const code = codeOf(failure);
  const reference = code ?? failure.reason;
  const said = (title: EmbeddedWalletCopyKey, body: EmbeddedWalletCopyKey): Refusal => ({
    variant: 'refused',
    title: t(title as 'unsetTitle'),
    body: t(body as 'downBody', { provider: providerName(provider, t) }),
    reference,
  });
  switch (code) {
    case 'wallet.embedded_provider_unset':
      return said('unsetTitle', 'unsetBody');
    case 'wallet.embedded_provider_unwired':
      return said('unwiredTitle', 'unwiredBody');
    case 'wallet.embedded_provider_down':
      return { ...said('downTitle', 'downBody'), variant: 'unreachable' };
    case 'wallet.embedded_wallet_mismatch':
      return said('mismatchTitle', 'mismatchBody');
    case 'denied.region_blocked':
      return { variant: 'refused', title: t('regionTitle'), body: t('regionBody', { reason: failure.message ?? code }), reference };
    default:
      return {
        variant: failure.reason === 'unreachable' || failure.reason === 'uncertain' ? 'unreachable' : 'refused',
        title: t('otherTitle'),
        body: t('otherBody'),
        reference,
      };
  }
}

/** A failure at the provider or the passkey, on this device, in the room's words. The provider is named. */
export function clientRefusal(failure: ClientFailure, provider: ProtocolEmbeddedWalletProvider | null, t: T): Refusal {
  const name = providerName(provider, t);
  switch (failure) {
    case 'down':
      return {
        variant: 'unreachable',
        title: t('downTitle'),
        body: t('downBody', { provider: name }),
        reference: 'wallet.embedded_provider_down',
      };
    case 'refused':
      return { variant: 'refused', title: t('refusedTitle'), body: t('refusedBody', { provider: name }), reference: 'provider_refused' };
    case 'unsupported':
      return { variant: 'refused', title: t('unsupportedTitle'), body: t('unsupportedBody'), reference: 'passkey_unsupported' };
    default:
      return { variant: 'refused', title: t('passkeyTitle'), body: t('passkeyBody'), reference: 'passkey_not_passed' };
  }
}

export function EmbeddedWalletRoom() {
  const { t } = embeddedWalletCopy.useCopy();
  const venueCopy = venueWalletCopy.useCopy();
  const { api, userId } = useSession();
  const embedded = useMemo(() => createEmbeddedWalletApi(api), [api]);
  const venue = useMemo(() => createVenueWalletApi(api), [api]);
  const status = useResource(
    (signal) => (userId ? embedded.status(signal) : Promise.resolve({ ok: true as const, data: { provider: null, wallet: null } })),
    `embedded-wallet:${userId ?? 'out'}`,
  );
  const connections = useResource(
    (signal) => (userId ? venue.status(signal) : Promise.resolve({ ok: true as const, data: { connections: [] } })),
    `embedded-wallet-venue:${userId ?? 'out'}`,
  );
  const [made, setMade] = useState<ProtocolEmbeddedWalletRecord | null>(null);
  const [opened, setOpened] = useState<VenueConnection | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const read = status.resource.status === 'ready' ? status.resource.data : null;
  const provider = read?.provider ?? null;
  const wallet = made ?? read?.wallet ?? null;
  const client = embeddedWalletClient(provider);
  const name = providerName(provider, t);
  const listed = connections.resource.status === 'ready' ? connections.resource.data.connections : [];
  const fromServer = wallet ? listed.find((c) => c.address.toLowerCase() === wallet.address.toLowerCase()) : undefined;
  const connection = opened && wallet && opened.address === wallet.address ? opened : (fromServer ?? null);
  const live = connection !== null && connection.status === 'live' && Date.parse(connection.expiresAt) > Date.now();

  /** One flight at a time: a second press while the first has no answer does nothing. */
  async function once(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    setNotice(null);
    try {
      await work();
    } catch {
      setRefusal({ variant: 'unreachable', title: t('otherTitle'), body: t('otherBody') });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const create = () =>
    once(async () => {
      // The wallet this person already has comes back first, before any passkey is made.
      const latest = await embedded.status();
      if (!latest.ok) return setRefusal(embeddedRefusal(latest, provider, t));
      if (latest.data.wallet) return setMade(latest.data.wallet);
      if (!latest.data.provider)
        return setRefusal(
          embeddedRefusal(
            { ok: false, reason: 'error', message: 'wallet.embedded_provider_unset:', code: 'wallet.embedded_provider_unset' },
            null,
            t,
          ),
        );
      const latestClient = embeddedWalletClient(latest.data.provider);
      if (!latestClient)
        return setRefusal(
          embeddedRefusal(
            { ok: false, reason: 'error', message: 'wallet.embedded_provider_unwired:', code: 'wallet.embedded_provider_unwired' },
            latest.data.provider,
            t,
          ),
        );
      const passkey = await latestClient.createPasskey();
      if (!passkey.ok) return setRefusal(clientRefusal(passkey.failure, latest.data.provider, t));
      const result = await embedded.create(passkey.data);
      if (!result.ok) return setRefusal(embeddedRefusal(result, latest.data.provider, t));
      setMade(result.data.wallet);
    });

  const connect = () =>
    once(async () => {
      if (!wallet || !client) return;
      const challenge = await venue.challenge({ address: wallet.address, origin: window.location.origin });
      if (!challenge.ok) return setRefusal(venueRefusal(challenge, venueCopy.t));
      const signed = await client.signMessage(wallet.providerWalletId, challenge.data.message);
      if (!signed.ok) return setRefusal(clientRefusal(signed.failure, provider, t));
      const result = await venue.open({ challenge: challenge.data.challenge, signature: signed.data.signature });
      if (!result.ok) return setRefusal(venueRefusal(result, venueCopy.t));
      setOpened(result.data);
    });

  const exportKey = () =>
    once(async () => {
      if (!wallet || !client) return;
      const result = await client.exportKey(wallet.providerWalletId);
      if (!result.ok) return setRefusal(clientRefusal(result.failure, provider, t));
      setExported(result.data.privateKey);
    });

  const addRecovery = () =>
    once(async () => {
      if (!wallet || !client) return;
      const result = await client.addRecoveryPasskey(wallet.providerWalletId);
      if (!result.ok) return setRefusal(clientRefusal(result.failure, provider, t));
      setNotice(t('recoveryAdded', { provider: name, count: String(result.data.passkeys) }));
    });

  const state: RoomState = useMemo(() => {
    if (!userId)
      return {
        kind: 'refused',
        refusal: {
          variant: 'refused',
          title: t('signedOutTitle'),
          body: t('signedOutBody'),
          action: { label: t('signIn'), href: '/login?redirect=%2Fwallet%2Fembedded' },
        },
      };
    if (status.resource.status === 'loading') return { kind: 'loading' };
    if (status.resource.status === 'failed') {
      const failure = status.resource.failure;
      // A visitor from a blocked region: the refusal with its reason, and Create my wallet, which is refused the same way.
      if (codeOf(failure) === 'denied.region_blocked')
        return { kind: 'ready', partial: { missing: refusal ?? embeddedRefusal(failure, null, t) } };
      return {
        kind: 'refused',
        refusal: {
          variant: 'unreachable',
          title: t('readFailedTitle'),
          body: t('readFailedBody'),
          reference: codeOf(failure) ?? failure.reason,
          action: { label: t('tryAgain'), href: '/wallet/embedded' },
        },
      };
    }
    if (refusal) return { kind: 'ready', partial: { missing: refusal } };
    return { kind: 'ready' };
  }, [userId, status.resource, refusal, t]);

  const time = (iso: string) => new Date(iso).toLocaleString();
  const current = wallet ? 2 : busy ? 1 : 0;

  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      roomAction={<a href="/wallet">{t('backToWallet')}</a>}
      state={state}
      steps={{ labels: [t('stepCreate'), t('stepPasskey'), t('stepReady')], current }}
      step={
        <section data-panel="embedded-wallet">
          {provider ? <p data-embedded-provider>{t('keptBy', { provider: name })}</p> : null}
          <p>{t('noSeed')}</p>
          {wallet ? (
            <>
              <h2>{t('walletTitle')}</h2>
              <dl>
                <div>
                  <dt>{t('walletAddress')}</dt>
                  <dd>
                    <span data-embedded-address>{wallet.address}</span>{' '}
                    {wallet.test ? (
                      <Tag tone="neutral" data-test-label>
                        TEST
                      </Tag>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>{t('walletProvider')}</dt>
                  <dd>{name}</dd>
                </div>
                <div>
                  <dt>{t('walletId', { provider: name })}</dt>
                  <dd data-embedded-wallet-id>{wallet.providerWalletId}</dd>
                </div>
              </dl>
              {wallet.test ? <p>{t('testWallet')}</p> : null}
              <p data-embedded-record>{t('recordNote', { provider: name })}</p>
              <section aria-label={t('venueTitle')}>
                <h2>{t('venueTitle')}</h2>
                {connection ? (
                  <p>
                    {t('venueConnected')}{' '}
                    <time dateTime={connection.expiresAt} data-testid="embedded-venue-expires">
                      {time(connection.expiresAt)}
                    </time>
                  </p>
                ) : null}
                {connection && !live ? <p role="status">{t('venueExpired')}</p> : null}
                <p>{t('venueNote')}</p>
                {!live ? (
                  <Button disabled={busy || !client} onClick={() => void connect()}>
                    {connection ? t('venueSignAgain') : t('venueConnect')}
                  </Button>
                ) : null}
              </section>
              <section aria-label={t('ownTitle')}>
                <h2>{t('ownTitle')}</h2>
                <p>{t('ownNote', { provider: name })}</p>
                {provider?.capabilities.export ? (
                  <Button disabled={busy || !client} onClick={() => void exportKey()}>
                    {t('exportKey')}
                  </Button>
                ) : (
                  <p>{t('exportNone', { provider: name })}</p>
                )}{' '}
                {provider?.capabilities.recovery ? (
                  <Button disabled={busy || !client} onClick={() => void addRecovery()}>
                    {t('recoveryAdd')}
                  </Button>
                ) : (
                  <p>{t('recoveryNone', { provider: name })}</p>
                )}
                {notice ? <p role="status">{notice}</p> : null}
                {exported ? (
                  <section aria-label={t('exportTitle', { provider: name })} data-provider-export>
                    <h3>{t('exportTitle', { provider: name })}</h3>
                    <p>{t('exportWarning')}</p>
                    <pre data-exported-key>{exported}</pre>
                    <Button onClick={() => setExported(null)}>{t('exportHide')}</Button>
                  </section>
                ) : null}
              </section>
            </>
          ) : null}
        </section>
      }
      actions={
        wallet ? null : (
          <Button variant="primary" loading={busy} disabled={busy} onClick={() => void create()}>
            {busy ? t('creating') : t('create')}
          </Button>
        )
      }
      summary={
        <div>
          <h2>{t('summaryTitle')}</h2>
          <p>{t('summaryOne')}</p>
          <p>{t('summaryKey')}</p>
          <p>{t('summaryDevice')}</p>
        </div>
      }
    />
  );
}
