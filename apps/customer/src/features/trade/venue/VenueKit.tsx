import { useCallback, useRef, type ReactNode } from 'react';
import { Badge, Checkbox } from '@intafaced/ui';
import { Button, DataTable } from '../../../shared/ui';
import { displayAmount } from '../../../shared/money';
import { formatAmount, mul, parseAmount } from '@intafaced/money-math';
import { WalletProvider, usePolled, useWallet } from '../../protocol';
import {
  keys,
  walletTypedData,
  type AsOf,
  type MaybeKnown,
  preparedStep,
  type KeptSignature,
  type PreparedAnswer,
  type VenueBalance,
  type VenueFill,
  type VenueIntent,
  type VenueOrder,
  type VenueOutcome,
  type VenueUp,
} from '../venue-api';
import type { VenueMode } from '../use-venue-mode';
import { venueCopy } from './venue-copy';
import { feeShown } from './fee-rates';
import { VENUE_POLL_MS } from './poll';
import { useAsOfText, useVenueApi, word } from './venue-words';

export { VENUE_POLL_MS };
export { SETTLED_STATUSES, outcomeText, useAsOfText, useVenueApi, word } from './venue-words';
export { OutcomeLine, ReadBack } from './volt/VoltVenue';

/** The TEST label every venue figure carries while the venue is a TEST one. */
export function TestMark({ test }: { test: boolean }) {
  const { t } = venueCopy.useCopy();
  if (!test) return null;
  return (
    <Badge tone="warn" data-testid="venue-test" title={t('Venue TEST note')}>
      {t('TEST')}
    </Badge>
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
    <p className="muted" data-testid="venue-as-of">
      {text(asOf)}
    </p>
  );
}

/**
 * The venue frame: the person's wallet on the network the venue signs on (its status names it; the app's own chain
 * otherwise), the venue named with its TEST label and the trading-mode line. Every desk in venue mode sits inside it.
 */
export function VenueFrame({ mode, children }: { mode: Extract<VenueMode, { mode: 'on' }>; children: ReactNode }) {
  const status = mode.status;
  const chainId = status.available && status.chainId ? status.chainId : undefined;
  return (
    <WalletProvider chainId={chainId} scope="venue-desk">
      {children}
    </WalletProvider>
  );
}

export function VenueHeader({ status, title, feeLine }: { status: VenueUp; title: ReactNode; feeLine?: ReactNode }) {
  const { t } = venueCopy.useCopy();
  return (
    <header className="dk-panel dk-venue-head" data-testid="venue-header" aria-label={t('Venue')}>
      <h1 className="dk-tab-title">
        {title} <TestMark test={status.test} />
      </h1>
      <p data-testid="venue-name">
        {t('Venue')}: {status.venue.displayName} <TestMark test={status.test} />
      </p>
      <p data-testid="venue-trading-mode">
        {t('Trading mode')}: {t('Trading mode line', { venue: status.venue.displayName })}
      </p>
      {feeLine ? <p data-testid="venue-fee-line">{feeLine}</p> : null}
    </header>
  );
}

// The wallet panel is drawn from the Volt kit in its own file, so a room that shows it draws only from the kit.
export { WalletBar } from './WalletBar';

/** The connected wallet's address, lowercase, which is the venue account's owner; null until connected on the right network. */
export function useOwner(): string | null {
  const wallet = useWallet();
  return wallet.status === 'connected' && wallet.address && (!wallet.guard || wallet.guard.ok) ? wallet.address.toLowerCase() : null;
}

/**
 * The business keys of this browser's own venue orders, by the venue's client order id: the one thing kept on the
 * client (sessionStorage, per owner), so a Cancel after a reload names the same order. Storage may be blocked; the desk
 * then keeps them for the page only.
 */
