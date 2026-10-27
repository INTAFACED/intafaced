/**
 * What every template shares: the room frame (title, legal band when switched on, notices, body, In-flight lane), the state
 * a room is in, and the regions that draw themselves as skeletons while loading and as figure-free ghosts behind
 * a gate. Styling is `templates.css`, which reads only `--lit-*` roles.
 */
import * as React from 'react';
import { Skeleton, type SkeletonShape } from '../components/b2-basics.js';
import { Gate } from '../components/index.js';
import { BAND_MOMENTS, RegistryLegalSlot } from './legal/LegalSlot.js';
import { formatMoney } from './money.js';
import type {
  LegalMomentId,
  Market,
  Movement,
  MovementStep,
  Notice,
  Refusal,
  ReviewData,
  ReviewLine,
  RoomProps,
  RoomState,
} from './types.js';
import type { TemplateId } from '../contracts.js';

interface RoomContextValue {
  state: RoomState;
  locale?: string;
  /** IANA zone the customer's times show in; the browser's own when not given. */
  timeZone?: string;
  now?: Date;
  market?: Market;
  legalValues?: RoomProps['legalValues'];
  /** The template places the Gate itself (a GateArea), so live regions stay in their own grid column. */
  gateArea?: boolean;
}

const RoomContext = React.createContext<RoomContextValue>({ state: { kind: 'ready' } });

/**
 * The one switch for the risk band and the legal slots, off by default (owner decision 2026-10-27: not launching
 * yet). Off, the frame draws no band and keeps no space for it, and Review draws no legal moments; the registry and
 * `RegistryLegalSlot` stay as they are. Launch prep turns it on once, at the app root:
 * `<LegalSlotsSwitch.Provider value={true}>`.
 */
export const LegalSlotsSwitch = React.createContext(false);

/** How a region looks while it has no data yet: the skeleton and the ghost take the region's final shape. */
export type GhostShape = SkeletonShape;

export interface RegionProps {
  name: string;
  /** Holds the room's data: skeleton while loading, ghost when gated, absent in a whole-room state. */
  data?: boolean;
  /** Where a whole-room state (empty, refused, money status, confirm, receipt) is drawn. One per template. */
  primary?: boolean;
  ghost?: GhostShape;
  /** Landmark label when the region is a section; behind a gate it heads the locked outline. */
  label?: string;
  /**
   * Stays usable behind a gate ("Talk to a person", a door's room tabs). Behind a gate the template renders it
   * outside the Gate (RoomFrame's `liveBefore` / `liveAfter`), so here it draws nothing.
   */
  live?: boolean;
  /** How many skeleton items while loading, when the region's real count is known (flow has two buttons). */
  ghostCount?: number;
  children?: React.ReactNode;
}

const WHOLE_ROOM = new Set<RoomState['kind']>(['empty', 'refused', 'money-status', 'confirm', 'receipt']);

/** States drawn across the whole room, in its primary region. */
export const WHOLE_ROOM_STATES: ReadonlySet<RoomState['kind']> = WHOLE_ROOM;

/** One region of a template. Rooms never render these directly; templates do. */
export function Region({ name, data = false, primary = false, ghost = 'rows', ghostCount, label, live = false, children }: RegionProps) {
  const { state, gateArea } = React.useContext(RoomContext);
  if (live && state.kind === 'gated' && !gateArea) return null;
  // A live region with nothing in it (a reading index the room didn't pass) draws nothing behind a gate, never an
  // empty box: there is nothing to reach, and the gate says why.
  if (live && state.kind === 'gated' && children === null) return null;
  // `undefined` means the room doesn't use this region; `null` means its data isn't here yet, so a data region
  // still draws its skeleton while loading and its locked outline behind a gate.
  const unused = children === undefined || children === false;
  let held = state.kind === 'ready' ? (state.partial?.regions?.[name] ?? state.stale?.regions?.[name]) : undefined;
  // A labelled data region whose data hasn't come in a partial or stale room keeps its place with an honest line,
  // never vanishing (product law: nothing hidden without a reason).
  if (held === undefined && children === null && data && label && state.kind === 'ready') {
    if (state.partial) held = `${label} can’t be shown right now`;
    else if (state.stale) held = `Refresh to see ${label.toLowerCase()}`;
  }
  const waiting = children === null && ((data && (state.kind === 'loading' || state.kind === 'gated')) || held !== undefined);
  if ((unused || children === null) && !waiting && !(primary && WHOLE_ROOM.has(state.kind))) return null;
  if (primary && WHOLE_ROOM.has(state.kind)) {
    return (
      <section className="lt-region" data-region={name} data-holds-state="" aria-label={label}>
        <StateView state={state} />
      </section>
    );
  }
  if (data && WHOLE_ROOM.has(state.kind)) return null;
  let body: React.ReactNode = children;
  let dimmed = false;
  if (held !== undefined) body = <p className="lt-held">{held}</p>;
  else if (data && state.kind === 'loading') body = <Skeleton shape={ghost} count={ghostCount} />;
  // Behind a gate a data region shows its locked outline, never figures, and never vanishes (product law: a gated
  // control is shown locked, not hidden). The Gate makes the room inert.
  // Controls (ghost "keys") stay, named and disabled, so a customer sees what verifying unlocks.
  else if (data && state.kind === 'gated' && ghost === 'keys' && children !== null) dimmed = true;
  else if (data && state.kind === 'gated' && !live) body = <Locked shape={ghost} label={label} />;
  return (
    <section
      className="lt-region"
      data-region={name}
      data-held={held !== undefined || undefined}
      data-dimmed={dimmed || undefined}
      aria-label={label}
    >
      {body}
    </section>
  );
}

