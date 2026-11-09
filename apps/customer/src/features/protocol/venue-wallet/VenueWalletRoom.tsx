import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@intafaced/ui';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { Refusal, RoomState } from '@intafaced/ui/lit/templates';
import type { VenueWalletAction } from '@intafaced/contracts/protocol-venue-wallet';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { useWallet } from '../wallet/WalletProvider';
import { createVenueWalletApi, type VenueConnection } from './venue-wallet-api';
import { venueWalletCopy, type VenueWalletCopyKey } from './venue-wallet-copy';

/**
 * /wallet/venue (J-wallet-09), on the flow template: the signed-in person connects the wallet in this browser to their
 * account. Connect asks svc-protocol for the exact message (a wallet on the sanctions list, or a visitor from a blocked
 * region, is refused here with its reason), the plain-words sheet and then the wallet sign it, and the room shows the
 * connection with its expiry. The connection is svc-protocol's record, read back on every visit, so its expiry is the
 * server's: after it, every signed action refuses until the wallet signs again. INTAFACED holds no key for the wallet.
 * Deposit and withdraw check the connection first; until a venue is wired they answer `protocol.venue_unwired`.
 */

type T = ReturnType<typeof venueWalletCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** The service's code: the code that leads the message (`protocol.x: …`), or the error's own code. */
function codeOf(failure: Failed): string | undefined {
  return failure.code ?? /^([a-z_]+\.[a-z_.]+):/.exec(failure.message ?? '')?.[1];
}

/** A refusal in the room's own words. The region's reason is the owner's text on the per-country switch. */
export function venueRefusal(failure: Failed, t: T): Refusal {
  const code = codeOf(failure);
  const reference = code ?? failure.reason;
  const said = (title: VenueWalletCopyKey, body: VenueWalletCopyKey): Refusal => ({
    variant: 'refused',
    title: t(title as 'sanctionedTitle'),
    body: t(body as 'sanctionedBody'),
    reference,
  });
  switch (code) {
    case 'protocol.wallet_sanctioned':
      return said('sanctionedTitle', 'sanctionedBody');
    case 'protocol.wallet_sanctions_unset':
      return said('sanctionsUnsetTitle', 'sanctionsUnsetBody');
    case 'denied.region_blocked':
      return { variant: 'refused', title: t('regionTitle'), body: t('regionBody', { reason: failure.message ?? code }), reference };
    case 'protocol.wallet_session_unset':
    case 'protocol.wallet_session_origin_unlisted':
    case 'protocol.venue_connection_ttl_unset':
      return said('unsetTitle', 'unsetBody');
    case 'protocol.wallet_signature_not_owner':
      return said('signatureTitle', 'signatureBody');
    case 'protocol.wallet_challenge_invalid':
    case 'protocol.venue_challenge_used':
      return said('staleTitle', 'staleBody');
    case 'protocol.venue_connection_expired':
      return said('expiredRefusedTitle', 'expiredRefusedBody');
    case 'protocol.venue_connection_none':
      return said('noneTitle', 'noneBody');
    case 'protocol.venue_unwired':
      return said('venueTitle', 'venueBody');
    default:
      return {
        variant: failure.reason === 'unreachable' || failure.reason === 'uncertain' ? 'unreachable' : 'refused',
        title: t('otherTitle'),
        body: t('otherBody'),
        reference,
      };
  }
}

/**
 * The room when the person's connections could not be read. A visitor from a blocked region is refused that read by the
 * same jurisdiction guard as Connect, so the room says the region refusal in words, with its reason, and keeps Connect
 * (which the service refuses the same way); any other failure is a read that failed.
 */
export function readFailedState(failure: Failed, refusal: Refusal | null, t: T): RoomState {
  if (codeOf(failure) === 'denied.region_blocked') return { kind: 'ready', partial: { missing: refusal ?? venueRefusal(failure, t) } };
  return {
    kind: 'refused',
    refusal: {
      variant: 'unreachable',
      title: t('readFailedTitle'),
      body: t('readFailedBody'),
      reference: codeOf(failure) ?? failure.reason,
      action: { label: t('tryAgain'), href: '/wallet/venue' },
    },
  };
}

