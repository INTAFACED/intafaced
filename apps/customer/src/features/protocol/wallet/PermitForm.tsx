import { useState } from 'react';
import { Button, Field, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { walletCopy } from './copy';
import { APP_CHAIN_ID, type TypedDataDocument } from './eip1193';
import {
  PermitRefused,
  SELECTOR,
  buildPermit,
  checkPermitInput,
  decodeDecimals,
  decodeDomain,
  decodeNonce,
  noncesCall,
  type PermitRefusal,
} from './permit';
import { useWallet } from './WalletProvider';

type Outcome =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'refused'; code: PermitRefusal | 'read_failed' }
  | { kind: 'signed'; signature: string; signed: TypedDataDocument }
  | { kind: 'rejected' }
  | { kind: 'failed'; message: string };

/**
 * "Sign a token allowance": an EIP-2612 permit built from the token's own published domain, shown on the plain-words
 * sheet before the wallet asks. The signature stays on this page: nothing is sent to the platform or to the spender.
 * A rejection keeps every field as it was.
 */
export function PermitForm() {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const [token, setToken] = useState('');
  const [spender, setSpender] = useState('');
  const [amount, setAmount] = useState('');
  const [minutes, setMinutes] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  // A signature belongs to the exact fields it was made from: editing any field clears the result.
  const edit = (set: (value: string) => void) => (event: { target: { value: string } }) => {
    set(event.target.value);
    setOutcome({ kind: 'idle' });
  };
  const ready = wallet.status === 'connected' && wallet.address !== null && wallet.guard?.ok === true;

  const submit = async () => {
    if (!wallet.address) return;
    const input = { owner: wallet.address, token, spender, amount, expiresInMinutes: minutes };
    const invalid = checkPermitInput(input);
    if (invalid) return setOutcome({ kind: 'refused', code: invalid });
    setOutcome({ kind: 'reading' });
    const target = token.trim();
    const [domainHex, decimalsHex, nonceHex] = await Promise.all([
      wallet.call(target, SELECTOR.eip712Domain),
      wallet.call(target, SELECTOR.decimals),
      wallet.call(target, noncesCall(wallet.address)),
    ]);
    if (domainHex === null || decimalsHex === null || nonceHex === null) return setOutcome({ kind: 'refused', code: 'read_failed' });
    let typedData;
    try {
      typedData = buildPermit(
        input,
        { domain: decodeDomain(domainHex), decimals: decodeDecimals(decimalsHex), nonce: decodeNonce(nonceHex) },
        APP_CHAIN_ID,
        new Date(),
      );
    } catch (err) {
      if (err instanceof PermitRefused) return setOutcome({ kind: 'refused', code: err.code });
      throw err;
    }
    const result = await wallet.sign({ kind: 'typedData', typedData });
    if (result.status === 'signed') setOutcome({ kind: 'signed', signature: result.signature, signed: typedData });
    else if (result.status === 'rejected') setOutcome({ kind: 'rejected' });
    else if (result.status === 'failed') setOutcome({ kind: 'failed', message: result.message });
  };

  return (
    <Panel title={t('permitTitle')}>
      <p className="muted">{t('permitNote')}</p>
      {!ready && <p className="muted">{t('needsWallet')}</p>}
      <form
        data-form="permit"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={t('permitToken')} hint={t('permitTokenHint')} value={token} onChange={edit(setToken)} />
        <Field label={t('permitSpender')} hint={t('permitSpenderHint')} value={spender} onChange={edit(setSpender)} />
        <Field label={t('permitAmount')} inputMode="decimal" value={amount} onChange={edit(setAmount)} />
        <Field label={t('permitMinutes')} inputMode="numeric" value={minutes} onChange={edit(setMinutes)} />
        <Button type="submit" disabled={!ready || outcome.kind === 'reading'}>
          {t('permitSubmit')}
        </Button>
      </form>
      {outcome.kind === 'reading' && <p role="status">{t('permitReading')}</p>}
      {outcome.kind === 'refused' && (
        <p role="alert" data-permit-refused={outcome.code}>
          {t(`permitRefused_${outcome.code}`)}
        </p>
      )}
      {outcome.kind === 'rejected' && (
        <p role="status" data-permit-result="rejected">
          {t('permitRejected')}
        </p>
      )}
      {outcome.kind === 'failed' && (
        <p role="alert" data-permit-result="failed">
          {outcome.message}
        </p>
      )}
      {outcome.kind === 'signed' && (
        <div role="status" data-permit-result="signed">
          <p>{t('permitSigned')}</p>
          <p className="muted">{t('permitSignedValues')}</p>
          <pre className="numeric" data-permit-signed>
            {JSON.stringify({ domain: outcome.signed.domain, message: outcome.signed.message }, null, 2)}
          </pre>
          <pre className="numeric" data-permit-signature>
            {outcome.signature}
          </pre>
        </div>
      )}
    </Panel>
  );
}
