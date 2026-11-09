import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@intafaced/ui';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { Refusal, RoomState } from '@intafaced/ui/lit/templates';
import type { VenueWalletAction } from '@intafaced/contracts/protocol-venue-wallet';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { Field } from '../../../shared/ui';
import { useSession } from '../../session/session';
import { StepUpConfirm } from '../../money/StepUpConfirm';
import type { StepUpBegin } from '../../account/security-step-up';
import { useWallet } from '../wallet/WalletProvider';
import { APP_CHAIN_ID, type TypedDataDocument } from '../wallet/eip1193';
import { transferCalldata } from '../wallet/transfer';
import { createVenueWalletApi, type VenueConnection } from './venue-wallet-api';
import {
  canonicalAmount,
  createVenueAccountApi,
  plainDecimal,
  toTokenUnits,
  venueWithdrawalKey,
  withDomainTypes,
  type VenueDepositRoute,
  type VenueWithdrawal,
} from './venue-account-api';
import { venueWalletCopy, type VenueWalletCopyKey } from './venue-wallet-copy';

/**
 * /wallet/venue (J-wallet-09), on the flow template: the signed-in person connects the wallet in this browser to their
 * account. Connect asks svc-protocol for the exact message (a wallet on the sanctions list, or a visitor from a blocked
 * region, is refused here with its reason), the plain-words sheet and then the wallet sign it, and the room shows the
 * connection with its expiry. The connection is svc-protocol's record, read back on every visit, so its expiry is the
 * server's: after it, every signed action refuses until the wallet signs again. INTAFACED holds no key for the wallet.
 *
 * Deposit and withdraw (#3, #5) check the connection first (svc-protocol), then talk to the person's own venue account
 * through svc-trade's user-venue door. A deposit is the person's own token transfer from their wallet to the venue's
 * deposit address; the venue credits it and the room shows the venue's figure with its as-of time. A withdrawal is the
 * venue's action, confirmed with a fresh second factor and signed in the wallet; the room follows it pending to done,
 * with the venue's fee and the network fee, or "not known". INTAFACED moves nothing and the ledger posts nothing.
 */

/** The venue asset this room moves. TEST USDC: the stack's TEST USD token, credited by the TEST venue as USDC. */
const ASSET = 'USDC';
/** How long the room waits for the venue to credit a deposit, or settle a withdrawal, before it says so. */
const FOLLOW_MS = 120_000;
const FOLLOW_EVERY_MS = 1_500;

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
    case 'trade.user_venue_off':
      return said('venueTitle', 'venueBody');
    case 'trade.venue.venue_down':
      return said('venueDownTitle', 'venueDownBody');
    case 'trade.venue.signature_mismatch':
      return said('signatureTitle', 'signatureBody');
    case 'trade.venue.insufficient_balance':
      return said('insufficientTitle', 'insufficientBody');
    case 'identity.step_up_required':
    case 'identity.step_up_unavailable':
      return said('stepUpRefusedTitle', 'stepUpRefusedBody');
    default:
      if (code?.startsWith('trade.venue.')) return said('withdrawRefusedTitle', 'withdrawRefusedBody');
      return {
        variant: failure.reason === 'unreachable' || failure.reason === 'uncertain' ? 'unreachable' : 'refused',
        title: t('otherTitle'),
        body: t('otherBody'),
        reference,
      };
  }
}

/** The venue's figure for the room's asset: its free balance and the venue's as-of time. */
type VenueFigure = { free: string; asOf: string };