export function VenueWalletRoom() {
  const { t } = venueWalletCopy.useCopy();
  const { api, userId } = useSession();
  const venue = useMemo(() => createVenueWalletApi(api), [api]);
  const wallet = useWallet();
  const status = useResource(
    (signal) => (userId ? venue.status(signal) : Promise.resolve({ ok: true as const, data: { connections: [] } })),
    `venue-wallet:${userId ?? 'out'}`,
  );
  const [opened, setOpened] = useState<VenueConnection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const address = wallet.status === 'connected' ? wallet.address : null;
  const listed = status.resource.status === 'ready' ? status.resource.data.connections : [];
  const fromServer = address ? listed.find((c) => c.address.toLowerCase() === address.toLowerCase()) : undefined;
  const connection = opened && address && opened.address.toLowerCase() === address.toLowerCase() ? opened : (fromServer ?? null);

  // The page's clock moves on when the expiry passes, so the room shows it expired; the service still refuses on its own.
  const [clock, setClock] = useState(() => Date.now());
  const expiresAt = connection ? Date.parse(connection.expiresAt) : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const left = expiresAt - clock;
    if (left <= 0) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(left + 250, 2_000_000_000));
    return () => clearTimeout(timer);
  }, [expiresAt, clock]);
  const expired = connection !== null && (connection.status === 'expired' || (expiresAt !== null && expiresAt <= clock));
  // Listed since it connected: the service refuses every action on it, and the room says why.
  const blocked = connection?.status === 'blocked';

  /** One flight at a time: a second press while the first has no answer does nothing. */
  async function once(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      await work();
    } catch {
      // A wallet or network failure that came back as an error rather than an answer: say nothing went through.
      setMessage(null);
      setRefusal({ variant: 'unreachable', title: t('otherTitle'), body: t('otherBody') });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const connect = () =>
    once(async () => {
      if (!address) return;
      const challenge = await venue.challenge({ address, origin: window.location.origin });
      if (!challenge.ok) {
        setRefusal(venueRefusal(challenge, t));
        return;
      }
      setMessage(challenge.data.message);
      const signed = await wallet.sign({ kind: 'message', message: challenge.data.message });
      if (signed.status !== 'signed') {
        setMessage(null);
        setRefusal({
          variant: 'refused',
          title: t(signed.status === 'rejected' ? 'rejectedTitle' : 'walletFailedTitle'),
          body: t(signed.status === 'rejected' ? 'rejectedBody' : 'walletFailedBody'),
          reference: signed.status === 'failed' ? signed.reason : 'rejected',
        });
        return;
      }
      const result = await venue.open({ challenge: challenge.data.challenge, signature: signed.signature });
      if (!result.ok) {
        setMessage(null);
        setRefusal(venueRefusal(result, t));
        return;
      }
      setOpened(result.data);
      setMessage(null);
      setClock(Date.now());
    });

  const act = (action: VenueWalletAction) =>
    once(async () => {
      if (!address) return;
      const result = await venue.authorize(address, action);
      // Never ok until a venue is wired: the answer is the refusal that names why nothing was asked of the wallet.
      if (!result.ok) setRefusal(venueRefusal(result, t));
    });

  const disconnect = () =>
    once(async () => {
      if (!address) return;
      const result = await venue.disconnect(address);
      if (!result.ok) {
        setRefusal(venueRefusal(result, t));
        return;
      }
      setOpened(null);
      status.reload();
    });

  const state: RoomState = useMemo(() => {
    if (!userId)
      return {
        kind: 'refused',
        refusal: {
          variant: 'refused',
          title: t('signedOutTitle'),
          body: t('signedOutBody'),
          action: { label: t('signIn'), href: '/login?redirect=%2Fwallet%2Fvenue' },
        },
      };
    if (status.resource.status === 'loading') return { kind: 'loading' };
    if (status.resource.status === 'failed') return readFailedState(status.resource.failure, refusal, t);
    if (refusal) return { kind: 'ready', partial: { missing: refusal } };
    return { kind: 'ready' };
  }, [userId, status.resource, refusal, t]);

  const current = connection && !expired && !blocked ? 2 : message ? 1 : 0;
  const time = (iso: string) => new Date(iso).toLocaleString();

  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      roomAction={<a href="/wallet">{t('backToWallet')}</a>}
      state={state}
      steps={{ labels: [t('stepConnect'), t('stepSign'), t('stepConnected')], current }}
      step={
        <section data-panel="venue-connection">
          {!address ? (
            <>
              <p>{t('pickWallet')}</p>
              {wallet.wallets.length === 0 ? <p>{t('noWallet')}</p> : null}
              {wallet.wallets.map((entry) => (
                <Button key={entry.info.uuid} disabled={wallet.status === 'connecting'} onClick={() => void wallet.connect(entry)}>
                  {t('connectWallet', { name: entry.info.name })}
                </Button>
              ))}
            </>
          ) : connection ? (
            <>
              <h2>{blocked ? t('sanctionedTitle') : expired ? t('expiredTitle') : t('connectedTitle')}</h2>
              <dl>
                <div>
                  <dt>{t('connectedAs')}</dt>
                  <dd data-venue-address>{connection.address}</dd>
                </div>
                <div>
                  <dt>{t('connectedUntil')}</dt>
                  <dd>
                    <time dateTime={connection.expiresAt} data-testid="venue-connection-expires">
                      {time(connection.expiresAt)}
                    </time>
                  </dd>
                </div>
              </dl>
              {blocked ? <p role="status">{t('sanctionedBody')}</p> : null}
              {expired && !blocked ? <p role="status">{t('expiredBody', { time: time(connection.expiresAt) })}</p> : null}
              <p data-venue-no-key>{t('noKey')}</p>
            </>
          ) : (
            <p>{t('noKey')}</p>
          )}
          {message ? (
            <details open>
              <summary>{t('messageTitle')}</summary>
              <pre data-venue-message>{message}</pre>
              <p>{t('messageNote')}</p>
            </details>
          ) : null}
        </section>
      }
      actions={
        address ? (
          <div>
            {!blocked && (!connection || expired) ? (
              <Button variant="primary" loading={busy} disabled={busy} onClick={() => void connect()}>
                {connection ? t('signAgain') : t('connect')}
              </Button>
            ) : null}{' '}
            {connection ? (
              <Button variant="secondary" disabled={busy} onClick={() => void disconnect()}>
                {t('disconnect')}
              </Button>
            ) : null}
            {connection ? (
              <section aria-label={t('actionsTitle')}>
                <h2>{t('actionsTitle')}</h2>
                <p>{t('actionsNote')}</p>
                <Button disabled={busy} onClick={() => void act('deposit')}>
                  {t('deposit')}
                </Button>{' '}
                <Button disabled={busy} onClick={() => void act('withdraw')}>
                  {t('withdraw')}
                </Button>
              </section>
            ) : null}
          </div>
        ) : null
      }
      summary={
        <div>
          <h2>{t('summaryTitle')}</h2>
          <p>{t('summaryAddress')}</p>
          <p>{t('summarySign')}</p>
        </div>
      }
    />
  );
}