/** A region behind a gate: its outline, its heading and a lock. No skeleton bars, so it never reads as loading. */
function Locked({ shape, label }: { shape: GhostShape; label?: string }) {
  return (
    <div className="lt-locked" data-ghost={shape}>
      <svg className="lt-lock" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
      </svg>
      <span>{label ?? 'Locked'}</span>
    </div>
  );
}

// ---- state views -------------------------------------------------------------------------------------------

export function RefusalBox({ refusal: copy }: { refusal: Refusal }) {
  return (
    <div className="lt-refusal" data-refusal={copy.variant} role={copy.variant === 'unreachable' ? 'alert' : undefined}>
      <p className="lt-refusal-title">{copy.title}</p>
      <p className="lt-refusal-body">{copy.body}</p>
      {copy.action ? (
        <a className="lt-button lt-button-secondary" href={copy.action.href}>
          {copy.action.label}
        </a>
      ) : null}
      {copy.reference ? <p className="lt-ref">{copy.reference}</p> : null}
    </div>
  );
}

function EmptyBox({ state }: { state: Extract<RoomState, { kind: 'empty' }> }) {
  return (
    <div className="lt-empty">
      <p className="lt-empty-title">{state.title}</p>
      {state.body ? <p className="lt-empty-body">{state.body}</p> : null}
      {state.action ? (
        <a className="lt-button lt-button-primary" href={state.action.href}>
          {state.action.label}
        </a>
      ) : null}
    </div>
  );
}

const STATUS_WORD: Record<Movement['status'], string> = {
  pending: 'On its way',
  failed: 'Didn’t go through',
  done: 'Arrived',
  unknown: 'We’re checking',
};

const statusWord = (m: Movement) => (m.status === 'failed' && m.returned ? 'Returned to your balance' : STATUS_WORD[m.status]);

/**
 * A time in the customer's zone: "10:42" today, "25 Oct, 10:42" on another day. Stands in until B4's formatter in
 * packages/i18n lands.
 */
export function clock(iso: string, now: Date, locale = 'en-GB', timeZone?: string): string {
  const at = new Date(iso);
  const day = new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const hm = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit' }).format(at);
  if (day.format(at) === day.format(now)) return hm;
  return `${new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short' }).format(at)}, ${hm}`;
}

function useClock(): (iso: string) => string {
  const { locale, timeZone, now } = React.useContext(RoomContext);
  return (iso) => clock(iso, now ?? new Date(), locale, timeZone);
}

function TestMark({ money }: { money: { test?: boolean } }) {
  return money.test ? <span className="lt-test">TEST</span> : null;
}

function Steps({ steps }: { steps: readonly MovementStep[] }) {
  const time = useClock();
  return (
    <ol className="lt-steps">
      {steps.map((s) => (
        <li key={s.label} className="lt-step" data-step={s.state}>
          <span className="lt-step-dot" aria-hidden="true" />
          <span className="lt-step-label">{s.label}</span>
          <span className="lt-step-at">{s.at ? time(s.at) : s.state === 'current' ? 'Now' : ''}</span>
        </li>
      ))}
    </ol>
  );
}