/** The venue's free balance of the asset, or null when the venue could not be read. No row is the venue holding none. */
async function readVenueFigure(account: ReturnType<typeof createVenueAccountApi>, owner: string): Promise<VenueFigure | null> {
  const read = await account.balances(owner);
  if (!read.ok) return null;
  const row = read.data.value.find((balance) => balance.asset === ASSET);
  return { free: row?.free ?? '0', asOf: read.data.asOf };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A fee the venue reports, or "not known": never shown as 0 when the venue does not publish it. */
function feeText(fee: VenueWithdrawal['fee'], t: T): string {
  return fee.known ? t('feeValue', { amount: plainDecimal(fee.value) }) : t('notKnown');
}

/** One withdrawal as the venue records it: pending, then done (or failed), with the venue's fee and the network fee. */
export function WithdrawalView({ amount, record, t }: { amount: string; record: VenueWithdrawal | null; t: T }) {
  const status = !record
    ? t('withdrawalUnknown')
    : record.status === 'pending'
      ? t('withdrawalPending')
      : record.status === 'done'
        ? t('withdrawalDone')
        : t('withdrawalFailed');
  return (
    <section data-testid="venue-withdrawal" aria-label={t('withdrawalTitle', { amount })}>
      <h3>{t('withdrawalTitle', { amount })}</h3>
      <dl>
        <div>
          <dt>{t('withdrawalStatus')}</dt>
          <dd data-testid="venue-withdrawal-status">{status}</dd>
        </div>
        {record?.destination ? (
          <div>
            <dt>{t('withdrawalTo')}</dt>
            <dd>{record.destination}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t('venueFee')}</dt>
          <dd data-testid="venue-fee">{record ? feeText(record.fee, t) : t('notKnown')}</dd>
        </div>
        <div>
          <dt>{t('networkFee')}</dt>
          <dd data-testid="network-fee">{record ? feeText(record.networkFee, t) : t('notKnown')}</dd>
        </div>
      </dl>
    </section>
  );
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

  // ── the person's venue account (svc-trade's user-venue door) ──────────────────────────────────────────────────────
  const account = useMemo(() => createVenueAccountApi(api), [api]);
  const live = connection !== null && !expired && !blocked;
  const owner = address ? address.toLowerCase() : null;
  const door = useResource(
    (signal) => (userId ? account.status(signal) : Promise.resolve({ ok: true as const, data: { enabled: false as const } })),
    `venue-door:${userId ?? 'out'}`,
  );
  const doorInfo = door.resource.status === 'ready' ? door.resource.data : null;
  const venueReady = doorInfo !== null && doorInfo.enabled && doorInfo.available;
  const route: VenueDepositRoute | null = doorInfo && doorInfo.enabled && doorInfo.available ? (doorInfo.deposit ?? null) : null;
  const [amount, setAmount] = useState('');
  const [figure, setFigure] = useState<VenueFigure | 'unread' | null>(null);
  const [depositNote, setDepositNote] = useState<{ amount: string; hash: string; credited: boolean | null } | null>(null);
  const [withdrawAsk, setWithdrawAsk] = useState<{ key: string; amount: string } | null>(null);
  const [withdrawal, setWithdrawal] = useState<{ amount: string; record: VenueWithdrawal | null } | null>(null);
  // Follows stop when the room goes away, so nothing keeps reading for a page that is gone.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!owner || !live || !venueReady) {
      setFigure(null);
      return;
    }
    let current = true;
    void readVenueFigure(account, owner).then((next) => {
      if (current) setFigure(next ?? 'unread');
    });
    return () => {
      current = false;
    };
  }, [account, owner, live, venueReady]);

  /** Why the venue can't be asked now, in words; null when it can. */
  function doorRefusal(): Refusal | null {
    if (!doorInfo) return venueRefusal({ ok: false, reason: 'unreachable', message: '', code: 'trade.venue.venue_down' }, t);
    if (!doorInfo.enabled) return venueRefusal({ ok: false, reason: 'not_mounted', message: '', code: 'trade.user_venue_off' }, t);
    if (!doorInfo.available) return venueRefusal({ ok: false, reason: 'unreachable', message: '', code: 'trade.venue.venue_down' }, t);
    return null;
  }
  const amountRefusal = (decimals: number): Refusal => ({
    variant: 'refused',
    title: t('amountTitle'),
    body: t('amountBody', { decimals: String(decimals) }),
  });
  const walletRefusal = (status: 'rejected' | 'failed', reason?: string): Refusal => ({
    variant: 'refused',
    title: t(status === 'rejected' ? 'signRejectedTitle' : 'signFailedTitle'),
    body: t(status === 'rejected' ? 'signRejectedBody' : 'signFailedBody'),
    reference: status === 'rejected' ? 'rejected' : reason,
  });

  /** The connection must be live for this action (svc-protocol): an expired or missing one refuses by name. */
  async function connectionLive(action: VenueWalletAction): Promise<boolean> {
    if (!address) return false;
    const checked = await venue.authorize(address, action);
    if (!checked.ok) setRefusal(venueRefusal(checked, t));
    return checked.ok;
  }

  /** Reads the venue's figure until it moves from `before` (the venue credited the deposit), or the wait ends. */
  async function followDeposit(before: string | null) {
    if (!owner) return;
    const until = Date.now() + FOLLOW_MS;
    while (mounted.current && Date.now() < until) {
      await pause(FOLLOW_EVERY_MS);
      const next = await readVenueFigure(account, owner);
      if (!mounted.current) return;
      if (next) setFigure(next);
      if (next && next.free !== before) {
        setDepositNote((note) => (note ? { ...note, credited: true } : note));
        return;
      }
    }
    if (mounted.current) setDepositNote((note) => (note ? { ...note, credited: false } : note));
  }

  const deposit = () =>
    once(async () => {
      if (!owner || !(await connectionLive('deposit'))) return;
      const closed = doorRefusal();
      if (closed) return setRefusal(closed);
      if (!route) return setRefusal({ variant: 'refused', title: t('noDepositTitle'), body: t('noDepositBody') });
      if (route.chainId !== APP_CHAIN_ID) return setRefusal({ variant: 'refused', title: t('networkTitle'), body: t('networkBody') });
      const units = toTokenUnits(amount, route.tokenDecimals);
      const sentAmount = canonicalAmount(amount);
      if (units === null || sentAmount === null) return setRefusal(amountRefusal(route.tokenDecimals));
      const before = await readVenueFigure(account, owner);
      // The person's own transfer, from their wallet to the venue's deposit address. INTAFACED sends nothing.
      const sent = await wallet.sign({ kind: 'transaction', to: route.token, data: transferCalldata(route.address, units) });
      if (sent.status === 'rejected' || sent.status === 'failed') {
        return setRefusal(walletRefusal(sent.status, sent.status === 'failed' ? sent.reason : undefined));
      }
      if (sent.status !== 'sent') return setRefusal(walletRefusal('failed', 'wallet_error'));
      setDepositNote({ amount: sentAmount, hash: sent.hash, credited: null });
      void followDeposit(before ? before.free : null);
    });

  /** Reads the withdrawal by its nonce until the venue settles it, or the wait ends. */
  async function followWithdrawal(nonce: string, withdrawn: string) {
    if (!owner) return;
    const until = Date.now() + FOLLOW_MS;
    while (mounted.current && Date.now() < until) {
      const read = await account.withdrawal(owner, nonce);
      if (!mounted.current) return;
      if (read.ok && read.data.value) {
        const record = read.data.value;
        setWithdrawal({ amount: withdrawn, record });
        if (record.status !== 'pending') {
          const next = await readVenueFigure(account, owner);
          if (mounted.current && next) setFigure(next);
          return;
        }
      }
      await pause(FOLLOW_EVERY_MS);
    }
  }

  const withdraw = () =>
    once(async () => {
      if (!owner || !(await connectionLive('withdraw'))) return;
      const closed = doorRefusal();
      if (closed) return setRefusal(closed);
      const decimals = route?.tokenDecimals ?? 6;
      const asked = canonicalAmount(amount);
      if (toTokenUnits(amount, decimals) === null || asked === null) return setRefusal(amountRefusal(decimals));
      // One key for this withdrawal: a double press or a retry of it is the same prepared action, and one wallet prompt.
      setWithdrawal(null);
      setWithdrawAsk({ key: venueWithdrawalKey(owner, Date.now()), amount: asked });
    });

  /** The step-up names exactly what svc-trade re-hashes: this key, account, asset, amount and destination. */
  const withdrawStepUp = (ask: { key: string; amount: string }): StepUpBegin => ({
    scope: 'trade.step_up.venue.withdraw',
    purpose: 'venue.withdraw',
    target: ask.key,
    amount: ask.amount,
    fields: { withdrawalKey: ask.key, owner: owner ?? '', subAccount: '', asset: ASSET, amount: ask.amount, destination: owner ?? '' },
  });

  const confirmedWithdraw = (stepUpApprovalId: string | null) =>
    once(async () => {
      const ask = withdrawAsk;
      if (!ask || !owner) return;
      setWithdrawAsk(null);
      const prepared = await account.prepareWithdrawal({
        owner,
        asset: ASSET,
        amount: ask.amount,
        destination: owner,
        withdrawalKey: ask.key,
        stepUpApprovalId,
      });
      if (!prepared.ok) return setRefusal(venueRefusal(prepared, t));
      // The venue's own payload, signed in the person's wallet: INTAFACED holds no key that can sign it.
      const typedData = withDomainTypes(prepared.data.prepared.typedData) as unknown as TypedDataDocument;
      const signed = await wallet.sign({ kind: 'typedData', typedData });
      if (signed.status === 'rejected' || signed.status === 'failed') {
        return setRefusal(walletRefusal(signed.status, signed.status === 'failed' ? signed.reason : undefined));
      }
      if (signed.status !== 'signed') return setRefusal(walletRefusal('failed', 'wallet_error'));
      const submitted = await account.submit(prepared.data.actionKey, {
        digest: prepared.data.prepared.digest,
        signature: signed.signature,
        signedBy: owner,
      });
      if (!submitted.ok) return setRefusal(venueRefusal(submitted, t));
      const outcome = submitted.data.outcome;
      if (outcome.definite && !outcome.accepted) {
        return setRefusal(
          venueRefusal({ ok: false, reason: 'error', message: outcome.refusal.detail, code: `trade.venue.${outcome.refusal.code}` }, t),
        );
      }
      // Accepted, or not definite: either way the venue's record, read by the nonce, is the answer.
      setWithdrawal({ amount: ask.amount, record: null });
      void followWithdrawal(prepared.data.prepared.nonce, ask.amount);
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
                {live && venueReady ? <p data-venue-test-label>{t('venueTest')}</p> : null}
                {live && figure === 'unread' ? <p role="status">{t('venueBalanceUnread')}</p> : null}
                {live && figure && figure !== 'unread' ? (
                  <dl data-panel="venue-balance">
                    <div>
                      <dt>{t('venueBalance')}</dt>
                      <dd data-testid="venue-balance">{t('venueBalanceValue', { amount: plainDecimal(figure.free) })}</dd>
                    </div>
                    <div>
                      <dt>{t('venueBalanceAsOf')}</dt>
                      <dd>
                        <time dateTime={figure.asOf} data-testid="venue-balance-as-of">
                          {time(figure.asOf)}
                        </time>
                      </dd>
                    </div>
                  </dl>
                ) : null}
                <Field
                  label={t('amount')}
                  hint={t('amountHint')}
                  name="venue-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  disabled={busy}
                  onChange={(event) => setAmount(event.target.value)}
                />
                <Button disabled={busy} onClick={() => void deposit()}>
                  {t('deposit')}
                </Button>{' '}
                <Button disabled={busy || withdrawAsk !== null} onClick={() => void withdraw()}>
                  {t('withdraw')}
                </Button>
                {depositNote ? (
                  <p role="status" data-testid="venue-deposit">
                    {depositNote.credited === true
                      ? t('depositCredited', { amount: depositNote.amount })
                      : depositNote.credited === false
                        ? t('depositUncredited', { hash: depositNote.hash })
                        : t('depositSent', { amount: depositNote.amount })}
                  </p>
                ) : null}
                {withdrawAsk ? (
                  <div data-venue-step-up>
                    <StepUpConfirm
                      request={() => withdrawStepUp(withdrawAsk)}
                      words={{
                        why: t('stepUpWhy'),
                        code: t('stepUpCode'),
                        codeHint: t('stepUpCodeHint'),
                        codeShort: t('stepUpCodeShort'),
                        noFactor: t('stepUpNoFactor'),
                        sendWithout: t('stepUpSendWithout'),
                      }}
                      disabled={busy}
                      onApproved={(id) => void confirmedWithdraw(id)}
                    />
                    <Button variant="secondary" disabled={busy} onClick={() => setWithdrawAsk(null)}>
                      {t('cancelStepUp')}
                    </Button>
                  </div>
                ) : null}
                {withdrawal ? <WithdrawalView amount={withdrawal.amount} record={withdrawal.record} t={t} /> : null}
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
