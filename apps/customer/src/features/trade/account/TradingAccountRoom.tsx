// hand-declared-ok: svc-bank's ownMoves, cards.list and cards.partnerHeld answers have no browser-safe schema in packages/contracts; this narrows them
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { BANK_SPACES_LIST } from '@intafaced/contracts/bank-spaces-list';
import { Button, DataTable, EmptyState, Field, Loading, Page } from '../../../shared/ui';
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
import { useVenueMode } from '../use-venue-mode';
import type { VenueUp } from '../venue-api';
import { TestMark, VENUE_POLL_MS, VenueFrame, WalletBar, useOwner, useVenueApi } from '../venue/VenueKit';
import { tradingAccountCopy } from './trading-account-copy';

/**
 * The trading account (`/trade/account`, J-derivatives-25): two named groups, each with its own source and time. Trading
 * is the person's own venue accounts, free and locked as each venue reports them; spending is their partner bank account
 * and card, as the partner reports them. Nothing is added into one INTAFACED balance, and INTAFACED holds neither.
 *
 * A move from spending to trading is two legs, each sent once (#2): the partner's transfer from the main balance to the
 * person's own wallet (svc-bank `ownMoves.toWallet`, after a fresh second factor and the wallet's signature naming the
 * move), then the wallet's own signed deposit to the venue's deposit address, which svc-bank records against the move.
 * Sending the same move again sends nothing and shows the first result. A move above what the partner reports free is
 * refused by the bank with its figure, and nothing is sent (#3). The ledger posts nothing for any of it.
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

const ownMoveSchema = z.object({
  id: z.string(),
  direction: z.literal('in'),
  assetId: z.string(),
  amount: z.string(),
  wallet: z.string(),
  status: z.enum(['opening', 'sent']),
  partner: z.string(),
  partnerRef: z.string().nullable(),
  partnerFee: z.string().nullable(),
  deliveryTx: z.string().nullable(),
  depositTx: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  depositAt: z.string().nullable(),
});
type OwnMove = z.infer<typeof ownMoveSchema>;
const cardRowsSchema = z.array(z.object({ id: z.string(), assetId: z.string(), status: z.string(), panTail: z.string() }).passthrough());
const cardHeldSchema = z.object({
  heldBy: z.enum(['ledger', 'partner', 'none']),
  figures: z.object({ assetId: z.string(), available: z.string().nullable() }).passthrough().nullable(),
});

export function TradingAccountRoom() {
  const { t } = tradingAccountCopy.useCopy();
  const mode = useVenueMode();
  const { userId } = useSession();
  if (!userId)
    return (
      <Page eyebrow={t('eyebrow')} title={t('title')}>
        <EmptyState
          title={t('signedOutTitle')}
          action={
            <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`}>
              {t('signIn')}
            </a>
          }
        >
          {t('signedOutBody')}
        </EmptyState>
      </Page>
    );
  if (mode.mode === 'checking')
    return (
      <Page eyebrow={t('eyebrow')} title={t('title')}>
        <Loading label={t('title')} />
      </Page>
    );
  if (mode.mode === 'off' || !mode.status.available)
    return (
      <Page eyebrow={t('eyebrow')} title={t('title')}>
        <EmptyState title={t('title')}>{t('venueOff')}</EmptyState>
      </Page>
    );
  const status = mode.status;
  return (
    <VenueFrame mode={mode}>
      <Page eyebrow={t('eyebrow')} title={t('title')}>
        <TestMark test={status.test} />
        <p className="muted">{t('lead')}</p>
        <p data-testid="liquidation-line">{t('liquidationLine')}</p>
        <WalletBar />
        <Owned>{(owner) => <Room owner={owner} status={status} />}</Owned>
        <p className="muted">{t('ledgerNote')}</p>
      </Page>
    </VenueFrame>
  );
}

function Owned({ children }: { children: (owner: string) => ReactNode }) {
  const { t } = tradingAccountCopy.useCopy();
  const owner = useOwner();
  if (!owner) return <p className="muted">{t('connectFirst')}</p>;
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
  // A margin call's one action (J-derivatives-26 #2): the person's own move, opened at its amount; nothing moves until they sign.
  const openMoveIn = () => {
    const amount = document.getElementById(MOVE_AMOUNT_ID);
    amount?.scrollIntoView({ block: 'center' });
    amount?.focus();
  };
  return (
    <>
      <div className="grid-2" data-revision={revision}>
        <section className="dk-panel" aria-label="Trading" data-testid="group-trading">
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
        </section>
        <SpendingGroup revision={revision} spaces={spaces} />
      </div>
      <MoveIn owner={owner} venue={primary} partner={partner} onMoved={() => setRevision((n) => n + 1)} />
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
  return (
    <div data-testid="trading-venue" data-venue={venue.name}>
      <h2 className="dk-tab-title">
        {t('tradingTitle')} <TestMark test={test} />
      </h2>
      <p className="muted" data-testid="trading-source">
        {t('tradingSource', { venue: venue.name })} · <AsOf iso={balances.data?.asOf} t={t} />
      </p>
      {balances.failure && !balances.data ? (
        <p className="failure" role="alert">
          {t('readFailed', { detail: balances.failure.message })}
        </p>
      ) : rows === null ? (
        <Loading label={t('tradingTitle')} />
      ) : rows.length === 0 ? (
        <p data-testid="trading-empty">{t('tradingEmpty')}</p>
      ) : (
        <DataTable label={t('tradingTitle')} headers={[t('hAsset'), t('hFree'), t('hLocked'), t('hTotal')]}>
          {rows.map((b) => (
            <tr key={b.asset} data-asset={b.asset}>
              <td>{b.asset}</td>
              <td className="numeric" data-cell="free">
                {displayAmount(b.free, 2)}
              </td>
              <td className="numeric" data-cell="locked">
                {displayAmount(b.locked, 2)}
              </td>
              <td className="numeric" data-cell="total">
                {displayAmount(b.total, 2)}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <CrossMargin owner={owner} venue={venue} revision={revision} onMoveIn={onMoveIn} />
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
function CrossMargin({ owner, venue, revision, onMoveIn }: { owner: string; venue: Venue; revision: number; onMoveIn: () => void }) {
  const { t } = tradingAccountCopy.useCopy();
  const api = useVenueApi();
  const summary = usePolled(
    (signal) => api.accountSummary(owner, signal, venue.id),
    `trading:cross:${owner}:${venue.id ?? ''}:${revision}`,
    VENUE_POLL_MS,
  );
  const s = summary.data?.value ?? null;
  const cross = s?.cross ?? null;
  if (!s || !cross) return null;
  return (
    <div className="form-stack" data-testid="cross-margin" data-state={cross.state}>
      {cross.state === 'margin_call' ? (
        <div role="alert" className="failure" data-testid="margin-call">
          <p>{t('marginCall', { venue: venue.name })}</p>
          <Button onClick={onMoveIn}>{t('marginCallAction')}</Button>
        </div>
      ) : null}
      <h3 className="dk-tab-title">{t('crossTitle')}</h3>
      <p className="muted">
        {t('tradingSource', { venue: venue.name })} · <AsOf iso={summary.data?.asOf} t={t} />
      </p>
      <dl className="protocol-facts">
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
      <p className="muted" data-line="cross-rule">
        {cross.rule}
      </p>
    </div>
  );
}

function CrossLine({ name, label, value, raw }: { name: string; label: string; value: string; raw?: string }) {
  return (
    <div data-line={name} data-value={raw ?? value.split(' ')[0]}>
      <dt>{label}</dt>
      <dd className="numeric">{value}</dd>
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
      <h3 className="dk-tab-title">{t('liquidationsTitle')}</h3>
      <p className="muted">
        {t('liquidationsSource', { venue: venue.name })} · <AsOf iso={read.data?.asOf} t={t} />
      </p>
      <DataTable label={t('liquidationsTitle')} headers={[t('hMarket'), t('hSize'), t('hPrice'), t('hFee'), t('hVenueId')]}>
        {parts.map(({ l, part }) => (
          <tr key={part.partId} data-part={part.partId} data-liquidation={l.liquidationId}>
            <td>
              {l.symbol} · {t(l.side === 'long' ? 'sideLong' : 'sideShort')}
            </td>
            <td className="numeric" data-cell="size">
              {part.size}
            </td>
            <td className="numeric" data-cell="price">
              {part.price}
            </td>
            <td className="numeric" data-cell="fee">
              {part.fee} {part.feeAsset}
            </td>
            <td data-cell="id">{part.partId}</td>
          </tr>
        ))}
      </DataTable>
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
      const listed = await api.query('bank', 'cards.list', { limit: 50 }, cardRowsSchema, { signal });
      if (!listed.ok) return listed;
      const open = listed.data.filter((c) => c.status !== 'closed');
      const held = await Promise.all(
        open.map(async (card) => {
          const read = await api.query('bank', 'cards.partnerHeld', { cardId: card.id, limit: 1 }, cardHeldSchema, { signal });
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
    <section className="dk-panel" aria-label="Spending" data-testid="group-spending">
      <h2 className="dk-tab-title">{t('spendingTitle')}</h2>
      {spaces.failure && !spaces.data ? (
        <p className="failure" role="alert">
          {t('spendingUnread')}
        </p>
      ) : !spaces.data ? (
        <Loading label={t('spendingTitle')} />
      ) : held.length === 0 ? (
        <p className="muted">{t('spendingNone')}</p>
      ) : (
        <>
          <p className="muted" data-testid="spending-source">
            {t('spendingSource', { partner: partner ?? '' })} · <AsOf iso={held[0]?.heldAt?.asOf} t={t} />
          </p>
          <DataTable label={t('spendingTitle')} headers={[t('hAccount'), t('hBalance')]}>
            {held.map((space) => (
              <tr key={space.id} data-space={space.kind === 'primary' ? `main:${space.assetId}` : space.id}>
                <td>{space.kind === 'primary' ? t('mainAccount', { asset: space.assetId }) : space.name}</td>
                <td className="numeric" data-cell="balance">
                  {displayAmount(space.balance, 2)} {space.assetId}
                </td>
              </tr>
            ))}
          </DataTable>
          <ul className="plain-list">
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
  const route: VenueDepositRoute | null =
    door.data && door.data.enabled && door.data.available ? ((door.data as { deposit?: VenueDepositRoute | null }).deposit ?? null) : null;
  const moves = usePolled(
    (signal) => api.query('bank', 'ownMoves.list', { limit: 20 }, z.array(ownMoveSchema), { signal }),
    `moves:${userId}`,
    READ_EVERY_MS,
  );
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
    if (!route) return setRefusal({ body: t('moveNoRoute', { venue: venue.name, asset: ASSET }) });
    if (move.depositTx) return setStage({ at: 'done', move, again: false });
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
    const message = await api.query(
      'bank',
      'ownMoves.message',
      { moveId, assetId: ASSET, amount: sent, wallet: owner },
      z.object({ message: z.string() }),
    );
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
    <section className="dk-panel form-stack" aria-label={t('moveTitle')} data-testid="move-in">
      <h2 className="dk-tab-title">{t('moveTitle')}</h2>
      <p className="muted">{t('moveLead')}</p>
      {stage.at === 'idle' || stage.at === 'done' ? (
        <div className="form-row">
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
        <div data-testid="move-review" className="form-stack">
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
        <div data-testid="move-result" data-move={stage.move.id} className="form-stack">
          <p role="status">
            {t('moveDone', { venue: venue.name, amount: displayAmount(stage.move.amount, 2), asset: stage.move.assetId })}
          </p>
          {stage.again ? <p data-testid="move-again-note">{t('moveAgainSame')}</p> : null}
          <MoveLegs move={stage.move} venue={venue} t={t} />
          <Button variant="secondary" onClick={() => void again()}>
            {t('moveSendAgain')}
          </Button>
        </div>
      ) : null}
      {refusal ? (
        <div role="alert" className="failure" data-testid="move-refusal">
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
        <p className="muted">{t('movesNone')}</p>
      ) : (
        <DataTable label={t('movesTitle')} headers={[t('hMove'), t('hPartnerLeg'), t('hDepositLeg')]}>
          {(moves.data ?? []).map((m) => (
            <tr key={m.id} data-move={m.id}>
              <td className="numeric">
                {displayAmount(m.amount, 2)} {m.assetId}
              </td>
              <td data-cell="partner-leg">{m.deliveryTx ? <Tx hash={m.deliveryTx} sent={t('legSent')} /> : t('legNotYet')}</td>
              <td data-cell="deposit-leg">{m.depositTx ? <Tx hash={m.depositTx} sent={t('legSent')} /> : t('legNotYet')}</td>
            </tr>
          ))}
        </DataTable>
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
        <span data-fee>{t('moveFeeUnknown')}</span>
      </li>
    </ol>
  );
}
