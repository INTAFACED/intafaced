import { useState } from 'react';
import type { ReceivingWallet as Wallet } from '@intafaced/contracts/merchant-receiving-wallet';
import { Button } from '@intafaced/ui';
import { useResource } from '../../../../shared/resource';
import { Field } from '../../ui-kit';
import { PaySection } from '../../components';
import type { PortalApi } from '../api';
import { imageRequestId } from '../catalog/model';
import { Gate } from '../components';
import { DateTime } from '../ui/DateTime';
import { useMayChangeLook } from './CheckoutLook';
import { walletCopy as c } from './wallet-copy';

/**
 * `/pay/checkout`: where the crypto customers pay at checkout goes (J-merchant-04, launch money model). The business gives
 * its own wallet's public key; svc-pay derives a fresh address of that wallet for each payment, so the money never passes
 * through INTAFACED. The first address is shown so the owner can check it against their wallet. A private key is refused
 * by the service before anything is stored.
 */
export function ReceivingWallet({ portal }: { portal: PortalApi }) {
  const { resource, reload } = useResource((s) => portal.receivingWallet(s), 'portal:receiving-wallet');
  // Kept here, not in the form: a save reloads the wallet and draws a fresh form, and its answer must stay on screen.
  const [note, setNote] = useState<Note | null>(null);
  return (
    <PaySection title={c.t('title')} description={c.t('purpose')}>
      <Gate resource={resource} retry={reload} rows={3}>
        {(wallet) => <WalletForm key={wallet.version} wallet={wallet} portal={portal} onSaved={reload} note={note} setNote={setNote} />}
      </Gate>
    </PaySection>
  );
}

type Note = { ok: boolean; text: string };

function WalletForm({
  wallet,
  portal,
  onSaved,
  note,
  setNote,
}: {
  wallet: Wallet;
  portal: PortalApi;
  onSaved: () => void;
  note: Note | null;
  setNote: (note: Note | null) => void;
}) {
  const may = useMayChangeLook();
  const [key, setKey] = useState(wallet.extendedPublicKey ?? '');
  const [busy, setBusy] = useState(false);
  const typed = key.trim();
  const changed = typed !== '' && typed !== (wallet.extendedPublicKey ?? '');

  async function save() {
    if (!changed) return;
    setBusy(true);
    setNote(null);
    try {
      // The request id comes from what is saved and the version it is saved over: sending the same save again after a
      // lost answer is the same request, and the service answers with the wallet it already saved.
      const requestId = await imageRequestId(new Blob([JSON.stringify({ expectedVersion: wallet.version, key: typed })]));
      const result = await portal.saveReceivingWallet({
        requestId,
        expectedVersion: wallet.version,
        family: 'evm',
        extendedPublicKey: typed,
      });
      if (result.ok) {
        setNote({ ok: true, text: c.t('saved') });
        onSaved();
      } else {
        setNote({ ok: false, text: result.message });
        if (result.code === 'pay.receiving_wallet_stale') onSaved();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="form-stack" className="form-stack pp-form">
      <p className="muted" role="status" data-testid="receiving-wallet-state">
        {wallet.set && wallet.savedAt ? (
          <>
            {c.t('savedOn')} <DateTime value={wallet.savedAt} />
          </>
        ) : (
          c.t('unset')
        )}
      </p>
      {!may.allowed && (
        <p className="muted pp-note" role="note">
          {c.t(may.unverified ? 'unverified' : 'noWrite')}
        </p>
      )}
      <Field
        label={c.t('key')}
        hint={c.t('keyHint')}
        required
        value={key}
        autoComplete="off"
        spellCheck={false}
        disabled={!may.allowed || busy}
        onChange={(e) => setKey(e.target.value)}
      />
      {wallet.firstAddress && (
        <div className="field">
          <span>{c.t('firstAddress')}</span>
          <code data-testid="receiving-wallet-first-address">{wallet.firstAddress}</code>
          <small className="muted">{c.t('firstAddressHint')}</small>
        </div>
      )}
      {note && (
        <p className={note.ok ? 'pp-confirmed' : 'pp-callout'} role={note.ok ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
      <div className="pp-actions">
        <Button disabled={!may.allowed || !changed || busy} onClick={() => void save()}>
          {busy ? c.t('saving') : c.t('save')}
        </Button>
      </div>
    </div>
  );
}
