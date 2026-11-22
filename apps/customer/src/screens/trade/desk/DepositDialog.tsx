/**
 * The venue deposit sheet and the supported-asset check Deposit and Withdraw share, drawn only from the kit. The spot desk
 * and Convert in venue mode both open it; VenueAccountPanel.tsx re-exports it.
 */
import { useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { useWallet } from '../../../features/protocol/wallet/WalletProvider';
import { canonicalDecimal } from '../../../features/trade/venue-api';
import { TestMark } from '../../../features/trade/venue/VenueParts';
import { useSupportedAssets } from '../../../features/money';
import { spotVenueCopy } from './venue-copy';
import { depositPlaces, depositTransfer, listedPlaces, type DepositRoute, type ListedPlaces } from './venue-desk';

/**
 * The supported asset list's row for `asset` and `action` (J-wallet-01 #5): the venue desk's Deposit and Withdraw use the
 * same rows and precision Assets lists, read from svc-bank `assets.list`.
 */
export function useListed(asset: string, action: 'deposit' | 'withdraw', unlisted: number): ListedPlaces | 'loading' {
  const { resource } = useSupportedAssets();
  if (resource.status === 'loading') return 'loading';
  // Refused as this person's (a bank read a person cleared for trading alone may not make): not a list that is down.
  const rows = resource.status === 'ready' ? resource.data.assets : resource.failure.reason === 'forbidden' ? 'gated' : null;
  return listedPlaces(rows, asset, action, unlisted);
}

/** Why the list keeps `asset` from `action`, in plain words, or null when it allows it. */
export function ListedRefusal({
  listed,
  asset,
  action,
}: {
  listed: ListedPlaces | 'loading';
  asset: string;
  action: 'deposit' | 'withdraw';
}) {
  const { t } = spotVenueCopy.useCopy();
  if (listed === 'loading') return <p className="lt-hint">{t('Listed loading')}</p>;
  if (listed.ok) return null;
  const text =
    listed.why === 'unread'
      ? t('Listed unread')
      : listed.why === 'unlisted'
        ? t('Listed unlisted', { asset })
        : t(action === 'deposit' ? 'Listed closed deposit' : 'Listed closed withdraw', { asset });
  return (
    <p role="alert" data-testid="venue-listed-refusal">
      {text}
    </p>
  );
}

/** Deposit: the person's own wallet transfer to the venue's deposit address; the ledger posts nothing. */
export function DepositDialog({ route, test, onClose }: { route: DepositRoute | null; test: boolean; onClose: () => void }) {
  const { t } = spotVenueCopy.useCopy();
  const wallet = useWallet();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState<{ good: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const asset = route?.asset ?? '';
  const listed = useListed(asset, 'deposit', route?.tokenDecimals ?? 0);
  const places = route && listed !== 'loading' && listed.ok ? depositPlaces(route, listed.places) : null;
  const fromList = listed !== 'loading' && listed.ok && listed.from === 'list';

  async function send() {
    if (busy) return;
    setNote(null);
    if (!route) return setNote({ good: false, text: t('Deposit no route') });
    if (places === null) return;
    if (wallet.chainId !== null && wallet.chainId !== route.chainId)
      return setNote({ good: false, text: t('Deposit wrong network', { chainId: String(route.chainId) }) });
    const transfer = depositTransfer(route, amount, places);
    if (!transfer) return setNote({ good: false, text: t('Deposit amount bad', { asset, places: String(places) }) });
    setBusy(true);
    const sent = await wallet.sign({ kind: 'transaction', to: transfer.to, data: transfer.data });
    setBusy(false);
    if (sent.status === 'sent') setNote({ good: true, text: t('Deposit sent', { amount: canonicalDecimal(amount), asset }) });
    else if (sent.status === 'rejected') setNote({ good: false, text: t('Deposit rejected') });
    else setNote({ good: false, text: t('Deposit failed', { detail: sent.status === 'failed' ? sent.message : '' }) });
  }

  return (
    <Sheet open title={t('Deposit title')} onClose={onClose}>
      <div data-testid="venue-deposit">
        <TestMark test={test} />
        {route ? (
          <>
            <p className="lt-hint">{t('Deposit why', { asset })}</p>
            <Field
              label={t('Deposit amount', { asset })}
              name="venue-deposit-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <dl>
              <div>
                <dt>{t('Deposit to')}</dt>
                <dd className="lt-mono">{route.address}</dd>
              </div>
              <div>
                <dt>{t('Deposit token')}</dt>
                <dd className="lt-mono">
                  {asset} · {route.token}
                </dd>
              </div>
              <div>
                <dt>{t('Deposit network')}</dt>
                <dd className="lt-mono">{route.chainId}</dd>
              </div>
              {places !== null && fromList ? (
                <div>
                  <dt>{t('Decimal places')}</dt>
                  <dd className="lt-mono">{places}</dd>
                </div>
              ) : null}
            </dl>
            <ListedRefusal listed={listed} asset={asset} action="deposit" />
            <Button tone="primary" disabled={busy || amount.trim() === '' || places === null} onClick={() => void send()}>
              {t('Deposit send')}
            </Button>
          </>
        ) : (
          <p role="alert">{t('Deposit no route')}</p>
        )}
        {busy ? <p className="lt-hint">{t('Waiting wallet')}</p> : null}
        {note ? <p role={note.good ? 'status' : 'alert'}>{note.text}</p> : null}
      </div>
    </Sheet>
  );
}
