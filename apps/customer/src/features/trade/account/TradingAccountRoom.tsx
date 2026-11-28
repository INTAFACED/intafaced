// volt-room: /trade/account
// hand-declared-ok: svc-bank's ownMoves, cards.list and cards.partnerHeld answers have no browser-safe schema in packages/contracts; this narrows them
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { BANK_SPACES_LIST } from '@intafaced/contracts/bank-spaces-list';
import { Button, Field } from '@intafaced/ui/lit';
import { MonitorTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { ScrollTable, Waiting } from '../../more';
import { displayAmount } from '../../../shared/money';
import type { ApiResult } from '../../../shared/api';
import { useSession } from '../../session';
import { StepUpConfirm } from '../../money';
import type { StepUpBegin } from '../../account';
import {
  APP_CHAIN_ID,
  canonicalAmount,
  createVenueAccountApi,
  toTokenUnits,
  transferCalldata,
  usePolled,
  useWallet,
  type VenueDepositRoute,
} from '../../protocol';
import { sleep as pause } from '@intafaced/contracts/sleep';
import { ownMoveViewSchema } from '@intafaced/contracts/bank-trading-account-reads';
import { useVenueMode } from '../use-venue-mode';
import type { VenueUp } from '../venue-api';
import { VENUE_POLL_MS } from '../venue/poll';
import { useOwner, useVenueApi } from '../venue/VenueKit';
import { TestMark, VenueFrame, WalletBar } from '../venue/volt/VoltVenue';
import { tradingAccountCopy } from './trading-account-copy';
import { AccountModePanel } from './AccountMode';
import { TradingStatement } from './TradingStatement';
import { MoveOut } from './MoveOut';
import { depositRoute, routeOf } from './move-route';
import { BANK_CARDS_LIST, BANK_CARDS_PARTNER_HELD } from '@intafaced/contracts/bank-cards-procedures';
import { BANK_OWN_MOVES_LIST, BANK_OWN_MOVES_MESSAGE } from '@intafaced/contracts/bank-own-moves-procedures';

/**
 * The trading account (`/trade/account`, J-derivatives-25): two named groups, each with its own source and time. Trading
 * is the person's own venue accounts, free and locked as each venue reports them; spending is their partner bank account
 * and card, as the partner reports them. Nothing is added into one INTAFACED balance, and INTAFACED holds neither.
 *
 * A move from spending to trading is two legs, each sent once (#2): the partner's transfer from the main balance to the
 * person's own wallet (svc-bank `ownMoves.toWallet`, after a fresh second factor and the wallet's signature naming the
 * move), then the wallet's own signed deposit to the venue's deposit address, which svc-bank records against the move.
 * Sending the same move again sends nothing and shows the first result. A move above what the partner reports free is
 * refused by the bank with its figure, and nothing is sent (#3). A move back out to spending is the venue's withdrawal to
 * the wallet, then the wallet's send to the partner account (`MoveOut`, #10 #11). The ledger posts nothing for any of it.
 */

/** The asset a move carries: TEST USDC on the stack, the venue's deposit route's own asset. */
const ASSET = 'USDC';
const READ_EVERY_MS = 3_000;
/** The move's amount field, which a margin call's action opens (J-derivatives-26 #2). */
const MOVE_AMOUNT_ID = 'move-in-amount';
const FOLLOW_MS = 120_000;
const FOLLOW_EVERY_MS = 1_500;

type T = ReturnType<typeof tradingAccountCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

const ownMoveSchema = ownMoveViewSchema;
type OwnMove = z.infer<typeof ownMoveSchema>;

export function TradingAccountRoom() {
  const { t } = tradingAccountCopy.useCopy();
  const mode = useVenueMode();
  const { userId } = useSession();
  const off = (state: RoomState) => <MonitorTemplate title={t('title')} state={state} mode="pro" figures={[]} />;
  if (!userId)
    return off({
      kind: 'empty',
      title: t('signedOutTitle'),
      body: t('signedOutBody'),
      action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` },
    });
  if (mode.mode === 'checking') return off({ kind: 'loading' });
  if (mode.mode === 'off' || !mode.status.available)
    return off({ kind: 'refused', refusal: { variant: 'parked', title: t('title'), body: t('venueOff') } });
  const status = mode.status;
  return (
    <VenueFrame mode={mode}>
      <MonitorTemplate
        title={t('title')}
        description={t('lead')}
        state={{ kind: 'ready' }}
        mode="pro"
        figures={[]}
        actions={
          <div className="lt-stack">
            <TestMark test={status.test} />
            <p data-testid="liquidation-line">{t('liquidationLine')}</p>
            <WalletBar />
          </div>
        }
        panels={
          <div className="lt-stack">
            <Owned>{(owner) => <Room owner={owner} status={status} />}</Owned>
          </div>
        }
        explain={<p className="lt-hint">{t('ledgerNote')}</p>}
      />
    </VenueFrame>
  );
}

function Owned({ children }: { children: (owner: string) => ReactNode }) {
  const { t } = tradingAccountCopy.useCopy();
  const owner = useOwner();
  if (!owner) return <p className="lt-hint">{t('connectFirst')}</p>;
  return <>{children(owner)}</>;
}

/** One connected venue, as its status names it. */
interface Venue {
  readonly id: string | undefined;
  readonly name: string;
}

function venuesOf(status: VenueUp): Venue[] {
  const listed = (status.venues ?? []).filter((v): v is typeof v & { venueId: string } => v.venueId !== null);
  if (listed.length === 0) return [{ id: undefined, name: status.venue.displayName }];
  return listed.map((v) => ({ id: v.venueId, name: v.displayName ?? v.venueId }));
}

function AsOf({ iso, t }: { iso: string | null | undefined; t: T }) {
  if (!iso) return <span data-as-of="">{t('asOfUnknown')}</span>;
  return <span data-as-of={iso}>{t('asOf', { time: new Date(iso).toLocaleTimeString() })}</span>;
}

function Room({ owner, status }: { owner: string; status: VenueUp }) {
  const venues = venuesOf(status);
  const primary = venues[0]!;
  const [revision, setRevision] = useState(0);
  const spaces = useSpendingSpaces(revision);
  const partner = (spaces.data ?? []).find((s) => s.heldAt)?.heldAt?.label ?? null;
  const primarySummary = useAccountSummary(owner, primary, revision);
  // A margin call's one action (J-derivatives-26 #2): the person's own move, opened at its amount; nothing moves until they sign.
  const openMoveIn = () => {
    const amount = document.getElementById(MOVE_AMOUNT_ID);
    amount?.scrollIntoView({ block: 'center' });
    amount?.focus();
  };
  return (
    <>
      <div className="lt-grid" data-revision={revision}>
        <section className="lt-stack" aria-label="Trading" data-testid="group-trading">
          {venues.map((venue) => (
            <VenueAccount
              key={venue.id ?? 'venue'}
              owner={owner}
              venue={venue}
              test={status.test}
              revision={revision}
              onMoveIn={openMoveIn}
            />
          ))}
          {/* The trading account's statement, from the venue's own records: its liquidations and fees too (J-derivatives-26 #7). */}
          <TradingStatement status={status} owner={owner} />
        </section>
        <SpendingGroup revision={revision} spaces={spaces} />
      </div>
      <MoveIn owner={owner} venue={primary} partner={partner} onMoved={() => setRevision((n) => n + 1)} />
      <MoveOut
        owner={owner}
        venue={primary}
        summary={primarySummary.data?.value ?? null}
        partner={partner}
        onMoved={() => setRevision((n) => n + 1)}
      />
    </>
  );
}

function VenueAccount({
  owner,
  venue,
  test,
  revision,
  onMoveIn,
}: {
  owner: string;
  venue: Venue;
  test: boolean;
  revision: number;
  onMoveIn: () => void;
}) {
  const { t } = tradingAccountCopy.useCopy();
  const api = useVenueApi();
  const balances = usePolled(
    (signal) => api.balances(owner, signal, undefined, venue.id),
    `trading:${owner}:${venue.id ?? ''}:${revision}`,
    VENUE_POLL_MS,
  );
  const rows = balances.data?.value ?? null;
  const summary = useAccountSummary(owner, venue, revision);
  return (
    <div data-testid="trading-venue" data-venue={venue.name}>
      <h2>
        {t('tradingTitle')} <TestMark test={test} />
      </h2>
      <p className="lt-hint" data-testid="trading-source">
        {t('tradingSource', { venue: venue.name })} · <AsOf iso={balances.data?.asOf} t={t} />
      </p>
      {balances.failure && !balances.data ? (
        <p className="lt-refusal" role="alert">
          {t('readFailed', { detail: balances.failure.message })}
        </p>
      ) : rows === null ? (
        <Waiting label={t('tradingTitle')} />
      ) : rows.length === 0 ? (
        <p data-testid="trading-empty">{t('tradingEmpty')}</p>
      ) : (
        <ScrollTable label={t('tradingTitle')} headers={[t('hAsset'), t('hFree'), t('hLocked'), t('hTotal')]}>
          {rows.map((b) => (
            <tr key={b.asset} data-asset={b.asset}>
              <td>{b.asset}</td>
              <td className="lt-mono" data-cell="free">
                {displayAmount(b.free, 2)}
              </td>
              <td className="lt-mono" data-cell="locked">
                {displayAmount(b.locked, 2)}
              </td>
              <td className="lt-mono" data-cell="total">
                {displayAmount(b.total, 2)}
              </td>
            </tr>
          ))}
        </ScrollTable>
      )}
      <AccountModePanel owner={owner} venue={venue} balances={rows} onChanged={balances.reload} />
      <FreeMargin summary={summary} venue={venue} />
      <CrossMargin summary={summary} venue={venue} onMoveIn={onMoveIn} />
      <Liquidations owner={owner} venue={venue} revision={revision} />
    </div>
  );
}

/**
 * The venue account's cross margin as the venue judges it (J-derivatives-26 #1 #2): its equity, maintenance requirement,
 * margin ratio and liquidation level, exact decimals as the venue reports them, with their time. While the venue calls
 * for margin, one alert names the trading account, with one action: the person's own move into it. Nothing moves from
 * spending unless they sign that move.
 */
function CrossMargin({ summary, venue, onMoveIn }: { summary: ReturnType<typeof useAccountSummary>; venue: Venue; onMoveIn: () => void }) {
  const { t } = tradingAccountCopy.useCopy();
  const s = summary.data?.value ?? null;
  const cross = s?.cross ?? null;
  if (!s || !cross) return null;
  return (
    <div className="lt-stack" data-testid="cross-margin" data-state={cross.state}>
      {cross.state === 'margin_call' ? (
        <div role="alert" className="lt-refusal" data-testid="margin-call">
          <p>{t('marginCall', { venue: venue.name })}</p>
          <Button onClick={onMoveIn}>{t('marginCallAction')}</Button>
        </div>
      ) : null}
      <h3>{t('crossTitle')}</h3>
      <p className="lt-hint">
        {t('tradingSource', { venue: venue.name })} · <AsOf iso={summary.data?.asOf} t={t} />
      </p>
      <dl className="lt-kv">
        <CrossLine name="equity" label={t('crossEquity')} value={`${cross.equity} ${s.asset}`} />
        <CrossLine name="maintenance" label={t('crossMaintenance')} value={`${cross.maintenanceMargin} ${s.asset}`} />
        <CrossLine
          name="ratio"
          label={t('crossRatio')}
          value={cross.marginRatio.known ? cross.marginRatio.value : t('notReported')}
          raw={cross.marginRatio.known ? cross.marginRatio.value : ''}
        />
        <CrossLine name="liquidation" label={t('crossLiquidation')} value={`${cross.liquidationEquity} ${s.asset}`} />
      </dl>
      <p className="lt-hint" data-line="cross-rule">
        {cross.rule}
      </p>
    </div>
  );
}

/**
 * The account's free margin, beside its cross figures, as the venue reports it with its time (J-derivatives-25 #9): shown
 * with or without a cross position open, so a close that realises a profit shows what it freed.
 */
function FreeMargin({ summary, venue }: { summary: ReturnType<typeof useAccountSummary>; venue: Venue }) {
  const { t } = tradingAccountCopy.useCopy();
  const s = summary.data?.value ?? null;
  if (!s) return null;
  return (
    <p data-testid="free-margin" data-value={s.free}>
      {t('freeMargin', { amount: s.free, asset: s.asset, venue: venue.name })} · <AsOf iso={summary.data?.asOf} t={t} />
    </p>
  );
}

/** The venue account's margin summary as the venue reports it, read for the account's cross figures and its move out. */
function useAccountSummary(owner: string, venue: Venue, revision: number) {
  const api = useVenueApi();
  return usePolled(
    (signal) => api.accountSummary(owner, signal, venue.id),
    `trading:summary:${owner}:${venue.id ?? ''}:${revision}`,
    VENUE_POLL_MS,
  );
}

function CrossLine({ name, label, value, raw }: { name: string; label: string; value: string; raw?: string }) {
  return (
    <div data-line={name} data-value={raw ?? value.split(' ')[0]}>
      <dt>{label}</dt>
      <dd className="lt-mono">{value}</dd>
    </div>
  );
}

/** Every liquidation the venue reports on the account, each part with its size, price, fee and the venue's id (#3). */
function Liquidations({ owner, venue, revision }: { owner: string; venue: Venue; revision: number }) {
  const { t } = tradingAccountCopy.useCopy();
  const api = useVenueApi();
  const read = usePolled(
    (signal) => api.liquidations(owner, signal, venue.id),
    `trading:liquidations:${owner}:${venue.id ?? ''}:${revision}`,
    VENUE_POLL_MS,
  );
  const parts = (read.data?.value ?? []).flatMap((l) => l.parts.map((part) => ({ l, part })));
  if (parts.length === 0) return null;
  return (
    <div data-testid="trading-liquidations">
      <h3>{t('liquidationsTitle')}</h3>
      <p className="lt-hint">
        {t('liquidationsSource', { venue: venue.name })} · <AsOf iso={read.data?.asOf} t={t} />
      </p>
      <ScrollTable label={t('liquidationsTitle')} headers={[t('hMarket'), t('hSize'), t('hPrice'), t('hFee'), t('hVenueId')]}>
        {parts.map(({ l, part }) => (
          <tr key={part.partId} data-part={part.partId} data-liquidation={l.liquidationId}>
            <td>
              {l.symbol} · {t(l.side === 'long' ? 'sideLong' : 'sideShort')}
            </td>
            <td className="lt-mono" data-cell="size">
              {part.size}
            </td>
            <td className="lt-mono" data-cell="price">
              {part.price}
            </td>
            <td className="lt-mono" data-cell="fee">
              {part.fee} {part.feeAsset}
            </td>
            <td data-cell="id">{part.partId}</td>
          </tr>
        ))}
      </ScrollTable>
    </div>
  );
}

/** The person's bank spaces, each with where the partner holds it: read once for the room, by the spending group and the move. */
function useSpendingSpaces(revision: number) {
  const { api, userId } = useSession();
  return usePolled((signal) => api.call(BANK_SPACES_LIST, { limit: 200 }, { signal }), `spending:${userId}:${revision}`, READ_EVERY_MS);
}

function SpendingGroup({ revision, spaces }: { revision: number; spaces: ReturnType<typeof useSpendingSpaces> }) {
  const { t } = tradingAccountCopy.useCopy();
  const { api, userId } = useSession();
  const cards = usePolled(
    async (signal) => {
      const listed = await api.call(BANK_CARDS_LIST, { limit: 50 }, { signal });
      if (!listed.ok) return listed;
      const open = listed.data.filter((c) => c.status !== 'closed');
      const held = await Promise.all(
        open.map(async (card) => {
          const read = await api.call(BANK_CARDS_PARTNER_HELD, { cardId: card.id, limit: 1 }, { signal });
          return { card, held: read.ok ? read.data : null };
        }),
      );
      return { ok: true as const, data: held };
    },
    `spending:cards:${userId}:${revision}`,
    READ_EVERY_MS,
  );
  const held = (spaces.data ?? []).filter((s) => s.heldAt);
  const partner = held[0]?.heldAt?.label ?? null;
  return (
    <section className="lt-stack" aria-label="Spending" data-testid="group-spending">
      <h2>{t('spendingTitle')}</h2>
      {spaces.failure && !spaces.data ? (
        <p className="lt-refusal" role="alert">
          {t('spendingUnread')}
        </p>
      ) : !spaces.data ? (
        <Waiting label={t('spendingTitle')} />
      ) : held.length === 0 ? (
        <p className="lt-hint">{t('spendingNone')}</p>
      ) : (
        <>
          <p className="lt-hint" data-testid="spending-source">
            {t('spendingSource', { partner: partner ?? '' })} · <AsOf iso={held[0]?.heldAt?.asOf} t={t} />
          </p>
          <ScrollTable label={t('spendingTitle')} headers={[t('hAccount'), t('hBalance')]}>
            {held.map((space) => (
              <tr key={space.id} data-space={space.kind === 'primary' ? `main:${space.assetId}` : space.id}>
                <td>{space.kind === 'primary' ? t('mainAccount', { asset: space.assetId }) : space.name}</td>
                <td className="lt-mono" data-cell="balance">
                  {displayAmount(space.balance, 2)} {space.assetId}
                </td>
              </tr>
            ))}
          </ScrollTable>
          <ul className="lt-stack">
            {(cards.data ?? []).map(({ card, held: figures }) => (
              <li key={card.id} data-card={card.id} data-testid="spending-card">
                {figures?.figures?.available
                  ? t('cardLine', {
                      last4: card.panTail,
                      amount: displayAmount(figures.figures.available, 2),
                      asset: figures.figures.assetId,
                      partner: partner ?? '',
                    })
                  : t('cardLineUnknown', { last4: card.panTail })}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Where a move stands in this room. */
type Stage =
  | { at: 'idle' }
  | { at: 'review'; moveId: string; amount: string }
  | { at: 'signing' | 'sending'; moveId: string; amount: string }
  | { at: 'depositing' | 'crediting'; move: OwnMove }
  | { at: 'done'; move: OwnMove; again: boolean };

function MoveIn({ owner, venue, partner, onMoved }: { owner: string; venue: Venue; partner: string | null; onMoved: () => void }) {
  const { t } = tradingAccountCopy.useCopy();
  const { api, userId } = useSession();
  const wallet = useWallet();
  const venueApi = useVenueApi();
  const account = useMemo(() => createVenueAccountApi(api), [api]);
  const door = usePolled((signal) => account.status(signal), `move:door:${userId}`, 30_000);
  const route: VenueDepositRoute | null = routeOf(door.data);
  const moves = usePolled((signal) => api.call(BANK_OWN_MOVES_LIST, { limit: 20 }, { signal }), `moves:${userId}`, READ_EVERY_MS);
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState<Stage>({ at: 'idle' });
  const [refusal, setRefusal] = useState<{ body: string; code?: string } | null>(null);
  const kept = useRef<{ moveId: string; amount: string; walletSignature: string; stepUpApprovalId: string | null } | null>(null);
  const busy = stage.at === 'signing' || stage.at === 'sending' || stage.at === 'depositing' || stage.at === 'crediting';

  const refuseWith = (failure: Failed) => setRefusal({ body: failure.message, ...(failure.code ? { code: failure.code } : {}) });

  const review = () => {
    setRefusal(null);
    const sent = canonicalAmount(amount);
    const decimals = route?.tokenDecimals ?? 6;
    if (sent === null || toTokenUnits(amount, decimals) === null)
      return setRefusal({ body: t('moveBadAmount', { decimals: String(decimals) }) });
    setStage({ at: 'review', moveId: crypto.randomUUID(), amount: sent });
  };

  const stepUp = (moveId: string, sent: string): StepUpBegin => ({
    scope: 'bank.step_up.ownMoves.toWallet',
    purpose: 'ownMoves.toWallet',
    target: owner,
    amount: sent,
    fields: { moveId, assetId: ASSET, amount: sent, wallet: owner },
  });

  /** The venue's free USDC now, as it reports it; null when it can't be read. */
  const venueFree = async (): Promise<bigint | null> => {
    const read = await venueApi.balances(owner, undefined, undefined, venue.id);
    if (!read.ok) return null;
    const row = read.data.value.find((b) => b.asset === ASSET);
    return toTokenUnits(row?.free ?? '0', 18);
  };

  /** Leg two: the wallet's own deposit to the venue, once per move; then the venue's credit is followed. */
  const deposit = async (move: OwnMove) => {
    if (move.depositTx) return setStage({ at: 'done', move, again: false });
    const route = await depositRoute(routeOf(door.data), () => account.status());
    if (!route) return setRefusal({ body: t('moveNoRoute', { venue: venue.name, asset: ASSET }) });
    const units = toTokenUnits(move.amount, route.tokenDecimals);
    if (units === null || route.chainId !== APP_CHAIN_ID)
      return setRefusal({ body: t('moveNoRoute', { venue: venue.name, asset: ASSET }) });
    const before = await venueFree();
    setStage({ at: 'depositing', move });
    const sent = await wallet.sign({ kind: 'transaction', to: route.token, data: transferCalldata(route.address, units) });
    if (sent.status !== 'sent') {
      setStage({ at: 'idle' });
      return setRefusal({
        body:
          sent.status === 'rejected'
            ? t('moveWalletRejected')
            : t('moveWalletFailed', { detail: sent.status === 'failed' ? sent.message : '' }),
      });
    }
    const recorded = await api.mutate('bank', 'ownMoves.recordDeposit', { moveId: move.id, depositTx: sent.hash }, ownMoveSchema);
    if (!recorded.ok) {
      setStage({ at: 'idle' });
      return refuseWith(recorded);
    }
    setStage({ at: 'crediting', move: recorded.data });
    const added = toTokenUnits(move.amount, 18);
    const until = Date.now() + FOLLOW_MS;
    while (before !== null && added !== null && Date.now() < until) {
      await pause(FOLLOW_EVERY_MS);
      const now = await venueFree();
      if (now !== null && now >= before + added) break;
    }
    moves.reload();
    onMoved();
    setStage({ at: 'done', move: recorded.data, again: false });
  };

  /** Leg one, after the fresh second factor: the wallet signs the move's message, then the partner sends it once. */
  const send = async (stepUpApprovalId: string | null) => {
    if (stage.at !== 'review') return;
    const { moveId, amount: sent } = stage;
    setRefusal(null);
    setStage({ at: 'signing', moveId, amount: sent });
    const message = await api.call(BANK_OWN_MOVES_MESSAGE, { moveId, assetId: ASSET, amount: sent, wallet: owner });
    if (!message.ok) {
      setStage({ at: 'idle' });
      return refuseWith(message);
    }
    const signed = await wallet.sign({ kind: 'message', message: message.data.message });
    if (signed.status !== 'signed') {
      setStage({ at: 'idle' });
      return setRefusal({
        body:
          signed.status === 'rejected'
            ? t('moveWalletRejected')
            : t('moveWalletFailed', { detail: signed.status === 'failed' ? signed.message : '' }),
      });
    }
    kept.current = { moveId, amount: sent, walletSignature: signed.signature, stepUpApprovalId };
    setStage({ at: 'sending', moveId, amount: sent });
    const moved = await api.mutate(
      'bank',
      'ownMoves.toWallet',
      {
        moveId,
        assetId: ASSET,
        amount: sent,
        wallet: owner,
        walletSignature: signed.signature,
        ...(stepUpApprovalId ? { stepUpApprovalId } : {}),
      },
      ownMoveSchema,
    );
    if (!moved.ok) {
      setStage({ at: 'idle' });
      return refuseWith(moved);
    }
    moves.reload();
    onMoved();
    await deposit(moved.data);
  };

  /** The same move sent again: the bank answers the first move and the room asks the wallet for nothing. */
  const again = async () => {
    const first = kept.current;
    if (!first) return;
    setRefusal(null);
    const moved = await api.mutate(
      'bank',
      'ownMoves.toWallet',
      {
        moveId: first.moveId,
        assetId: ASSET,
        amount: first.amount,
        wallet: owner,
        walletSignature: first.walletSignature,
        ...(first.stepUpApprovalId ? { stepUpApprovalId: first.stepUpApprovalId } : {}),
      },
      ownMoveSchema,
    );
    if (!moved.ok) return refuseWith(moved);
    if (!moved.data.depositTx) return deposit(moved.data);
    setStage({ at: 'done', move: moved.data, again: true });
  };

  const partnerName = partner ?? (moves.data ?? [])[0]?.partner ?? null;
  const unfinished = (moves.data ?? []).filter((m) => m.status === 'sent' && !m.depositTx);
  return (
    <section className="lt-stack" aria-label={t('moveTitle')} data-testid="move-in">
      <h2>{t('moveTitle')}</h2>
      <p className="lt-hint">{t('moveLead')}</p>
      {stage.at === 'idle' || stage.at === 'done' ? (
        <div className="lt-actions">
          <Field
            id={MOVE_AMOUNT_ID}
            label={t('moveAmount', { asset: ASSET })}
            name="move-amount"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <Button onClick={review}>{t('moveReview')}</Button>
        </div>
      ) : null}
      {stage.at === 'review' ? (
        <div data-testid="move-review" className="lt-stack">
          <ol>
            <li data-leg="partner">
              {t('moveLegPartner', {
                partner: partnerName ?? t('spendingTitle'),
                amount: displayAmount(stage.amount, 2),
                asset: ASSET,
                wallet: owner,
              })}
            </li>
            <li data-leg="deposit">{t('moveLegDeposit', { amount: displayAmount(stage.amount, 2), asset: ASSET, venue: venue.name })}</li>
          </ol>
          <StepUpConfirm
            key={stage.moveId}
            request={() => stepUp(stage.moveId, stage.amount)}
            words={{
              why: t('moveStepUpWhy'),
              code: t('moveStepUpCode'),
              codeHint: t('moveStepUpCodeHint'),
              codeShort: t('moveStepUpCodeShort'),
              noFactor: t('moveStepUpNoFactor'),
              sendWithout: t('moveStepUpSendWithout'),
            }}
            disabled={busy}
            onApproved={(id) => void send(id)}
          />
        </div>
      ) : null}
      {stage.at === 'signing' ? <p role="status">{t('moveSigning')}</p> : null}
      {stage.at === 'sending' ? <p role="status">{t('moveSending')}</p> : null}
      {stage.at === 'depositing' ? <p role="status">{t('moveDepositing')}</p> : null}
      {stage.at === 'crediting' ? <p role="status">{t('moveCrediting', { venue: venue.name })}</p> : null}
      {stage.at === 'done' ? (
        <div data-testid="move-result" data-move={stage.move.id} className="lt-stack">
          <p role="status">
            {t('moveDone', { venue: venue.name, amount: displayAmount(stage.move.amount, 2), asset: stage.move.assetId })}
          </p>
          {stage.again ? <p data-testid="move-again-note">{t('moveAgainSame')}</p> : null}
          <MoveLegs move={stage.move} venue={venue} t={t} />
          <Button tone="secondary" onClick={() => void again()}>
            {t('moveSendAgain')}
          </Button>
        </div>
      ) : null}
      {refusal ? (
        <div role="alert" className="lt-refusal" data-testid="move-refusal">
          <strong>{t('moveRefusedTitle')}</strong> <span data-refusal-body>{refusal.body}</span>{' '}
          {refusal.code ? <code>{refusal.code}</code> : null}
        </div>
      ) : null}
      {unfinished.length > 0 && !busy && stage.at !== 'review'
        ? unfinished.map((m) => (
            <Button key={m.id} onClick={() => void deposit(m)}>
              {t('moveFinish', { venue: venue.name })}
            </Button>
          ))
        : null}
      <h3>{t('movesTitle')}</h3>
      {(moves.data ?? []).length === 0 ? (
        <p className="lt-hint">{t('movesNone')}</p>
      ) : (
        <ScrollTable label={t('movesTitle')} headers={[t('hMove'), t('hPartnerLeg'), t('hDepositLeg')]}>
          {(moves.data ?? []).map((m) => (
            <tr key={m.id} data-move={m.id}>
              <td className="lt-mono">
                {displayAmount(m.amount, 2)} {m.assetId}
              </td>
              <td data-cell="partner-leg">{m.deliveryTx ? <Tx hash={m.deliveryTx} sent={t('legSent')} /> : t('legNotYet')}</td>
              <td data-cell="deposit-leg" data-confirmed={m.depositConfirmed ? 'yes' : 'no'}>
                {m.depositTx ? <Tx hash={m.depositTx} sent={m.depositConfirmed ? t('legConfirmed') : t('legClaimed')} /> : t('legNotYet')}
              </td>
            </tr>
          ))}
        </ScrollTable>
      )}
    </section>
  );
}

/** A transaction hash the way a person reads it: its first and last characters, the whole hash on hover. */
function shortTx(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function Tx({ hash, sent }: { hash: string; sent: string }) {
  return (
    <span data-tx={hash} title={hash}>
      {sent} {shortTx(hash)}
    </span>
  );
}

function MoveLegs({ move, venue, t }: { move: OwnMove; venue: Venue; t: T }) {
  return (
    <ol data-testid="move-legs">
      <li data-leg="partner">
        {t('moveLegPartner', { partner: move.partner, amount: displayAmount(move.amount, 2), asset: move.assetId, wallet: move.wallet })}{' '}
        <span data-tx={move.deliveryTx ?? ''} title={move.deliveryTx ?? undefined}>
          {move.deliveryTx ? shortTx(move.deliveryTx) : null}
        </span>{' '}
        <span data-fee>
          {move.partnerFee === null ? t('moveFeeUnknown') : t('moveFee', { fee: `${displayAmount(move.partnerFee, 2)} ${move.assetId}` })}
        </span>
      </li>
      <li data-leg="deposit">
        {t('moveLegDeposit', { amount: displayAmount(move.amount, 2), asset: move.assetId, venue: venue.name })}{' '}
        <span data-tx={move.depositTx ?? ''} title={move.depositTx ?? undefined}>
          {move.depositTx ? shortTx(move.depositTx) : null}
        </span>{' '}
        {move.depositTx ? (
          <span data-confirmed={move.depositConfirmed ? 'yes' : 'no'}>{move.depositConfirmed ? t('legConfirmed') : t('legClaimed')}</span>
        ) : null}{' '}
        <span data-fee>{t('moveFeeUnknown')}</span>
      </li>
    </ol>
  );
}