export function heldKeys(owner: string) {
  const name = `if.venue.keys.${owner}`;
  const memory = new Map<string, string>();
  const read = (): Record<string, string> => {
    try {
      const raw = sessionStorage.getItem(name);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return Object.fromEntries(memory);
    }
  };
  return {
    get: (clientOrderId: string): string | undefined => read()[clientOrderId] ?? memory.get(clientOrderId),
    /** The client ids this page placed, oldest first. */
    ids: (): string[] => [...new Set([...Object.keys(read()), ...memory.keys()])],
    set(clientOrderId: string, key: string) {
      memory.set(clientOrderId, key);
      try {
        sessionStorage.setItem(name, JSON.stringify({ ...read(), [clientOrderId]: key }));
      } catch {
        /* blocked storage: the page keeps it */
      }
    },
  };
}

/**
 * The person's own tags on the orders this page placed, by the venue's client id (J-cex-spot-03 #9). The venue stores no
 * tag, so the tag is kept beside the order key in this browser session and shown on the order and its fills.
 */
export function heldTags(owner: string) {
  const name = `if.venue.tags.${owner}`;
  const memory = new Map<string, string>();
  const read = (): Record<string, string> => {
    try {
      const raw = sessionStorage.getItem(name);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return Object.fromEntries(memory);
    }
  };
  return {
    get: (clientOrderId: string): string | undefined => read()[clientOrderId] ?? memory.get(clientOrderId),
    set(clientOrderId: string, tag: string) {
      memory.set(clientOrderId, tag);
      try {
        sessionStorage.setItem(name, JSON.stringify({ ...read(), [clientOrderId]: tag }));
      } catch {
        /* blocked storage: the page keeps it */
      }
    },
  };
}

/** How long back the desk reads fills: the venue keeps them; a week covers any session. */
const FILLS_WINDOW_MS = 7 * 24 * 3_600_000;

/** The venue's record for one account, read every VENUE_POLL_MS: balances, open orders, fills, positions, our builder approval. */
export function useVenueAccount(owner: string | null, { positions = false }: { positions?: boolean } = {}) {
  const venue = useVenueApi();
  const since = useRef(new Date(Date.now() - FILLS_WINDOW_MS).toISOString()).current;
  const balances = usePolled((signal) => (owner ? venue.balances(owner, signal) : Promise.resolve(null)), `b:${owner}`, VENUE_POLL_MS);
  const openOrders = usePolled((signal) => (owner ? venue.openOrders(owner, signal) : Promise.resolve(null)), `o:${owner}`, VENUE_POLL_MS);
  const fills = usePolled((signal) => (owner ? venue.fills(owner, since, signal) : Promise.resolve(null)), `f:${owner}`, VENUE_POLL_MS);
  const held = usePolled(
    (signal) => (owner && positions ? venue.positions(owner, signal) : Promise.resolve(null)),
    `p:${owner}:${positions}`,
    VENUE_POLL_MS,
  );
  const approval = usePolled(
    (signal) => (owner ? venue.builderFeeApproval(owner, signal) : Promise.resolve(null)),
    `a:${owner}`,
    VENUE_POLL_MS,
  );
  const reload = useCallback(() => {
    balances.reload();
    openOrders.reload();
    fills.reload();
    held.reload();
    approval.reload();
  }, [balances, openOrders, fills, held, approval]);
  return { balances, openOrders, fills, positions: held, approval, reload };
}
export type VenueAccount = ReturnType<typeof useVenueAccount>;

/** What one signed action came to, in words the desk shows. */
export type ActionResult =
  | { kind: 'outcome'; outcome: Extract<VenueOutcome, { definite: true }>; reused: boolean; clientOrderId: string | null; nonce: string }
  | { kind: 'unknown'; clientOrderId: string | null; nonce: string | null }
  | { kind: 'refused'; code: string | undefined; message: string; beforeWallet: boolean }
  | { kind: 'rejected' }
  | { kind: 'waiting' }
  | { kind: 'wallet_failed'; message: string };

export type RunAction = (
  intent: VenueIntent,
  /** `venueId`: the venue to prepare on (J-derivatives-28 routing); none is the primary venue. Submit follows the stored action. */
  opts?: { actionKey?: string; stepUpApprovalId?: string | null; venueId?: string },
) => Promise<ActionResult>;

