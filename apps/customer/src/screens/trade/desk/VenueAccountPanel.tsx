import { useRef, useState, type ReactNode } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { Sheet, Table } from '@intafaced/ui/lit/templates';
import { uiCopy } from '../../../shared/ui-copy';
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
import { useSupportedAssets } from '../../../features/money';
import {
  WITHDRAW_UNLISTED_PLACES,
  depositPlaces,
  depositTransfer,
  listedPlaces,
  shortAddress,
  withdrawStep,
  type DepositRoute,
  type ListedPlaces,
} from './venue-desk';

/** A note's kit classes: plain, or the refusal tone. */
const NOTE = { plain: 'lt-note', bad: 'lt-note lt-note-bad' } as const;

/**
 * The supported asset list's row for `asset` and `action` (J-wallet-01 #5): the venue desk's Deposit and Withdraw use the
 * same rows and precision Assets lists, read from svc-bank `assets.list`.
 */
function useListed(asset: string, action: 'deposit' | 'withdraw', unlisted: number): ListedPlaces | 'loading' {
  const { resource } = useSupportedAssets();
  if (resource.status === 'loading') return 'loading';
  // Refused as this person's (a bank read a person cleared for trading alone may not make): not a list that is down.
  const rows = resource.status === 'ready' ? resource.data.assets : resource.failure.reason === 'forbidden' ? 'gated' : null;
  return listedPlaces(rows, asset, action, unlisted);
}

/** Why the list keeps `asset` from `action`, in plain words, or null when it allows it. */
function ListedRefusal({ listed, asset, action }: { listed: ListedPlaces | 'loading'; asset: string; action: 'deposit' | 'withdraw' }) {
  const { t } = spotVenueCopy.useCopy();
  if (listed === 'loading') return <p className="lt-note">{t('Listed loading')}</p>;
  if (listed.ok) return null;
  const text =
    listed.why === 'unread'
      ? t('Listed unread')
      : listed.why === 'unlisted'
        ? t('Listed unlisted', { asset })
        : t(action === 'deposit' ? 'Listed closed deposit' : 'Listed closed withdraw', { asset });
  return (
    <p role="alert" className="lt-note lt-note-bad" data-testid="venue-listed-refusal">
      {text}
    </p>
  );
}

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

type BalanceRow = { asset: string; free: string; locked: string };

/** The market's quote and base coins first, always, then every other coin the account holds. */
function balanceRows(held: readonly VenueBalance[], market: VenueMarket): BalanceRow[] {
  const of = (asset: string): BalanceRow => {
    const row = held.find((b) => b.asset === asset);
    return { asset, free: row?.free ?? '0', locked: row?.locked ?? '0' };
  };
  const first = [market.quoteAsset, market.baseAsset];
  return [...first.map(of), ...held.filter((b) => !first.includes(b.asset)).map((b) => of(b.asset))];
}

/** The person's venue account, the venue's figures only: its coins as one Balances table. */
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
  return (
    <section className="lt-panel" aria-label={t('Venue account')} data-testid="venue-account">
      <h2 className="lt-panel-title">
        {t('Balances')} <TestMark test={status.test} />
      </h2>
      <p className="lt-note">{t('Venue account note')}</p>
      <VenueWalletRow />
      {owner && balances ? (
        <>
          <p className="lt-note" data-testid="venue-balances-as-of">
            {t('As of')} <span className="lt-num">{clock(balances.asOf)}</span>
          </p>
          <Table<BalanceRow>
            caption={t('Balances')}
            dense
            rows={balanceRows(balances.value, market)}
            rowKey={(row) => row.asset}
            rowMarks={(row) => ({ 'data-asset': row.asset })}
            columns={[
              { key: 'coin', label: t('Coin'), cell: (row) => <strong>{row.asset}</strong> },
              {
                key: 'free',
                label: t('Free'),
                align: 'end',
                cellMarks: () => ({ 'data-cell': 'free' }),
                cell: (row) => <span className="lt-num">{displayAmount(row.free)}</span>,
              },
              {
                key: 'used',
                label: t('In orders'),
                align: 'end',
                cellMarks: () => ({ 'data-cell': 'used' }),
                cell: (row) => <span className="lt-num">{displayAmount(row.locked)}</span>,
              },
              {
                key: 'act',
                label: t('Actions'),
                align: 'end',
                cell: (row) => {
                  const amount = row.asset === market.baseAsset ? flattenable(row.free, market.lotSize) : null;
                  return amount ? (
                    <Button tone="secondary" size="sm" title={t('Flatten note', { asset: row.asset })} onClick={() => onFlatten(amount)}>
                      {t('Flatten', { asset: row.asset })}
                    </Button>
                  ) : null;
                },
              },
            ]}
          />
        </>
      ) : null}
      <p>
        <Button tone="secondary" disabled={!owner} onClick={onDeposit}>
          {t('Deposit')}
        </Button>{' '}
        <Button tone="secondary" disabled={!owner} onClick={onWithdraw}>
          {t('Withdraw')}
        </Button>
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
            {/* An address has no spaces: lt-mono wraps anywhere inside the narrow ticket column, unlike lt-num (nowrap). */}
            <span className="lt-mono" data-testid="venue-wallet-address">
              {wallet.address.toLowerCase()}
            </span>{' '}
            <Button tone="secondary" onClick={wallet.disconnect}>
              {v('Disconnect')}
            </Button>
          </p>
          {wallet.guard && !wallet.guard.ok ? (
            <p role="alert">
              {v('Wrong network', { observed: String(wallet.guard.observed ?? ''), configured: String(wallet.guard.configured) })}{' '}
              <Button tone="secondary" onClick={() => void wallet.switchNetwork()}>
                {v('Switch network')}
              </Button>
            </p>
          ) : null}
        </div>
      ) : wallet.wallets.length === 0 ? (
        <p className="lt-note">{v('No wallet')}</p>
      ) : (
        <p>
          {wallet.wallets.map((entry) => (
            <Button
              tone="secondary"
              key={entry.info.uuid}
              disabled={wallet.status === 'connecting'}
              onClick={() => void wallet.connect(entry)}
            >
              {v('Connect wallet', { name: entry.info.name })}
            </Button>
          ))}
        </p>
      )}
      {wallet.problem ? (
        <p className="lt-note lt-note-bad" role="alert">
          {wallet.problem}
        </p>
      ) : null}
    </>
  );
}

