/**
 * What every template shares: the room frame (title, fixed legal band, notices, body, In-flight lane), the state
 * a room is in, and the regions that draw themselves as skeletons while loading and as figure-free ghosts behind
 * a gate. Styling is `templates.css`, which reads only `--lit-*` roles.
 */
import * as React from 'react';
import { Skeleton, type SkeletonShape } from '../components/b2-basics.js';
import { LegalSlot } from './legal/LegalSlot.js';
import { LEGAL_MOMENTS } from './legal/registry.js';
import { formatMoney } from './money.js';
import type { Movement, MovementStep, Notice, Refusal, ReviewData, ReviewLine, RoomProps, RoomState } from './types.js';
import type { TemplateId } from '../contracts.js';

const RoomContext = React.createContext<RoomState>({ kind: 'ready' });

/** How a region looks while it has no data yet: the skeleton and the ghost take the region's final shape. */
export type GhostShape = SkeletonShape;

export interface RegionProps {
  name: string;
  /** Holds the room's data: skeleton while loading, ghost when gated, absent in a whole-room state. */
  data?: boolean;
  /** Where a whole-room state (empty, refused, money status, confirm, receipt) is drawn. One per template. */
  primary?: boolean;
  ghost?: GhostShape;
  /** Landmark label when the region is a section. */
  label?: string;
  children?: React.ReactNode;
}

const WHOLE_ROOM = new Set<RoomState['kind']>(['empty', 'refused', 'money-status', 'confirm', 'receipt']);

/** One region of a template. Rooms never render these directly; templates do. */
export function Region({ name, data = false, primary = false, ghost = 'rows', label, children }: RegionProps) {
  const state = React.useContext(RoomContext);
  let body: React.ReactNode = children;
  if (primary && WHOLE_ROOM.has(state.kind)) body = <StateView state={state} />;
  else if (data && state.kind === 'loading') body = <Skeleton shape={ghost} />;
  else if (data && state.kind === 'gated') body = <Skeleton shape={ghost} busy={false} />;
  else if (data && WHOLE_ROOM.has(state.kind)) return null;
  if (body === undefined || body === null || body === false) return null;
  return (
    <section className="lt-region" data-region={name} aria-label={label}>
      {body}
    </section>
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

function time(iso: string | undefined): string | undefined {
  return iso ? iso.slice(11, 16) : undefined;
}

function Steps({ steps }: { steps: readonly MovementStep[] }) {
  return (
    <ol className="lt-steps">
      {steps.map((s) => (
        <li key={s.label} className="lt-step" data-step={s.state}>
          <span className="lt-step-dot" aria-hidden="true" />
          <span className="lt-step-label">{s.label}</span>
          <span className="lt-step-at">{time(s.at) ?? (s.state === 'current' ? 'Now' : '')}</span>
        </li>
      ))}
    </ol>
  );
}

/** The shared receipt: one movement, with the ledger as its source. Opens from every room's In-flight lane. */
export function Receipt({ movement }: { movement: Movement }) {
  return (
    <article className="lt-receipt" data-status={movement.status} aria-label={movement.title}>
      <p className="lt-receipt-status">{STATUS_WORD[movement.status]}</p>
      <p className="lt-figure lt-figure-hero" dir="ltr">
        {formatMoney(movement.amount)}
      </p>
      {movement.amount.test ? <span className="lt-test">TEST</span> : null}
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
            <dt>What happens next</dt>
            <dd>{movement.next}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}

function lineValue(line: ReviewLine): string {
  if (line.value === null) return 'Not set';
  return typeof line.value === 'string' ? line.value : formatMoney(line.value);
}

/** True when every line the customer is agreeing to has a value. */
export function reviewComplete(review: ReviewData): boolean {
  return [...review.lines, review.total, review.recipientGets, review.arrival].every((l) => l === undefined || l.value !== null);
}

/** Check your answers: every fee line, the total, what arrives and when; one button that names the outcome. */
export function Review({ review, onConfirm, onEdit }: { review: ReviewData; onConfirm?: () => void; onEdit?: () => void }) {
  const rows = [...review.lines, review.total, review.recipientGets, review.arrival].filter((l): l is ReviewLine => l !== undefined);
  const complete = reviewComplete(review);
  return (
    <div className="lt-review">
      <dl className="lt-kv">
        {rows.map((l) => (
          <div key={l.label} data-total={l === review.total || undefined} data-unset={l.value === null || undefined}>
            <dt>{l.label}</dt>
            <dd>
              {lineValue(l)}
              {l.note ? <span className="lt-kv-note">{l.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {complete ? (
        <div className="lt-actions">
          <button type="button" className="lt-button lt-button-secondary" onClick={onEdit}>
            {review.editLabel ?? 'Edit'}
          </button>
          <button type="button" className="lt-button lt-button-primary" onClick={onConfirm}>
            {review.confirmLabel}
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
      return <Review review={state.review} />;
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
            <span className="lt-inflight-amount" dir="ltr">
              {formatMoney(m.amount)}
            </span>
            <span className="lt-inflight-dots" aria-label={STATUS_WORD[m.status]}>
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

const BAND_MOMENTS = new Set(
  Object.values(LEGAL_MOMENTS)
    .filter((m) => m.placement === 'frame-top')
    .map((m) => m.id),
);

function ago(asOf: string, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(asOf)) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `at ${asOf.slice(11, 16)}`;
}

export interface RoomFrameProps extends RoomProps {
  template: TemplateId;
  children: React.ReactNode;
}

/**
 * The frame every template renders inside. The legal band reserves its own space at the top (it never overlays
 * content, so focus is never hidden under it), and the room's state is shared with every region below.
 */
export function RoomFrame(props: RoomFrameProps) {
  const { template, title, description, roomAction, state, mode = 'simple', legal = [], market = 'unset' } = props;
  const band = legal.filter((m) => BAND_MOMENTS.has(m));
  const loading = state.kind === 'loading';
  return (
    <RoomContext.Provider value={state}>
      <div
        className="lt-room"
        data-template={template}
        data-state={state.kind}
        data-mode={mode}
        data-stale={(state.kind === 'ready' && state.stale) || undefined}
        aria-busy={loading || undefined}
      >
        {band.length > 0 ? (
          <div className="lt-band-slot">
            {band.map((m) => (
              <LegalSlot key={m} moment={m} market={market} onLink={props.onRiskSummary} />
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
          <p className="lt-stale" data-region="stale">
            Updated {ago(state.stale.asOf, props.now ?? new Date())}
            {state.stale.onRefresh ? (
              <button type="button" className="lt-link" onClick={state.stale.onRefresh}>
                Refresh
              </button>
            ) : null}
          </p>
        ) : null}
        <Notices notices={props.notices ?? []} />
        {state.kind === 'ready' && state.partial ? <RefusalBox refusal={state.partial.missing} /> : null}
        {state.kind === 'gated' ? (
          <div className="lt-gate" data-gate={state.gate}>
            <RefusalBox refusal={state.refusal} />
          </div>
        ) : null}
        {loading ? (
          <p className="lt-sr" role="status">
            Loading {title}
          </p>
        ) : null}
        <div className="lt-body" inert={state.kind === 'gated' || undefined}>
          {props.children}
        </div>
        <InFlight items={props.inFlight ?? []} />
      </div>
    </RoomContext.Provider>
  );
}