/** The business key the door stores an intent under (user-venue-door.ts `businessKey`). */
function keyOf(intent: VenueIntent, actionKey: string | undefined): string {
  if (intent.kind === 'place_order') return intent.clientOrderKey;
  if (intent.kind === 'place_orders') return intent.actionKey;
  if (intent.kind === 'withdraw') return intent.withdrawalKey;
  if (intent.kind === 'cancel_order') return actionKey ?? keys.cancel(intent.clientOrderKey);
  if (intent.kind === 'market_margin_transfer') return intent.moveKey;
  if (intent.kind === 'update_isolated_margin' || intent.kind === 'set_account_mode') return intent.changeKey;
  if (
    intent.kind === 'spot_perps_transfer' ||
    intent.kind === 'vault_transfer' ||
    intent.kind === 'staking_transfer' ||
    intent.kind === 'staking_delegate'
  )
    return intent.moveKey;
  return actionKey ?? '';
}

/**
 * Prepare → the wallet signs → submit, once per business key. A second call with a key still in flight is the same call
 * (a double press asks for one signature); a key the door already holds comes back with its stored action, so a signed
 * one is never signed again: its first definite answer stands, and one with no definite answer is read back.
 */
export function useVenueActions(owner: string | null) {
  const venue = useVenueApi();
  const wallet = useWallet();
  const inFlight = useRef(new Map<string, Promise<ActionResult>>());
  // The signed bytes of this page's own actions, in memory only, so a submit refused before it was sent can be re-sent as
  // the same bytes. A key whose bytes may have reached the venue is never sent again.
  const signatures = useRef(new Map<string, KeptSignature>());
  const refusedBeforeSend = useRef(new Set<string>());
  // Keys this page prompted for, or told to wait for another prompt: the next press prompts here.
  const promptedHere = useRef(new Set<string>());

  const submitSigned = useCallback(
    async (key: string, prepared: PreparedAnswer['prepared'], signature: KeptSignature): Promise<ActionResult> => {
      const sent = await venue.submit(key, signature);
      if (!sent.ok) {
        if (sent.reason === 'uncertain') {
          refusedBeforeSend.current.delete(key);
          return { kind: 'unknown', clientOrderId: prepared.venueClientOrderId, nonce: prepared.nonce };
        }
        refusedBeforeSend.current.add(key);
        return { kind: 'refused', code: sent.code, message: sent.message, beforeWallet: false };
      }
      refusedBeforeSend.current.delete(key);
      const outcome = sent.data.outcome;
      if (!outcome.definite) return { kind: 'unknown', clientOrderId: prepared.venueClientOrderId, nonce: prepared.nonce };
      return { kind: 'outcome', outcome, reused: false, clientOrderId: prepared.venueClientOrderId, nonce: prepared.nonce };
    },
    [venue],
  );

  const run = useCallback<RunAction>(
    (intent, opts = {}) => {
      const key = keyOf(intent, opts.actionKey);
      const running = inFlight.current.get(key);
      if (running) return running;
      const job = (async (): Promise<ActionResult> => {
        if (!owner) return { kind: 'wallet_failed', message: '' };
        const prepared = await venue.prepare({
          owner,
          intent,
          actionKey: opts.actionKey,
          stepUpApprovalId: opts.stepUpApprovalId,
          ...(opts.venueId ? { venueId: opts.venueId } : {}),
        });
        if (!prepared.ok) return { kind: 'refused', code: prepared.code, message: prepared.message, beforeWallet: true };
        const answer = prepared.data;
        const p = answer.prepared;
        const next = preparedStep(answer, {
          kept: signatures.current.get(answer.actionKey),
          refusedBeforeSend: refusedBeforeSend.current.has(answer.actionKey),
          promptedHere: promptedHere.current.has(answer.actionKey),
        });
        switch (next.step) {
          case 'outcome':
            return { kind: 'outcome', outcome: next.outcome, reused: true, clientOrderId: p.venueClientOrderId, nonce: p.nonce };
          case 'unknown':
            return { kind: 'unknown', clientOrderId: p.venueClientOrderId, nonce: p.nonce };
          case 'resend':
            return submitSigned(answer.actionKey, p, next.signature);
          case 'wait':
            promptedHere.current.add(answer.actionKey);
            return { kind: 'waiting' };
          case 'sign':
            break;
        }
        promptedHere.current.add(answer.actionKey);
        const signed = await wallet.sign({ kind: 'typedData', typedData: walletTypedData(p.typedData) });
        if (signed.status === 'rejected') return { kind: 'rejected' };
        if (signed.status !== 'signed') return { kind: 'wallet_failed', message: signed.status === 'failed' ? signed.message : '' };
        const signature = { digest: p.digest, signature: signed.signature, signedBy: owner };
        signatures.current.set(answer.actionKey, signature);
        return submitSigned(answer.actionKey, p, signature);
      })();
      inFlight.current.set(key, job);
      void job.finally(() => inFlight.current.delete(key));
      return job;
    },
    [owner, venue, wallet, submitSigned],
  );

  /**
   * After an answer that was not definite, send the same signed bytes again under the same key (J-derivatives-28 #5): the
   * door re-sends the stored action, so the venue gets the same client order id and holds one order. Never a new
   * signature: with no signature kept on this page, it is `run` again, which reads the stored answer.
   */
  const resend = useCallback(
    async (intent: VenueIntent, opts: { actionKey?: string; venueId?: string; signature?: KeptSignature } = {}): Promise<ActionResult> => {
      const key = keyOf(intent, opts.actionKey);
      // The signature this page made, or one the page kept for the key across a reload (J-cex-spot-02 #4): the same bytes.
      const kept = signatures.current.get(key) ?? opts.signature;
      if (!kept) return run(intent, opts);
      const prepared = await venue.prepare({
        owner: owner ?? '',
        intent,
        actionKey: opts.actionKey,
        ...(opts.venueId ? { venueId: opts.venueId } : {}),
      });
      if (!prepared.ok) return { kind: 'refused', code: prepared.code, message: prepared.message, beforeWallet: true };
      return submitSigned(key, prepared.data.prepared, kept);
    },
    [owner, venue, run, submitSigned],
  );
  /** The signed bytes this page holds for a key, if any: what a resend after a reload sends again. */
  const keptSignature = useCallback((key: string): KeptSignature | undefined => signatures.current.get(key), []);
  return { run, resend, keptSignature };
}

