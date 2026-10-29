import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Field, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useApi } from '../../session/session';
import { createProtocolApi, type RepresentationStatus } from '../api';
import { networkLabel } from '../blockers';
import { REGION_BLOCKED_CODE, useRegionBlocked } from '../region';
import { walletCopy } from './copy';
import { APP_CHAIN_ID } from './eip1193';
import { RepresentationPanel } from './RepresentationPanel';
import { isContractCode, lastFour, nativeCurrency, readDestination, sameAddress, toBaseUnits, toHexValue } from './transfer';
import { useWallet } from './WalletProvider';

type Contract = 'checking' | 'contract' | 'wallet' | 'unknown';
type Outcome =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'representation'; address: string; status: RepresentationStatus }
  | { kind: 'sent'; hash: string }
  | { kind: 'refused'; message: string };

const NATIVE = 'native';

/**
 * Send: the network's own currency from the connected wallet to an address (D-portfolio-wallet-03, D-swap-12). The
 * wallet builds, signs and sends the transaction itself; nothing posts to the ledger. Review shows every line first, and
 * a new address needs its last four characters typed. A name is never guessed into an address: with no name service
 * connected it says so. `to` and `token` arrive pre-filled from a scanned code; nothing is chosen for the person.
 */
export function SendPanel({ to: prefilledTo = '', token: askedToken = '' }: { to?: string; token?: string }) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const regionBlocked = useRegionBlocked();
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const network = networkLabel(APP_CHAIN_ID).name;
  const native = nativeCurrency(APP_CHAIN_ID);
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState(prefilledTo);
  useEffect(() => setTo(prefilledTo), [prefilledTo]);
  const [problem, setProblem] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [typed, setTyped] = useState('');
  const [contract, setContract] = useState<Contract>('checking');
  const [ticked, setTicked] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const asked = useRef(0);

  const destination = readDestination(to);
  const units = native ? toBaseUnits(amount, native.decimals) : null;
  const ready = wallet.status === 'connected' && wallet.address !== null && wallet.guard?.ok === true;
  const canReview = ready && destination.kind === 'address';
  const edit = (set: (value: string) => void) => (event: { target: { value: string } }) => {
    set(event.target.value);
    setProblem(null);
    setOutcome({ kind: 'idle' });
  };

  const review = async () => {
    if (destination.kind !== 'address' || !wallet.address) return;
    if (sameAddress(destination.address, wallet.address)) return setProblem(t('sendSelf'));
    if (token !== NATIVE || !native) return setProblem(t('sendChooseToken'));
    if (units === null) return setProblem(t('sendAmountInvalid', { decimals: String(native.decimals) }));
    setProblem(null);
    setTyped('');
    setTicked(false);
    setContract('checking');
    setReviewing(true);
    const turn = ++asked.current;
    const code = await wallet.code(destination.address);
    if (turn !== asked.current) return;
    setContract(code === null ? 'unknown' : isContractCode(code) ? 'contract' : 'wallet');
  };

  const send = async () => {
    if (destination.kind !== 'address' || !wallet.address || units === null) return;
    setOutcome({ kind: 'busy' });
    // A send is a signing action: the representation gate runs first and never fails open.
    const representation = await api.representationStatus(wallet.address);
    if (!representation.ok) {
      const key =
        representation.code === REGION_BLOCKED_CODE
          ? 'permitRefused_region'
          : representation.code === 'compliance.representation_unset'
            ? 'permitRefused_representation_unset'
            : 'permitRefused_representation_unavailable';
      setReviewing(false);
      return setOutcome({ kind: 'refused', message: t(key) });
    }
    if (!representation.data.accepted) {
      setReviewing(false);
      return setOutcome({ kind: 'representation', address: wallet.address, status: representation.data });
    }
    setReviewing(false);
    const result = await wallet.sign({ kind: 'transaction', to: destination.address, value: toHexValue(units) });
    if (result.status === 'sent') setOutcome({ kind: 'sent', hash: result.hash });
    else if (result.status === 'rejected') setOutcome({ kind: 'refused', message: t('sendRejected') });
    else if (result.status === 'failed') setOutcome({ kind: 'refused', message: result.message });
    else setOutcome({ kind: 'idle' });
  };

  if (regionBlocked)
    return (
      <Panel title={t('sendTitle')}>
        <p className="muted" data-permit-refused="region">
          {t('permitRefused_region')}
        </p>
      </Panel>
    );

  const confirmed =
    destination.kind === 'address' &&
    typed.trim().toLowerCase() === lastFour(destination.address) &&
    contract !== 'checking' &&
    (contract !== 'contract' || ticked);

  return (
    <>
      {outcome.kind === 'representation' && (
        <RepresentationPanel
          address={outcome.address}
          status={outcome.status}
          api={api}
          onEnd={(end) => {
            if (end.kind === 'accepted') void send();
            else if (end.kind === 'rejected') setOutcome({ kind: 'refused', message: t('sendRejected') });
            else if (end.kind === 'region') setOutcome({ kind: 'refused', message: t('permitRefused_region') });
            else setOutcome({ kind: 'refused', message: end.message });
          }}
        />
      )}
      <Panel title={t('sendTitle')}>
        <p className="muted">{t('sendNote', { network })}</p>
        {!ready && <p className="muted">{t('needsWallet')}</p>}
        <form
          aria-label={t('sendTitle')}
          onSubmit={(event) => {
            event.preventDefault();
            void review();
          }}
        >
          <label className="field">
            <span id="wallet-send-token-label">{t('sendToken')}</span>
            <select
              value={token}
              onChange={edit(setToken)}
              aria-labelledby="wallet-send-token-label"
              aria-describedby="wallet-send-token-note"
            >
              <option value="">{t('sendTokenChoose')}</option>
              {native && <option value={NATIVE}>{t('sendNative', { symbol: native.symbol })}</option>}
            </select>
            <small id="wallet-send-token-note">{askedToken ? t('sendTokenAsked', { token: askedToken }) : t('sendTokenListNote')}</small>
          </label>
          <Field label={t('sendAmount')} hint={t('sendAmountHint')} inputMode="decimal" value={amount} onChange={edit(setAmount)} />
          <Field label={t('sendTo')} hint={t('sendToHint')} value={to} onChange={edit(setTo)} autoComplete="off" spellCheck={false} />
          {destination.kind === 'name' && (
            <>
              <p role="alert">{t('sendNameUnresolved')}</p>
              <p className="muted">{t('sendNameWhy')}</p>
            </>
          )}
          {destination.kind === 'invalid' && <p role="alert">{t('sendInvalidTo')}</p>}
          {problem && <p role="alert">{problem}</p>}
          <Button type="submit" disabled={!canReview || outcome.kind === 'busy'}>
            {t('sendReview')}
          </Button>
        </form>
        {outcome.kind === 'sent' && <p role="status">{t('sendSent', { hash: outcome.hash })}</p>}
        {outcome.kind === 'refused' && <p role="alert">{outcome.message}</p>}
      </Panel>
      {reviewing && destination.kind === 'address' && native && (
        <Dialog title={t('reviewTitle')} onClose={() => setReviewing(false)}>
          <dl className="protocol-facts">
            <div>
              <dt>{t('reviewFrom')}</dt>
              <dd className="numeric">{wallet.address}</dd>
            </div>
            <div>
              <dt>{t('reviewTo')}</dt>
              <dd className="numeric">{destination.address}</dd>
            </div>
            <div>
              <dt>{t('reviewAmount')}</dt>
              <dd className="numeric">
                {amount.trim()} {native.symbol}
              </dd>
            </div>
            <div>
              <dt>{t('reviewNetwork')}</dt>
              <dd>{network}</dd>
            </div>
          </dl>
          {contract === 'checking' && <p role="status">{t('reviewChecking')}</p>}
          {contract === 'contract' && (
            <>
              <p role="note">{t('reviewContract')}</p>
              <label className="field field--check">
                <input type="checkbox" checked={ticked} onChange={(event) => setTicked(event.target.checked)} />
                <span>{t('reviewContractTick')}</span>
              </label>
            </>
          )}
          {contract === 'unknown' && <p role="note">{t('reviewContractUnknown')}</p>}
          <Field
            label={t('reviewLastFour')}
            hint={t('reviewLastFourHint')}
            value={typed}
            maxLength={4}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
          />
          <div className="protocol-actions">
            <Button variant="secondary" onClick={() => setReviewing(false)}>
              {t('reviewBack')}
            </Button>
            <Button disabled={!confirmed || outcome.kind === 'busy'} onClick={() => void send()}>
              {t('reviewSend')}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
