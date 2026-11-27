import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { WalletProvider, usePolled, useWallet } from '../../protocol';
import type { VenueMode } from '../use-venue-mode';
import { outcomeText, useAsOfText, useVenueApi, word, type ActionResult } from '../venue/VenueKit';
import { VENUE_POLL_MS } from '../venue/poll';
import { venueCopy } from '../venue/venue-copy';

/**
 * The venue parts Trading permissions shows, drawn from the kit: the same words, test ids and roles as their
 * VenueKit namesakes, which the venue desks still use until they move onto the kit.
 */

/** The TEST label every venue figure carries while the venue is a TEST one. */
export function TestMark({ test }: { test: boolean }) {
  const { t } = venueCopy.useCopy();
  if (!test) return null;
  return (
    <span className="lt-test" data-testid="venue-test" title={t('Venue TEST note')}>
      {t('TEST')}
    </span>
  );
}

export function AsOfLine({ asOf }: { asOf: string | null }) {
  const text = useAsOfText();
  if (!asOf) return null;
  return (
    <p className="lt-hint" data-testid="venue-as-of">
      {text(asOf)}
    </p>
  );
}

/** The person's wallet on the network the venue signs on (its status names it; the app's own chain otherwise). */
export function VenueFrame({ mode, children }: { mode: Extract<VenueMode, { mode: 'on' }>; children: ReactNode }) {
  const status = mode.status;
  const chainId = status.available && status.chainId ? status.chainId : undefined;
  return (
    <WalletProvider chainId={chainId} scope="venue-desk">
      {children}
    </WalletProvider>
  );
}

/** Connect, the connected address and network, and the switch when the wallet is on another network. */
export function WalletBar() {
  const { t } = venueCopy.useCopy();
  const wallet = useWallet();
  return (
    <section aria-label={t('Your wallet')} data-testid="venue-wallet">
      <h2>{t('Your wallet')}</h2>
      {wallet.status === 'connected' && wallet.address ? (
        <>
          <dl className="lt-kv">
            <div>
              <dt>{t('Connected address')}</dt>
              <dd className="lt-mono" data-testid="venue-wallet-address">
                {wallet.address.toLowerCase()}
              </dd>
            </div>
            <div>
              <dt>{t('Network')}</dt>
              <dd className="lt-mono">{wallet.chainId ?? ''}</dd>
            </div>
          </dl>
          {wallet.guard && !wallet.guard.ok ? (
            <div role="alert">
              <p>{t('Wrong network', { observed: String(wallet.guard.observed ?? ''), configured: String(wallet.guard.configured) })}</p>
              <div className="lt-actions">
                <Button tone="primary" onClick={() => void wallet.switchNetwork()}>
                  {t('Switch network')}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="lt-actions">
            <Button tone="secondary" onClick={wallet.disconnect}>
              {t('Disconnect')}
            </Button>
          </div>
        </>
      ) : wallet.wallets.length === 0 ? (
        <>
          <p className="lt-hint">{t('No wallet')}</p>
          {/* With no browser wallet, the person makes the app's own here; it then shows above as a wallet to connect. */}
          <a className="lt-link" href="/wallet/embedded" data-testid="venue-wallet-make">
            {t('Make wallet')}
          </a>
        </>
      ) : (
        <div className="lt-actions">
          {wallet.wallets.map((entry) => (
            <Button
              key={entry.info.uuid}
              tone="primary"
              disabled={wallet.status === 'connecting'}
              onClick={() => void wallet.connect(entry)}
            >
              {t('Connect wallet', { name: entry.info.name })}
            </Button>
          ))}
        </div>
      )}
      {wallet.problem ? (
        <p className="lt-refusal" role="alert">
          {wallet.problem}
        </p>
      ) : null}
    </section>
  );
}

/** An order the venue has not answered for yet, read back from the venue by its client order id. */
function ReadBack({ owner, clientOrderId, venueId }: { owner: string; clientOrderId: string; venueId?: string }) {
  const { t } = venueCopy.useCopy();
  const venue = useVenueApi();
  const read = usePolled(
    (signal) =>
      venueId ? venue.ordersByClientIdOn(venueId, owner, clientOrderId, signal) : venue.orderByClientId(owner, clientOrderId, signal),
    `rb:${venueId ?? ''}:${owner}:${clientOrderId}`,
    VENUE_POLL_MS,
  );
  const order = read.data?.value ?? null;
  if (!read.data) return <p className="lt-hint">{t('Checking venue')}</p>;
  return (
    <p data-testid="venue-read-back">{order ? t('Read back', { status: word(t, 'status', order.status) }) : t('Read back missing')}</p>
  );
}

export function OutcomeLine({ result, owner, venueId }: { result: ActionResult | null; owner: string | null; venueId?: string }) {
  const { t } = venueCopy.useCopy();
  if (!result) return null;
  return (
    <div role="status" data-testid="venue-outcome" data-code={result.kind === 'refused' ? (result.code ?? '') : undefined}>
      <p>{outcomeText(t, result)}</p>
      {result.kind === 'unknown' && result.clientOrderId && owner ? (
        <ReadBack owner={owner} clientOrderId={result.clientOrderId} {...(venueId ? { venueId } : {})} />
      ) : null}
    </div>
  );
}
