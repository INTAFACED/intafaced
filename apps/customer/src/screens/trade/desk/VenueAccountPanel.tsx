import { useRef, useState, type ReactNode } from 'react';
import { Button as KitButton, Dialog, Field } from '../../../shared/ui';
import { displayAmount, formatAmount, parseAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { StepUpConfirm } from '../../../features/money/StepUpConfirm';
import { withdrawStepUpCopy } from '../../../features/money/withdraw-step-up-copy';
import { useWallet } from '../../../features/protocol/wallet/WalletProvider';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import {
  canonicalDecimal,
  draftId,
  keys,
  type AsOf,
  type VenueBalance,
  type VenueMarket,
  type VenueUp,
  type VenueWithdrawal,
} from '../../../features/trade/venue-api';
import {
  Known,
  OutcomeLine,
  TestMark,
  VENUE_POLL_MS,
  useOwner,
  useVenueActions,
  useVenueApi,
  word,
  type ActionResult,
} from '../../../features/trade/venue/VenueKit';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { zoneName } from './time';
import { spotVenueCopy } from './venue-copy';
import { depositTransfer, shortAddress, withdrawStep, type DepositRoute } from './venue-desk';

/** The venue's time, as the person's own clock shows it ("9 Nov 2026, 14:03:22"). */
export function useClock(): (iso: string) => string {
  const { timeZone } = usePreferences();
  return (iso: string) => {
    try {
      const text = new Intl.DateTimeFormat('en-GB', { timeZone: zoneName(timeZone), dateStyle: 'medium', timeStyle: 'medium' }).format(
        new Date(iso),
      );
      return timeZone === 'device' ? text : `${text} ${timeZone}`;
    } catch {
      return iso;
    }
  };
}

/** All of `free` on the venue's lot, or null when less than one lot is free: what Flatten sells. */
export function flattenable(free: string, lot: string): string | null {
  const f = parseAmount(free);
  const l = parseAmount(lot);
  if (l <= 0n || f < l) return null;
  return formatAmount((f / l) * l);
}

/** The person's venue account, the venue's figures only. */
export function VenueAccountPanel({
  status,
  market,
  balances,
  onDeposit,
  onWithdraw,
  onFlatten,
  withdrawal,
}: {
  status: VenueUp;
  market: VenueMarket;
  balances: AsOf<VenueBalance[]> | null;
  onDeposit: () => void;
  onWithdraw: () => void;
  /** Sell all of the free base asset in one reviewed market sell (J-cex-spot-05 #8), on the lot. */
  onFlatten: (amount: string) => void;
  withdrawal: ReactNode;
}) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const owner = useOwner();
  const clock = useClock();
  const rowOf = (asset: string) => balances?.value.find((b) => b.asset === asset) ?? null;
  return (
    <section className="dk-panel form-stack" aria-label={t('Venue account')} data-testid="venue-account">
      <h2 className="dk-tab-title">
        {t('Venue account')} <TestMark test={status.test} />
      </h2>
      <p className="muted">{t('Venue account note')}</p>
      <VenueWalletRow />
      {owner && balances
        ? [market.quoteAsset, market.baseAsset].map((asset) => {
            const row = rowOf(asset);
            return (
              <dl className="protocol-facts" key={asset} data-asset={asset}>
                <div>
                  <dt>{v('Asset')}</dt>
                  <dd>{asset}</dd>
                </div>
                <div>
                  <dt>{t('Free')}</dt>
                  <dd className="numeric" data-cell="free">
                    {displayAmount(row?.free ?? '0')} {asset}
                  </dd>
                </div>
                <div>
                  <dt>{t('Used')}</dt>
                  <dd className="numeric" data-cell="used">
                    {displayAmount(row?.locked ?? '0')} {asset}
                  </dd>
                </div>
                <div>
                  <dt>{t('As of')}</dt>
                  <dd className="numeric">{clock(balances.asOf)}</dd>
                </div>
                {asset === market.baseAsset && flattenable(row?.free ?? '0', market.lotSize) ? (
                  <div>
                    <dt className="muted">{t('Flatten note', { asset })}</dt>
                    <dd>
                      <KitButton variant="secondary" onClick={() => onFlatten(flattenable(row?.free ?? '0', market.lotSize)!)}>
                        {t('Flatten', { asset })}
                      </KitButton>
                    </dd>
                  </div>
                ) : null}
              </dl>
            );
          })
        : null}
      <p>
        <KitButton disabled={!owner} onClick={onDeposit}>
          {t('Deposit')}
        </KitButton>{' '}
        <KitButton variant="secondary" disabled={!owner} onClick={onWithdraw}>
          {t('Withdraw')}
        </KitButton>
      </p>
      {withdrawal}
    </section>
  );
}

