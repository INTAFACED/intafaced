import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react';
import { EmailProofNotice } from '../../account';
import { Button, Tag } from '@intafaced/ui/lit';
import { Checkbox, Table, type Column } from '@intafaced/ui/lit/templates';
import { displayAmount } from '../../../shared/money';
import { WalletProvider, signWithSessionKey, usePolled, useWallet } from '../../protocol';
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
import { fillTotal, groupVenueFillsByOrder, readAllVenueOrders, type VenueFillGroup } from './venue-fill-groups';
import { chooseSigner, signerOfSignature, type DeskSigner, type SessionSigning } from './session-signer';

export { VENUE_POLL_MS, fillTotal, readAllVenueOrders };
export { SETTLED_STATUSES, outcomeText, useAsOfText, useVenueApi, word } from './venue-words';
export { OutcomeLine, ReadBack } from './volt/VoltVenue';

/** The TEST label every venue figure carries while the venue is a TEST one. */
export function TestMark({ test }: { test: boolean }) {
  const { t } = venueCopy.useCopy();
  if (!test) return null;
  return (
    <Tag tone="warn" data-testid="venue-test" title={t('Venue TEST note')}>
      {t('TEST')}
    </Tag>
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
    <p className="lt-quiet" data-testid="venue-as-of">
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
    <header className="lt-panel" data-testid="venue-header" aria-label={t('Venue')}>
      <h1 className="lt-panel-title">
        {title} <TestMark test={status.test} />
      </h1>
      <p data-testid="venue-name">
        {t('Venue')}: {status.venue.displayName} <TestMark test={status.test} />
      </p>
      <p data-testid="venue-trading-mode">
        {t('Trading mode')}: {t('Trading mode line', { venue: status.venue.displayName })}
      </p>
      {feeLine ? <p data-testid="venue-fee-line">{feeLine}</p> : null}
      {/* J-identity-01 #8: our door holds a new order until the email is proved; every venue desk says so first. */}
      <EmailProofNotice />
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
  opts?: {
    actionKey?: string;
    stepUpApprovalId?: string | null;
    venueId?: string;
    /** An order the venue definitely refused is sent again under its own client order id (J-derivatives-33 #5). */
    retryRefused?: boolean;
  },
) => Promise<ActionResult>;

/** The business key the door stores an intent under (user-venue-door.ts `businessKey`). */
function keyOf(intent: VenueIntent, actionKey: string | undefined): string {
  if (intent.kind === 'place_order') return intent.clientOrderKey;
  if (intent.kind === 'place_orders') return intent.actionKey;
  if (intent.kind === 'withdraw') return intent.withdrawalKey;
  if (intent.kind === 'cancel_order') return actionKey ?? keys.cancel(intent.clientOrderKey);
  if (intent.kind === 'market_margin_transfer') return intent.moveKey;
  if (intent.kind === 'update_isolated_margin' || intent.kind === 'set_account_mode' || intent.kind === 'set_position_mode')
    return intent.changeKey;
  if (
    intent.kind === 'move_position' ||
    intent.kind === 'spot_perps_transfer' ||
    intent.kind === 'vault_transfer' ||
    intent.kind === 'staking_transfer' ||
    intent.kind === 'staking_delegate'
  )
    return intent.moveKey;
  return actionKey ?? '';
}

/** The refusal codes the desk gives an action it could not sign for want of a trading session (session-signer.ts). */
export const SESSION_NEEDED = 'trade.venue_session_needed';
export const SESSION_KEY_GONE = 'trade.venue_session_key_gone';

/**
 * The desk's trading session (VenueSession.tsx `useDeskSession`), for an action the desk prepares outside
 * `useVenueActions`: a position's exit order (VenueProtect.tsx `useSignPrepared`). Null where no desk provides one, and
 * the owner's wallet signs.
 */
export const DeskSigningContext = createContext<SessionSigning | null>(null);
export const useDeskSigning = () => useContext(DeskSigningContext);

export type ExitSigner = { signer: DeskSigner };
/** Who signs an exit order (an order, so `place_order`'s signer): the desk's live session key where trades need one. */
export function useExitSignerChoice(owner: string): () => ExitSigner | { needs: 'session' } {
  const signing = useDeskSigning();
  return useCallback(() => chooseSigner('place_order', owner, signing), [owner, signing]);
}

/**
 * Prepare → the wallet signs → submit, once per business key. A second call with a key still in flight is the same call
 * (a double press asks for one signature); a key the door already holds comes back with its stored action, so a signed
 * one is never signed again: its first definite answer stands, and one with no definite answer is read back.
 *
 * With a session (given, or the desk's DeskSigningContext: a venue whose trades a trading session's key signs,
 * session-signer.ts), an order, cancel, change or
 * leverage is prepared for the live session key and signed by it here, with no wallet prompt; approvals and every move of
 * funds stay the owner wallet's. Without a live key on such a venue, nothing is prepared: the desk offers the session.
 */
export function useVenueActions(owner: string | null, given?: SessionSigning | null) {
  const venue = useVenueApi();
  const wallet = useWallet();
  const { t } = venueCopy.useCopy();
  // Not given: the session of the desk this room sits in (DeskSigningContext), none outside one.
  const fromDesk = useDeskSigning();
  const session = given === undefined ? fromDesk : given;
  // The session as of the press, read when the action runs (a session started after this render signs the next press).
  const sessionNow = useRef(session);
  sessionNow.current = session;
  // The signer each key was prepared with on this page: a retry of the key is the same action, signed by the same signer.
  const signers = useRef(new Map<string, DeskSigner>());
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
        const choice = chooseSigner(intent.kind, owner, sessionNow.current, signers.current.get(key));
        if ('needs' in choice) return { kind: 'refused', code: SESSION_NEEDED, message: t('Session needed'), beforeWallet: true };
        const signer = choice.signer;
        const prepared = await venue.prepare({
          owner,
          signer,
          intent,
          actionKey: opts.actionKey,
          stepUpApprovalId: opts.stepUpApprovalId,
          ...(opts.venueId ? { venueId: opts.venueId } : {}),
          ...(opts.retryRefused ? { retryRefused: true } : {}),
        });
        if (!prepared.ok) return { kind: 'refused', code: prepared.code, message: prepared.message, beforeWallet: true };
        const answer = prepared.data;
        const p = answer.prepared;
        signers.current.set(key, signer);
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
            // A session key prompts nobody, so there is no other prompt to wait for: it signs here.
            if (signer.role === 'agent') break;
            promptedHere.current.add(answer.actionKey);
            return { kind: 'waiting' };
          case 'sign':
            break;
        }
        if (signer.role === 'agent') {
          // The session key signs it here: no wallet prompt. A key that is no longer this sign-in's live session key signs
          // nothing; the stored action waits unsigned, and the desk says the session ended.
          const live = sessionNow.current?.live ?? null;
          if (!live || live.address.toLowerCase() !== signer.address)
            return { kind: 'refused', code: SESSION_KEY_GONE, message: t('Session key gone'), beforeWallet: true };
          const signature = await signWithSessionKey(live, p);
          signatures.current.set(answer.actionKey, signature);
          return submitSigned(answer.actionKey, p, signature);
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
    [owner, venue, wallet, submitSigned, t],
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
      // The same key under the signer it was signed by, or the door would read it as a different action.
      const signer = signers.current.get(key) ?? signerOfSignature(owner ?? '', kept.signedBy);
      const prepared = await venue.prepare({
        owner: owner ?? '',
        signer,
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
    <p className="lt-note lt-note-bad" role="alert" data-testid="venue-read-problem">
      {down ? t('Venue down', { venue: venueName, detail: failure.message }) : t('Read failed', { detail: failure.message })}
    </p>
  );
}

/** Free, used and total per asset, as the venue reads them; each row and figure marked for the room's tests. */
export function BalanceTable({ label, rows }: { label: string; rows: readonly VenueBalance[] }) {
  const { t } = venueCopy.useCopy();
  return (
    <Table
      caption={label}
      dense
      scroll
      columns={[
        { key: 'asset', label: t('Asset'), cell: (b) => b.asset },
        { key: 'free', label: t('Free'), align: 'end', cell: (b) => displayAmount(b.free), cellMarks: () => ({ 'data-cell': 'free' }) },
        { key: 'used', label: t('Used'), align: 'end', cell: (b) => displayAmount(b.locked), cellMarks: () => ({ 'data-cell': 'used' }) },
        { key: 'total', label: t('Total'), align: 'end', cell: (b) => displayAmount(b.total), cellMarks: () => ({ 'data-cell': 'total' }) },
      ]}
      rows={rows}
      rowKey={(b) => b.asset}
      rowMarks={(b) => ({ 'data-asset': b.asset })}
    />
  );
}

export function BalancesPanel({ balances, test }: { balances: AsOf<VenueBalance[]> | null; test: boolean }) {
  const { t } = venueCopy.useCopy();
  return (
    <section className="lt-panel" aria-label={t('Balances')} data-testid="venue-balances">
      <h2 className="lt-panel-title">
        {t('Balances')} <TestMark test={test} />
      </h2>
      {balances && balances.value.length > 0 ? (
        <BalanceTable label={t('Balances')} rows={balances.value} />
      ) : balances ? (
        <p className="lt-quiet">{t('No balances')}</p>
      ) : null}
      <AsOfLine asOf={balances?.asOf ?? null} />
    </section>
  );
}

type FillTableRow = { kind: 'fill'; fill: VenueFill; ofOrder: string | null } | { kind: 'order'; group: VenueFillGroup; first: VenueFill };

export function FillsTable({
  fills,
  test,
  symbol,
  tagOf,
  withTotal = false,
  orders,
  groupByOrder = false,
}: {
  fills: AsOf<VenueFill[]> | null;
  test: boolean;
  symbol?: string;
  /** Given, each row also has its total, price times size in the quote asset (Activity, Trades: J-cex-spot-06 #8). */
  withTotal?: boolean;
  /** The person's own tag on an order, by client id; given, the table has a Tag column. */
  tagOf?: (clientOrderId: string) => string | undefined;
  /** The account's venue orders keyed by lowercase venueClientOrderId, so each trade names its order's type (J-portfolio-03 #5). */
  orders?: ReadonlyMap<string, VenueOrder>;
  /** When true, orders that filled in parts sit under one order header row with their fills grouped beneath (J-portfolio-03 #5). */
  groupByOrder?: boolean;
}) {
  const { t } = venueCopy.useCopy();
  const asOfText = useAsOfText();
  const rows = (fills?.value ?? []).filter((f) => !symbol || f.symbol === symbol);
  const showType = Boolean(orders) || groupByOrder;
  const orderOf = (id: string | null): VenueOrder | undefined => (id ? orders?.get(id.toLowerCase()) : undefined);
  const typeWordOf = (id: string | null): string | null => {
    const order = orderOf(id);
    return order ? word(t, 'type', order.type) : null;
  };
  const tableRows: FillTableRow[] = groupByOrder
    ? groupVenueFillsByOrder(rows).flatMap((group): FillTableRow[] => {
        const [first] = group.fills;
        if (!first) return [];
        if (group.fills.length === 1) return [{ kind: 'fill', fill: first, ofOrder: null }];
        return [
          { kind: 'order', group, first },
          ...group.fills.map((fill): FillTableRow => ({ kind: 'fill', fill, ofOrder: group.order })),
        ];
      })
    : rows.map((fill): FillTableRow => ({ kind: 'fill', fill, ofOrder: null }));
  return (
    <div data-testid="venue-fills">
      <TestMark test={test} />
      {tableRows.length === 0 ? (
        <p className="lt-quiet">{t('No fills')}</p>
      ) : (
        <Table
          caption={t('Trade history')}
          dense
          scroll
          columns={[
            {
              key: 'time',
              label: t('Time'),
              cell: (r: FillTableRow) => asOfText(r.kind === 'fill' ? r.fill.filledAt : r.first.filledAt),
            },
            { key: 'market', label: t('Market'), cell: (r) => (r.kind === 'fill' ? r.fill.symbol : r.first.symbol) },
            { key: 'side', label: t('Side'), cell: (r) => word(t, 'side', r.kind === 'fill' ? r.fill.side : r.first.side) },
            ...(showType
              ? [
                  {
                    key: 'type',
                    label: t('Type'),
                    cell: (r) => {
                      if (r.kind === 'fill') return typeWordOf(r.fill.venueClientOrderId) ?? '—';
                      const typeWord = typeWordOf(r.group.order);
                      return typeWord
                        ? t('Order of fills', { type: typeWord, count: r.group.fills.length })
                        : t('Order of fills no type', { count: r.group.fills.length });
                    },
                    cellMarks: () => ({ 'data-cell': 'type' }),
                  } satisfies Column<FillTableRow>,
                ]
              : []),
            {
              key: 'price',
              label: t('Price'),
              align: 'end',
              cell: (r) => (r.kind === 'fill' ? displayAmount(r.fill.price) : r.group.average ? displayAmount(r.group.average) : '—'),
              cellMarks: () => ({ 'data-cell': 'price' }),
            },
            {
              key: 'amount',
              label: t('Amount'),
              align: 'end',
              cell: (r) => displayAmount(r.kind === 'fill' ? r.fill.amount : r.group.amount),
              cellMarks: () => ({ 'data-cell': 'amount' }),
            },
            ...(withTotal
              ? [
                  {
                    key: 'total',
                    label: t('Total'),
                    align: 'end',
                    cell: (r) =>
                      r.kind === 'fill'
                        ? `${displayAmount(fillTotal(r.fill))} ${r.fill.symbol.split('-')[1] ?? ''}`
                        : `${displayAmount(r.group.total)} ${r.first.symbol.split('-')[1] ?? ''}`,
                    cellMarks: () => ({ 'data-cell': 'total' }),
                  } satisfies Column<FillTableRow>,
                ]
              : []),
            {
              key: 'role',
              label: t('Role'),
              cell: (r) => (r.kind === 'fill' ? word(t, 'role', r.fill.role) : '—'),
              cellMarks: () => ({ 'data-cell': 'role' }),
            },
            {
              key: 'venue-fee',
              label: t('Venue fee'),
              align: 'end',
              cell: (r) =>
                r.kind === 'fill' ? (
                  <VenueFeeCell amount={r.fill.venueFee} />
                ) : r.group.venueFee !== null ? (
                  <VenueFeeCell amount={r.group.venueFee} />
                ) : (
                  '—'
                ),
              cellMarks: () => ({ 'data-cell': 'venue-fee' }),
            },
            {
              key: 'builder-fee',
              label: t('Our builder fee'),
              align: 'end',
              cell: (r) => (r.kind === 'fill' ? r.fill.builderFee : (r.group.builderFee ?? '—')),
              cellMarks: () => ({ 'data-cell': 'builder-fee' }),
            },
            {
              key: 'fee-asset',
              label: t('Fee asset'),
              cell: (r) => (r.kind === 'fill' ? r.fill.feeAsset : (r.group.feeAsset ?? '—')),
            },
            {
              key: 'realised',
              label: t('Realised result'),
              align: 'end',
              cell: (r) =>
                r.kind === 'fill'
                  ? r.fill.realisedPnl === null
                    ? t('Not known')
                    : r.fill.realisedPnl
                  : r.group.realisedPnl === null
                    ? '—'
                    : r.group.realisedPnl,
              cellMarks: () => ({ 'data-cell': 'realised' }),
            },
            ...(tagOf
              ? [
                  {
                    key: 'tag',
                    label: t('Tag'),
                    cell: (r) => {
                      const id = r.kind === 'fill' ? r.fill.venueClientOrderId : r.group.order;
                      return id ? (tagOf(id) ?? '') : '';
                    },
                    cellMarks: () => ({ 'data-cell': 'tag' }),
                  } satisfies Column<FillTableRow>,
                ]
              : []),
          ]}
          rows={tableRows}
          rowKey={(r) => (r.kind === 'fill' ? r.fill.fillId : `order:${r.group.order}`)}
          rowMarks={(r) =>
            r.kind === 'fill'
              ? {
                  'data-fill': r.fill.fillId,
                  ...(r.ofOrder ? { 'data-of': r.ofOrder, 'data-part': 'fill' } : {}),
                  'data-client-order-id': r.fill.venueClientOrderId ?? '',
                }
              : {
                  'data-part': 'order',
                  ...(r.group.order ? { 'data-order': r.group.order } : {}),
                  'data-client-order-id': r.group.order ?? '',
                }
          }
        />
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
        <p className="lt-quiet">{t('No open orders')}</p>
      ) : (
        <Table
          caption={t('Open orders')}
          dense
          scroll
          columns={[
            ...(select
              ? [
                  {
                    key: 'select',
                    label: select.header,
                    cell: (o) =>
                      o.venueClientOrderId && (o.status === 'open' || o.status === 'partially_filled') ? (
                        <Checkbox
                          label={<span className="lt-sr">{select.label(o.venueClientOrderId)}</span>}
                          checked={select.selected.has(o.venueClientOrderId)}
                          onChange={() => select.onToggle(o.venueClientOrderId!)}
                        />
                      ) : null,
                    cellMarks: () => ({ 'data-cell': 'select' }),
                  } satisfies Column<VenueOrder>,
                ]
              : []),
            {
              key: 'market',
              label: t('Market'),
              cell: (o: VenueOrder) =>
                o.venueClientOrderId ? (
                  <a className="lt-link" data-testid="venue-order-link" href={`/trade/orders/${o.venueClientOrderId}`}>
                    {o.symbol}
                  </a>
                ) : (
                  o.symbol
                ),
            },
            { key: 'side', label: t('Side'), cell: (o) => word(t, 'side', o.side) },
            { key: 'type', label: t('Type'), cell: (o) => word(t, 'type', o.type) },
            {
              key: 'tif',
              label: t('Time in force'),
              cell: (o) => word(t, 'tif', o.timeInForce),
              cellMarks: () => ({ 'data-cell': 'tif' }),
            },
            {
              key: 'price',
              label: t('Price'),
              align: 'end',
              cell: (o) => displayAmount(o.price),
              cellMarks: () => ({ 'data-cell': 'price' }),
            },
            {
              key: 'amount',
              label: t('Amount'),
              align: 'end',
              cell: (o) => displayAmount(o.amount),
              cellMarks: () => ({ 'data-cell': 'amount' }),
            },
            {
              key: 'filled',
              label: t('Filled'),
              align: 'end',
              cell: (o) => displayAmount(o.filled),
              cellMarks: () => ({ 'data-cell': 'filled' }),
            },
            {
              key: 'locked',
              label: t('Locked'),
              align: 'end',
              cell: (o) => `${displayAmount(o.locked)} ${o.lockedAsset}`,
              cellMarks: () => ({ 'data-cell': 'locked' }),
            },
            { key: 'status', label: t('Status'), cell: (o) => word(t, 'status', o.status), cellMarks: () => ({ 'data-cell': 'status' }) },
            ...(tagOf
              ? [
                  {
                    key: 'tag',
                    label: t('Tag'),
                    cell: (o) => o.label ?? (o.venueClientOrderId ? (tagOf(o.venueClientOrderId) ?? '') : ''),
                    cellMarks: () => ({ 'data-cell': 'tag' }),
                  } satisfies Column<VenueOrder>,
                ]
              : []),
            {
              key: 'actions',
              label: '',
              cell: (o) => (
                <>
                  {onEdit && o.venueClientOrderId && (o.status === 'open' || o.status === 'partially_filled') ? (
                    <>
                      <Button tone="secondary" onClick={() => onEdit(o)} aria-label={t('Edit order', { id: o.venueClientOrderId })}>
                        {t('Edit')}
                      </Button>{' '}
                    </>
                  ) : null}
                  {o.venueClientOrderId && o.status !== 'filled' ? (
                    <Button tone="secondary" onClick={() => onCancel(o)}>
                      {o.status === 'canceled' ? t('Cancel again') : t('Cancel')}
                    </Button>
                  ) : null}
                </>
              ),
            },
          ]}
          rows={rows}
          rowKey={(o) => o.venueClientOrderId ?? o.venueOrderId ?? `${o.symbol}:${o.price}`}
          rowMarks={(o) => ({ 'data-client-order-id': o.venueClientOrderId ?? '' })}
        />
      )}
      <AsOfLine asOf={orders?.asOf ?? null} />
    </div>
  );
}
