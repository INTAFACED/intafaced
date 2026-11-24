/**
 * The venue parts the trade rooms on the kit share (intafaced issue 9564): the TEST label, a figure the venue may not
 * publish, the "as of" line, the wallet bar, and an action's outcome with its read-back. The same words and test ids as
 * `../VenueKit.tsx`, drawn only from the kit; the words and the logic are VenueKit's own, imported from it.
 */
import { useEffect, type ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { displayAmount } from '../../../../shared/money';
import { WalletProvider, usePolled, useWallet } from '../../../protocol';
import type { MaybeKnown, VenueOrder } from '../../venue-api';
import type { VenueMode } from '../../use-venue-mode';
import { venueCopy } from '../venue-copy';
import { VENUE_POLL_MS } from '../poll';
import { SETTLED_STATUSES, outcomeText, useAsOfText, useVenueApi, word } from '../venue-words';
import type { ActionResult } from '../VenueKit';

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

/** A figure the venue may not publish: its value, or "not known", never 0. */
export function Known({ value, render = (v) => displayAmount(v) }: { value: MaybeKnown<string>; render?: (v: string) => ReactNode }) {
  const { t } = venueCopy.useCopy();
  return <>{value.known ? render(value.value) : t('Not known')}</>;
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

/** The wallet on the network the venue signs on (its status names it; the app's own chain otherwise). */
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
    <section className="lt-stack" aria-label={t('Your wallet')} data-testid="venue-wallet">
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
            <p role="alert">
              {t('Wrong network', { observed: String(wallet.guard.observed ?? ''), configured: String(wallet.guard.configured) })}{' '}
              <Button onClick={() => void wallet.switchNetwork()}>{t('Switch network')}</Button>
            </p>
          ) : null}
          <div className="lt-actions">
            <Button tone="secondary" onClick={wallet.disconnect}>
              {t('Disconnect')}
            </Button>
          </div>
        </>
      ) : wallet.wallets.length === 0 ? (
        <p className="lt-hint">{t('No wallet')}</p>
      ) : (
        <div className="lt-actions">
          {wallet.wallets.map((entry) => (
            <Button key={entry.info.uuid} disabled={wallet.status === 'connecting'} onClick={() => void wallet.connect(entry)}>
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

/**
 * Reads an order back by its client id until the venue names it, for an answer that was not definite. An order not found
 * yet is only that: it keeps being read, and nothing is sent again. `onSettled` hears the venue's own settled record.
 */
export function ReadBack({
  owner,
  clientOrderId,
  onSettled,
  venueId,
}: {
  owner: string;
  clientOrderId: string;
  onSettled?: (order: VenueOrder) => void;
  /** The venue the order was sent to (J-derivatives-28 routing); none is the primary venue. */
  venueId?: string;
}) {
  const { t } = venueCopy.useCopy();
  const venue = useVenueApi();
  const read = usePolled(
    (signal) =>
      venueId ? venue.ordersByClientIdOn(venueId, owner, clientOrderId, signal) : venue.orderByClientId(owner, clientOrderId, signal),
    `rb:${venueId ?? ''}:${owner}:${clientOrderId}`,
    VENUE_POLL_MS,
  );
  const order = read.data?.value ?? null;
  const settled = order && SETTLED_STATUSES.includes(order.status) ? order : null;
  useEffect(() => {
    if (settled) onSettled?.(settled);
  }, [settled, onSettled]);
  if (!read.data) return <p className="lt-hint">{t('Checking venue')}</p>;
  return (
    <p data-testid="venue-read-back">{order ? t('Read back', { status: word(t, 'status', order.status) }) : t('Read back missing')}</p>
  );
}

export function OutcomeLine({ result, owner, venueId }: { result: ActionResult | null; owner: string | null; venueId?: string }) {
  const { t } = venueCopy.useCopy();
  if (!result) return null;
  return (
    <div role="status" data-testid="venue-outcome">
      <p>{outcomeText(t, result)}</p>
      {result.kind === 'unknown' && result.clientOrderId && owner ? (
        <ReadBack owner={owner} clientOrderId={result.clientOrderId} {...(venueId ? { venueId } : {})} />
      ) : null}
    </div>
  );
}