/** The wallet that owns the venue account: Connect until connected, then its address, Disconnect and the network guard. */
export function VenueWalletRow() {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const wallet = useWallet();
  return (
    <>
      {wallet.status === 'connected' && wallet.address ? (
        <div>
          <p>
            {t('Connected')}:{' '}
            <span className="numeric" data-testid="venue-wallet-address">
              {wallet.address.toLowerCase()}
            </span>{' '}
            <KitButton variant="secondary" onClick={wallet.disconnect}>
              {v('Disconnect')}
            </KitButton>
          </p>
          {wallet.guard && !wallet.guard.ok ? (
            <p role="alert">
              {v('Wrong network', { observed: String(wallet.guard.observed ?? ''), configured: String(wallet.guard.configured) })}{' '}
              <KitButton onClick={() => void wallet.switchNetwork()}>{v('Switch network')}</KitButton>
            </p>
          ) : null}
        </div>
      ) : wallet.wallets.length === 0 ? (
        <p className="muted">{v('No wallet')}</p>
      ) : (
        <p>
          {wallet.wallets.map((entry) => (
            <KitButton key={entry.info.uuid} disabled={wallet.status === 'connecting'} onClick={() => void wallet.connect(entry)}>
              {v('Connect wallet', { name: entry.info.name })}
            </KitButton>
          ))}
        </p>
      )}
      {wallet.problem ? (
        <p className="failure" role="alert">
          {wallet.problem}
        </p>
      ) : null}
    </>
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

  async function send() {
    if (busy) return;
    setNote(null);
    if (!route) return setNote({ good: false, text: t('Deposit no route') });
    if (wallet.chainId !== null && wallet.chainId !== route.chainId)
      return setNote({ good: false, text: t('Deposit wrong network', { chainId: String(route.chainId) }) });
    const transfer = depositTransfer(route, amount);
    if (!transfer) return setNote({ good: false, text: t('Deposit amount bad', { asset, places: String(route.tokenDecimals) }) });
    setBusy(true);
    const sent = await wallet.sign({ kind: 'transaction', to: transfer.to, data: transfer.data });
    setBusy(false);
    if (sent.status === 'sent') setNote({ good: true, text: t('Deposit sent', { amount: canonicalDecimal(amount), asset }) });
    else if (sent.status === 'rejected') setNote({ good: false, text: t('Deposit rejected') });
    else setNote({ good: false, text: t('Deposit failed', { detail: sent.status === 'failed' ? sent.message : '' }) });
  }

  return (
    <Dialog title={t('Deposit title')} onClose={onClose}>
      <div className="form-stack" data-testid="venue-deposit">
        <TestMark test={test} />
        {route ? (
          <>
            <p className="muted">{t('Deposit why', { asset })}</p>
            <Field
              label={t('Deposit amount', { asset })}
              name="venue-deposit-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <dl className="protocol-facts">
              <div>
                <dt>{t('Deposit to')}</dt>
                <dd className="numeric">{route.address}</dd>
              </div>
              <div>
                <dt>{t('Deposit token')}</dt>
                <dd className="numeric">
                  {asset} · {route.token}
                </dd>
              </div>
              <div>
                <dt>{t('Deposit network')}</dt>
                <dd className="numeric">{route.chainId}</dd>
              </div>
            </dl>
            <KitButton disabled={busy || amount.trim() === ''} onClick={() => void send()}>
              {t('Deposit send')}
            </KitButton>
          </>
        ) : (
          <p role="alert">{t('Deposit no route')}</p>
        )}
        {busy ? <p className="muted">{t('Waiting wallet')}</p> : null}
        {note ? (
          <p role={note.good ? 'status' : 'alert'} className={note.good ? '' : 'failure'}>
            {note.text}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Withdraw to the connected wallet: the step-up first, then the wallet signs. */
export function WithdrawDialog({
  owner,
  asset,
  test,
  onClose,
  onSigned,
}: {
  owner: string;
  asset: string;
  test: boolean;
  onClose: () => void;
  onSigned: (nonce: string) => void;
}) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const s = withdrawStepUpCopy.useCopy().t;
  const { run } = useVenueActions(owner);
  const draft = useRef(draftId());
  const [amount, setAmount] = useState('');
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const withdrawalKey = keys.withdraw(owner, draft.current);
  let canonical: string | null = null;
  try {
    canonical = amount.trim() ? canonicalDecimal(amount) : null;
  } catch {
    canonical = null;
  }

  function press() {
    setProblem(null);
    const next = withdrawStep(amount, null);
    if (next.step === 'refuse' || !canonical) return setProblem(t('Withdraw amount bad'));
    setStepUp(true);
  }

  async function signed(stepUpApprovalId: string | null) {
    const next = withdrawStep(amount, { id: stepUpApprovalId });
    if (next.step !== 'sign' || !canonical) return;
    setStepUp(false);
    setBusy(true);
    const answer = await run(
      { kind: 'withdraw', asset, amount: canonical, destination: owner, withdrawalKey },
      { stepUpApprovalId: next.stepUpApprovalId },
    );
    setBusy(false);
    setResult(answer);
    const nonce = answer.kind === 'outcome' && answer.outcome.accepted ? answer.nonce : answer.kind === 'unknown' ? answer.nonce : null;
    if (nonce) {
      onSigned(nonce);
      onClose();
    }
  }

  return (
    <>
      <Dialog title={t('Withdraw title')} onClose={onClose}>
        <div className="form-stack" data-testid="venue-withdraw">
          <TestMark test={test} />
          <Field
            label={t('Withdraw amount', { asset })}
            name="venue-withdraw-amount"
            inputMode="decimal"
            value={amount}
            disabled={busy}
            onChange={(e) => {
              setAmount(e.target.value);
              setResult(null);
              // A changed amount is a new withdrawal: a new key, and a new confirmation.
              draft.current = draftId();
            }}
          />
          <p>
            {t('Withdraw to')}:{' '}
            <span className="numeric" title={owner}>
              {shortAddress(owner)}
            </span>
          </p>
          {problem ? (
            <p className="failure" role="alert">
              {problem}
            </p>
          ) : null}
          {busy ? <p className="muted">{v('Waiting wallet')}</p> : null}
          <OutcomeLine result={result} owner={owner} />
          <KitButton disabled={busy} onClick={press}>
            {t('Withdraw send')}
          </KitButton>
        </div>
      </Dialog>
      {stepUp && canonical ? (
        <Dialog title={s('title')} onClose={() => setStepUp(false)}>
          <StepUpConfirm
            request={() => ({
              scope: 'trade.step_up.venue.withdraw',
              purpose: 'venue.withdraw',
              target: withdrawalKey,
              amount: canonical!,
              fields: { withdrawalKey, owner, subAccount: '', asset, amount: canonical!, destination: owner },
            })}
            words={{
              why: v('Withdraw step up why'),
              code: s('code'),
              codeHint: v('Authenticator hint'),
              codeShort: v('Enter six'),
              noFactor: v('No factor'),
              sendWithout: v('Send without'),
            }}
            disabled={busy}
            onApproved={(id) => void signed(id)}
          />
        </Dialog>
      ) : null}
    </>
  );
}

/** The venue's withdrawal by its nonce: pending, then done, with its fee or "not known", and the venue's as-of time. */
export function WithdrawalTracker({ owner, nonce }: { owner: string; nonce: string }) {
  const venue = useVenueApi();
  const tracked = usePolled((signal) => venue.withdrawal(owner, nonce, signal), `w:${owner}:${nonce}`, VENUE_POLL_MS);
  const value = tracked.data?.value ?? null;
  if (!value || !tracked.data) return null;
  return <WithdrawalLine withdrawal={value} asOf={tracked.data.asOf} />;
}

export function WithdrawalLine({ withdrawal, asOf }: { withdrawal: VenueWithdrawal; asOf: string }) {
  const v = venueCopy.useCopy().t;
  const { t } = spotVenueCopy.useCopy();
  const clock = useClock();
  return (
    <dl className="protocol-facts" data-testid="venue-withdrawal" data-status={withdrawal.status} data-nonce={withdrawal.nonce}>
      <div>
        <dt>{v('Withdrawal status')}</dt>
        <dd>{word(v, 'withdrawal', withdrawal.status)}</dd>
      </div>
      <div>
        <dt>{v('Amount')}</dt>
        <dd className="numeric">
          {displayAmount(withdrawal.amount)} {withdrawal.asset}
        </dd>
      </div>
      <div>
        <dt>{v('Withdrawal fee')}</dt>
        <dd className="numeric" data-cell="fee">
          <Known value={withdrawal.fee} />
        </dd>
      </div>
      <div>
        <dt>{t('As of')}</dt>
        <dd className="numeric">{clock(asOf)}</dd>
      </div>
    </dl>
  );
}