/** The shared receipt: one movement, with the ledger as its source. Opens from every room's In-flight lane. */
export function Receipt({ movement }: { movement: Movement }) {
  return (
    <article
      className="lt-receipt"
      data-status={movement.status}
      data-returned={movement.returned || undefined}
      aria-label={movement.title}
    >
      <p className="lt-receipt-status">{statusWord(movement)}</p>
      <p className="lt-figure lt-figure-hero">
        <bdi dir="ltr" data-ltr="">
          {formatMoney(movement.amount)}
        </bdi>{' '}
        <TestMark money={movement.amount} />
      </p>
      {movement.counterparty ? <p className="lt-receipt-to">{movement.counterparty}</p> : null}
      {movement.status === 'failed' && movement.whereNow ? <p className="lt-receipt-where">{movement.whereNow}</p> : null}
      {movement.status === 'unknown' ? (
        <p className="lt-receipt-where">
          We’re checking where this payment is{movement.checkingUntil ? ` and will update you ${movement.checkingUntil}` : ''}.
        </p>
      ) : null}
      <Steps steps={movement.steps} />
      <dl className="lt-kv">
        <div>
          <dt>Reference</dt>
          <dd className="lt-mono">{movement.reference}</dd>
        </div>
        {movement.next ? (
          <div>
            <dt>Next</dt>
            <dd>
              <bdi>{movement.next}</bdi>
            </dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}

function LineValue({ line }: { line: ReviewLine }) {
  if (line.value === null) return <>Not set</>;
  if (typeof line.value === 'string') return <>{line.value}</>;
  return (
    <span dir="ltr" data-ltr="">
      {formatMoney(line.value)} <TestMark money={line.value} />
    </span>
  );
}

/** True when every line the customer is agreeing to has a value. */
export function reviewComplete(review: ReviewData): boolean {
  return [...review.lines, review.total, review.recipientGets, review.arrival].every((l) => l === undefined || l.value !== null);
}

/** Check your answers: every fee line, the total, what arrives and when; one button that names the outcome. */
export function Review({ review, onConfirm, onEdit }: { review: ReviewData; onConfirm?: () => void; onEdit?: () => void }) {
  const { market = 'unset', legalValues } = React.useContext(RoomContext);
  const legal: readonly LegalMomentId[] = React.useContext(LegalSlotsSwitch) ? (review.legal ?? ['scam-stop']) : [];
  const rows = [...review.lines, review.total, review.recipientGets, review.arrival].filter((l): l is ReviewLine => l !== undefined);
  const complete = reviewComplete(review);
  return (
    <div className="lt-review">
      <dl className="lt-kv">
        {rows.map((l) => (
          <div key={l.label} data-total={l === review.total || undefined} data-unset={l.value === null || undefined}>
            <dt>{l.label}</dt>
            <dd>
              <LineValue line={l} />
              {l.note ? <span className="lt-kv-note">{l.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {legal.length > 0 ? (
        <div className="lt-live">
          {legal.map((m) =>
            m === 'scam-stop' ? (
              <div key={m} data-slot="scam-warning">
                <RegistryLegalSlot moment={m} market={market} values={legalValues} />
              </div>
            ) : (
              <RegistryLegalSlot key={m} moment={m} market={market} values={legalValues} />
            ),
          )}
        </div>
      ) : null}
      {complete ? (
        <div className="lt-actions lt-review-actions">
          <button type="button" className="lt-button lt-button-primary" onClick={onConfirm}>
            {review.confirmLabel}
          </button>
          <button type="button" className="lt-button lt-button-secondary" onClick={onEdit}>
            {review.editLabel ?? 'Edit'}
          </button>
        </div>
      ) : (
        <RefusalBox refusal={review.missing} />
      )}
    </div>
  );
}

/** A whole-room state, drawn in the template's primary region. */
export function StateView({ state }: { state: RoomState }) {
  switch (state.kind) {
    case 'empty':
      return <EmptyBox state={state} />;
    case 'refused':
      return <RefusalBox refusal={state.refusal} />;
    case 'money-status':
    case 'receipt':
      return <Receipt movement={state.movement} />;
    case 'confirm':
      return <Review review={state.review} onConfirm={state.onConfirm} onEdit={state.onEdit} />;
    default:
      return null;
  }
}

function InFlight({ items }: { items: readonly Movement[] }) {
  if (items.length === 0) return null;
  return (
    <aside className="lt-inflight" aria-label="In flight" data-region="in-flight">
      <p className="lt-inflight-title">In flight</p>
      <ul>
        {items.map((m) => (
          <li key={m.id} data-status={m.status}>
            <span className="lt-inflight-what">{m.title}</span>
            <span className="lt-inflight-amount" dir="ltr" data-ltr="">
              {formatMoney(m.amount)} <TestMark money={m.amount} />
            </span>
            <span className="lt-inflight-dots" aria-label={statusWord(m)}>
              {m.steps.map((s) => (
                <span key={s.label} data-step={s.state} />
              ))}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Notices({ notices }: { notices: readonly Notice[] }) {
  if (notices.length === 0) return null;
  const rank = (n: Notice) => (n.refusal.variant === 'platform-pause' ? 0 : n.refusal.variant === 'account-hold' ? 1 : 2);
  const top = [...notices].sort((a, b) => rank(a) - rank(b))[0]!;
  return (
    <div className="lt-notices" data-region="notices">
      <RefusalBox refusal={top.refusal} />
    </div>
  );
}

function ago(asOf: string, now: Date, locale?: string, timeZone?: string): string {
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(asOf)) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return clock(asOf, now, locale, timeZone);
}

/** The kit Gate with the room's refusal: one card in the flow, then the inert room. */
function RoomGate({ state, children }: { state: Extract<RoomState, { kind: 'gated' }>; children: React.ReactNode }) {
  return (
    <Gate
      reason={state.gate}
      title={state.refusal.title}
      body={state.refusal.body}
      action={
        state.refusal.action ? (
          <a className="lt-button lt-button-primary" href={state.refusal.action.href}>
            {state.refusal.action.label}
          </a>
        ) : undefined
      }
    >
      {children}
    </Gate>
  );
}

/**
 * Where a template with a side column (a settings index, a reading index) puts its gate: around the main area only,
 * so the live column keeps its place in the grid. Ungated it adds no box.
 */
export function GateArea({ children }: { children: React.ReactNode }) {
  const { state } = React.useContext(RoomContext);
  if (state.kind !== 'gated') return <>{children}</>;
  return (
    <div className="lt-gate-area">
      <RoomGate state={state}>
        <div className="lt-gate-cols">{children}</div>
      </RoomGate>
    </div>
  );
}

export interface RoomFrameProps extends RoomProps {
  template: TemplateId;
  children: React.ReactNode;
  /** Live regions drawn outside the Gate when gated: before it (a door's room tabs, a section index)... */
  liveBefore?: React.ReactNode;
  /** ...and after it ("Talk to a person"), so a gated customer can always reach a person. */
  liveAfter?: React.ReactNode;
  /** The template places a GateArea itself; RoomFrame then draws no Gate of its own. */
  gateArea?: boolean;
}

/**
 * The frame every template renders inside. With `LegalSlotsSwitch` on, the legal band reserves its own space at the top
 * (it never overlays content, so focus is never hidden under it); off, there is no band and no gap. The room's state
 * is shared with every region below.
 */
export function RoomFrame(props: RoomFrameProps) {
  const { template, title, description, roomAction, state, mode = 'simple', legal = [], market = 'unset' } = props;
  const band = React.useContext(LegalSlotsSwitch) ? legal.filter((m) => BAND_MOMENTS.has(m)) : [];
  const loading = state.kind === 'loading';
  return (
    <RoomContext.Provider
      value={{
        state,
        locale: props.locale,
        timeZone: props.timeZone,
        now: props.now,
        market,
        legalValues: props.legalValues,
        gateArea: props.gateArea,
      }}
    >
      <div
        className="lt-room"
        data-template={template}
        data-state={state.kind}
        data-mode={mode}
        data-band={band.length > 0 || undefined}
        data-stale={(state.kind === 'ready' && state.stale) || undefined}
        aria-busy={loading || undefined}
      >
        {band.length > 0 ? (
          <div className="lt-band-slot" data-obscures="top">
            {band.map((m) => (
              <RegistryLegalSlot key={m} moment={m} market={market} values={props.legalValues} onLink={props.onRiskSummary} />
            ))}
          </div>
        ) : null}
        <header className="lt-title-row">
          <div>
            <h1 className="lt-title">{title}</h1>
            {description ? <p className="lt-description">{description}</p> : null}
          </div>
          {roomAction ? <div className="lt-room-action">{roomAction}</div> : null}
        </header>
        {state.kind === 'ready' && state.stale ? (
          <div className="lt-stale" data-region="stale" role="status">
            <p>
              Figures as of {clock(state.stale.asOf, props.now ?? new Date(), props.locale, props.timeZone)}, updated{' '}
              {ago(state.stale.asOf, props.now ?? new Date(), props.locale, props.timeZone)}. They may have changed.
            </p>
            {state.stale.onRefresh ? (
              <button type="button" className="lt-button lt-button-secondary" onClick={state.stale.onRefresh}>
                Refresh
              </button>
            ) : null}
          </div>
        ) : null}
        <Notices notices={props.notices ?? []} />
        {state.kind === 'ready' && state.partial ? <RefusalBox refusal={state.partial.missing} /> : null}
        {loading ? (
          <p className="lt-sr" role="status">
            Loading {title}
          </p>
        ) : null}
        {state.kind === 'gated' && !props.gateArea ? (
          <div className="lt-body">
            {props.liveBefore ? <div className="lt-live">{props.liveBefore}</div> : null}
            <RoomGate state={state}>
              <div className="lt-body">{props.children}</div>
            </RoomGate>
            {props.liveAfter ? <div className="lt-live">{props.liveAfter}</div> : null}
          </div>
        ) : (
          <div className="lt-body">{props.children}</div>
        )}
        <InFlight items={props.inFlight ?? []} />
      </div>
    </RoomContext.Provider>
  );
}