/** Deposit: the person's own wallet transfer to the venue's deposit address; the ledger posts nothing. */
export function DepositDialog({ route, test, onClose }: { route: DepositRoute | null; test: boolean; onClose: () => void }) {
  const { t } = spotVenueCopy.useCopy();
  const closeLabel = uiCopy.useCopy().t('closeDialog');
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
    <Sheet open title={t('Deposit title')} onClose={onClose} closeLabel={closeLabel}>
      <div className="lt-stack" data-testid="venue-deposit">
        <TestMark test={test} />
        {route ? (
          <>
            <p className="lt-note">{t('Deposit why', { asset })}</p>
            <Field
              label={t('Deposit amount', { asset })}
              name="venue-deposit-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <dl className="lt-kv">
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
                <dd className="lt-num">{route.chainId}</dd>
              </div>
              {places !== null && fromList ? (
                <div>
                  <dt>{t('Decimal places')}</dt>
                  <dd className="lt-num">{places}</dd>
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
        {busy ? <p className="lt-note">{t('Waiting wallet')}</p> : null}
        {note ? (
          <p role={note.good ? 'status' : 'alert'} className={note.good ? NOTE.plain : NOTE.bad}>
            {note.text}
          </p>
        ) : null}
      </div>
    </Sheet>
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
  const closeLabel = uiCopy.useCopy().t('closeDialog');
  const { run } = useVenueActions(owner);
  const draft = useRef(draftId());
  const [amount, setAmount] = useState('');
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const listed = useListed(asset, 'withdraw', WITHDRAW_UNLISTED_PLACES);
  const places = listed !== 'loading' && listed.ok ? listed.places : null;
  const fromList = listed !== 'loading' && listed.ok && listed.from === 'list';
  const withdrawalKey = keys.withdraw(owner, draft.current);
  let canonical: string | null = null;
  try {
    canonical = amount.trim() ? canonicalDecimal(amount) : null;
  } catch {
    canonical = null;
  }

  function press() {
    setProblem(null);
    if (places === null) return;
    const next = withdrawStep(amount, null, places);
    if (next.step === 'refuse' || !canonical)
      return setProblem(amount.trim() === '' ? t('Withdraw amount bad') : t('Withdraw places bad', { asset, places: String(places) }));
    setStepUp(true);
  }

  async function signed(stepUpApprovalId: string | null) {
    if (places === null) return;
    const next = withdrawStep(amount, { id: stepUpApprovalId }, places);
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
      <Sheet open title={t('Withdraw title')} onClose={onClose} closeLabel={closeLabel}>
        <div className="lt-stack" data-testid="venue-withdraw">
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
            <span className="lt-num" title={owner}>
              {shortAddress(owner)}
            </span>
          </p>
          {places !== null && fromList ? (
            <dl className="lt-kv">
              <div>
                <dt>{t('Decimal places')}</dt>
                <dd className="lt-num">{places}</dd>
              </div>
            </dl>
          ) : null}
          <ListedRefusal listed={listed} asset={asset} action="withdraw" />
          {problem ? (
            <p className="lt-note lt-note-bad" role="alert">
              {problem}
            </p>
          ) : null}
          {busy ? <p className="lt-note">{v('Waiting wallet')}</p> : null}
          <OutcomeLine result={result} owner={owner} />
          <Button tone="primary" disabled={busy || places === null} onClick={press}>
            {t('Withdraw send')}
          </Button>
        </div>
      </Sheet>
      {stepUp && canonical ? (
        <Sheet open title={s('title')} onClose={() => setStepUp(false)} closeLabel={closeLabel}>
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
        </Sheet>
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
    <dl className="lt-kv" data-testid="venue-withdrawal" data-status={withdrawal.status} data-nonce={withdrawal.nonce}>
      <div>
        <dt>{v('Withdrawal status')}</dt>
        <dd>{word(v, 'withdrawal', withdrawal.status)}</dd>
      </div>
      <div>
        <dt>{v('Amount')}</dt>
        <dd className="lt-num">
          {displayAmount(withdrawal.amount)} {withdrawal.asset}
        </dd>
      </div>
      <div>
        <dt>{v('Withdrawal fee')}</dt>
        <dd className="lt-num" data-cell="fee">
          <Known value={withdrawal.fee} />
        </dd>
      </div>
      <div>
        <dt>{t('As of')}</dt>
        <dd className="lt-num">{clock(asOf)}</dd>
      </div>
    </dl>
  );
}