/**
 * Whether a draft's id must be held for the next press: until the venue answers definitely, a press is the same action
 * (read back, or prompted again); after a definite answer a new press is a new action with a new id.
 */
export function keepsDraft(result: ActionResult): boolean {
  return result.kind !== 'outcome';
}

/** A venue read that failed, in the venue's words: down, refused or unreachable. */
export function ReadProblem({ failure, venueName }: { failure: { message: string; code?: string } | null; venueName: string }) {
  const { t } = venueCopy.useCopy();
  if (!failure) return null;
  const down = failure.code === 'trade.venue.venue_down';
  return (
    <p className="failure" role="alert" data-testid="venue-read-problem">
      {down ? t('Venue down', { venue: venueName, detail: failure.message }) : t('Read failed', { detail: failure.message })}
    </p>
  );
}

export function BalancesPanel({ balances, test }: { balances: AsOf<VenueBalance[]> | null; test: boolean }) {
  const { t } = venueCopy.useCopy();
  return (
    <section className="dk-panel" aria-label={t('Balances')} data-testid="venue-balances">
      <h2 className="dk-tab-title">
        {t('Balances')} <TestMark test={test} />
      </h2>
      {balances && balances.value.length > 0 ? (
        <DataTable label={t('Balances')} headers={[t('Asset'), t('Free'), t('Used'), t('Total')]}>
          {balances.value.map((b) => (
            <tr key={b.asset} data-asset={b.asset}>
              <td>{b.asset}</td>
              <td className="numeric" data-cell="free">
                {displayAmount(b.free)}
              </td>
              <td className="numeric" data-cell="used">
                {displayAmount(b.locked)}
              </td>
              <td className="numeric" data-cell="total">
                {displayAmount(b.total)}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : balances ? (
        <p className="muted">{t('No balances')}</p>
      ) : null}
      <AsOfLine asOf={balances?.asOf ?? null} />
    </section>
  );
}

export function FillsTable({
  fills,
  test,
  symbol,
  tagOf,
  withTotal = false,
}: {
  fills: AsOf<VenueFill[]> | null;
  test: boolean;
  symbol?: string;
  /** Given, each row also has its total, price times size in the quote asset (Activity, Trades: J-cex-spot-06 #8). */
  withTotal?: boolean;
  /** The person's own tag on an order, by client id; given, the table has a Tag column. */
  tagOf?: (clientOrderId: string) => string | undefined;
}) {
  const { t } = venueCopy.useCopy();
  const asOfText = useAsOfText();
  const rows = (fills?.value ?? []).filter((f) => !symbol || f.symbol === symbol);
  return (
    <div data-testid="venue-fills">
      <TestMark test={test} />
      {rows.length === 0 ? (
        <p className="muted">{t('No fills')}</p>
      ) : (
        <DataTable
          label={t('Trade history')}
          headers={[
            t('Time'),
            t('Market'),
            t('Side'),
            t('Price'),
            t('Amount'),
            ...(withTotal ? [t('Total')] : []),
            t('Role'),
            t('Venue fee'),
            t('Our builder fee'),
            t('Fee asset'),
            t('Realised result'),
            ...(tagOf ? [t('Tag')] : []),
          ]}
        >
          {rows.map((f) => (
            <tr key={f.fillId} data-fill={f.fillId} data-client-order-id={f.venueClientOrderId ?? ''}>
              <td>{asOfText(f.filledAt)}</td>
              <td>{f.symbol}</td>
              <td>{word(t, 'side', f.side)}</td>
              <td className="numeric" data-cell="price">
                {displayAmount(f.price)}
              </td>
              <td className="numeric" data-cell="amount">
                {displayAmount(f.amount)}
              </td>
              {withTotal ? (
                <td className="numeric" data-cell="total">
                  {displayAmount(fillTotal(f))} {f.symbol.split('-')[1] ?? ''}
                </td>
              ) : null}
              <td data-cell="role">{word(t, 'role', f.role)}</td>
              <td className="numeric" data-cell="venue-fee">
                <VenueFeeCell amount={f.venueFee} />
              </td>
              <td className="numeric" data-cell="builder-fee">
                {f.builderFee}
              </td>
              <td>{f.feeAsset}</td>
              <td className="numeric" data-cell="realised">
                {f.realisedPnl === null ? t('Not known') : f.realisedPnl}
              </td>
              {tagOf ? <td data-cell="tag">{f.venueClientOrderId ? (tagOf(f.venueClientOrderId) ?? '') : ''}</td> : null}
            </tr>
          ))}
        </DataTable>
      )}
      <AsOfLine asOf={fills?.asOf ?? null} />
    </div>
  );
}

/**
 * The venue's fee on one fill as it charged it (J-cex-spot-10 #4): "Zero fee" where it charged none, and a fee below zero
 * as the venue's rebate paid to the person, never a negative fee.
 */
function VenueFeeCell({ amount }: { amount: string }) {
  const { t } = venueCopy.useCopy();
  const shown = feeShown(amount);
  if (shown.kind === 'zero') return <span data-fee="zero">{t('Fill zero fee')}</span>;
  if (shown.kind === 'rebate')
    return (
      <span data-fee="rebate" data-rebate={shown.value}>
        {t('Fill venue rebate', { amount: shown.value })}
      </span>
    );
  return <>{amount}</>;
}

/** A fill's total: its price times its size, exact (both are the venue's decimals). */
export function fillTotal(f: VenueFill): string {
  return formatAmount(mul(parseAmount(f.price), parseAmount(f.amount), 'half-up'));
}

/**
 * The open orders the venue lists, and the orders this page cancelled (read back by client id), each with Cancel. A
 * repeated cancel uses the same key, so it is the same action and reports the venue's first answer. An order this page
 * placed that has since filled stays listed as the venue reads it, Filled, with nothing left to cancel.
 */
export function OrdersTable({
  orders,
  test,
  onCancel,
  cancelled,
  filled = [],
  tagOf,
  onEdit,
  select,
}: {
  orders: AsOf<VenueOrder[]> | null;
  test: boolean;
  onCancel: (order: VenueOrder) => void;
  cancelled: VenueOrder[];
  filled?: VenueOrder[];
  /** The person's own tag on an order, by client id; given, the table has a Tag column. */
  tagOf?: (clientOrderId: string) => string | undefined;
  /** Given, each resting order has an Edit button (J-cex-spot-05 #2, #4). */
  onEdit?: (order: VenueOrder) => void;
  /** Given, the table has a Select column for a batch cancel (J-cex-spot-05 #6), by client id. */
  select?: { selected: ReadonlySet<string>; onToggle: (clientOrderId: string) => void; label: (id: string) => string; header: string };
}) {
  const { t } = venueCopy.useCopy();
  const open = orders?.value ?? [];
  const listed = (o: VenueOrder, rows: VenueOrder[]) => rows.some((r) => r.venueClientOrderId === o.venueClientOrderId);
  const rows = [...open, ...cancelled.filter((c) => !listed(c, open))];
  rows.push(...filled.filter((f) => f.status === 'filled' && !listed(f, rows)));
  return (
    <div data-testid="venue-open-orders">
      <TestMark test={test} />
      {rows.length === 0 ? (
        <p className="muted">{t('No open orders')}</p>
      ) : (
        <DataTable
          label={t('Open orders')}
          headers={[
            ...(select ? [select.header] : []),
            t('Market'),
            t('Side'),
            t('Type'),
            t('Time in force'),
            t('Price'),
            t('Amount'),
            t('Filled'),
            t('Locked'),
            t('Status'),
            ...(tagOf ? [t('Tag')] : []),
            '',
          ]}
        >
          {rows.map((o) => (
            <tr key={o.venueClientOrderId ?? o.venueOrderId ?? `${o.symbol}:${o.price}`} data-client-order-id={o.venueClientOrderId ?? ''}>
              {select ? (
                <td data-cell="select">
                  {o.venueClientOrderId && (o.status === 'open' || o.status === 'partially_filled') ? (
                    <Checkbox
                      aria-label={select.label(o.venueClientOrderId)}
                      checked={select.selected.has(o.venueClientOrderId)}
                      onCheckedChange={() => select.onToggle(o.venueClientOrderId!)}
                    />
                  ) : null}
                </td>
              ) : null}
              <td>
                {o.venueClientOrderId ? (
                  <a className="text-link" data-testid="venue-order-link" href={`/trade/orders/${o.venueClientOrderId}`}>
                    {o.symbol}
                  </a>
                ) : (
                  o.symbol
                )}
              </td>
              <td>{word(t, 'side', o.side)}</td>
              <td>{word(t, 'type', o.type)}</td>
              <td data-cell="tif">{word(t, 'tif', o.timeInForce)}</td>
              <td className="numeric" data-cell="price">
                {displayAmount(o.price)}
              </td>
              <td className="numeric" data-cell="amount">
                {displayAmount(o.amount)}
              </td>
              <td className="numeric" data-cell="filled">
                {displayAmount(o.filled)}
              </td>
              <td className="numeric" data-cell="locked">
                {displayAmount(o.locked)} {o.lockedAsset}
              </td>
              <td data-cell="status">{word(t, 'status', o.status)}</td>
              {tagOf ? <td data-cell="tag">{o.venueClientOrderId ? (tagOf(o.venueClientOrderId) ?? '') : ''}</td> : null}
              <td>
                {onEdit && o.venueClientOrderId && (o.status === 'open' || o.status === 'partially_filled') ? (
                  <>
                    <Button variant="secondary" onClick={() => onEdit(o)} aria-label={t('Edit order', { id: o.venueClientOrderId })}>
                      {t('Edit')}
                    </Button>{' '}
                  </>
                ) : null}
                {o.venueClientOrderId && o.status !== 'filled' ? (
                  <Button variant="secondary" onClick={() => onCancel(o)}>
                    {o.status === 'canceled' ? t('Cancel again') : t('Cancel')}
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <AsOfLine asOf={orders?.asOf ?? null} />
    </div>
  );
}
