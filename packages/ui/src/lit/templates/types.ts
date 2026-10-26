/**
 * Data shapes the eight templates take. Rooms pass data and copy only: never class names, colours or sizes.
 * Spec: project-state design/new-look/redesign/templates/SPEC.md. Names that become shared contracts move to
 * `../contracts.ts` through the kit's owner.
 */
import type * as React from 'react';
import type { GateReason, Jurisdiction, Mode, MoneyStatus, Refusal, RefusalVariant, TemplateId } from '../contracts.js';

export type { Refusal, RefusalVariant };

/** An exact decimal amount as the API sends it ("1250.50"). Never a JS number (AGENTS.md, Money 2). */
export type DecimalString = string;

export interface Money {
  value: DecimalString;
  /** ISO 4217 code or an asset symbol ("GBP", "BTC", "USDC"). */
  asset: string;
  /** True for an illustrative figure: it renders with the TEST label. */
  test?: boolean;
}

/** Ledger status of one movement. `unknown` says "We're checking" with a time; it never guesses. */
export type MovementStatus = MoneyStatus;

export interface MovementStep {
  label: string;
  /** ISO time the step happened, when it has. */
  at?: string;
  state: 'done' | 'current' | 'todo' | 'failed';
}

/** One movement of money as the ledger sees it: the In-flight lane, money status and the shared receipt. */
export interface Movement {
  id: string;
  title: string;
  direction: 'in' | 'out' | 'move';
  amount: Money;
  counterparty?: string;
  status: MovementStatus;
  steps: readonly MovementStep[];
  /** Where the money is now, in ledger words ("Returned to your balance at 10:51"). Required when failed. */
  whereNow?: string;
  /** For `unknown`: when we will know more ("by 14:30"). */
  checkingUntil?: string;
  reference: string;
  /** ISO time it is expected to arrive. */
  expectedBy?: string;
  /** What happens next, in plain words. */
  next?: string;
}

/** One line of a review. `null` means the value is not set: the confirm button becomes the refusal. */
export interface ReviewLine {
  label: string;
  value: Money | string | null;
  /** Shown under the line ("Mid-market rate plus 0.5%"). */
  note?: string;
}

export interface ReviewData {
  lines: readonly ReviewLine[];
  total: ReviewLine;
  recipientGets?: ReviewLine;
  arrival?: ReviewLine;
  /** The button names the outcome ("Send £250.00 to Aisha Khan"), never "Yes" or "Confirm". */
  confirmLabel: string;
  editLabel?: string;
  /** Shown instead of the button when a line is null. */
  missing: Refusal;
}

/** A notice above the room: an account hold, a platform pause or an incident. Most serious first. */
export interface Notice {
  id: string;
  /** An incident is drawn as `unreachable` with its own words (FG26/5 4.37: proactive status, no silence). */
  refusal: Refusal;
}

/** The state a room is in. Stale and partial are modifiers on ready. */
export type RoomState =
  | { kind: 'ready'; stale?: { asOf: string; onRefresh?: () => void }; partial?: { missing: Refusal } }
  | { kind: 'loading' }
  | { kind: 'empty'; title: string; body?: string; action?: { label: string; href: string } }
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'gated'; gate: GateReason; refusal: Refusal }
  | { kind: 'money-status'; movement: Movement }
  | { kind: 'confirm'; review: ReviewData; onConfirm?: () => void; onEdit?: () => void }
  | { kind: 'receipt'; movement: Movement };

export type RoomStateKind = RoomState['kind'];

/** A legal moment a room carries; the registry decides its words for the market in force. */
export type LegalMomentId =
  | 'crypto-risk-band'
  | 'crypto-risk-summary'
  | 'first-buy-warning'
  | 'cooling-off'
  | 'appropriateness'
  | 'credit-warning'
  | 'cfd-warning'
  | 'derivatives-uk-parked'
  | 'mica-marketing'
  | 'marketing-label'
  | 'regulated-status'
  | 'payee-check'
  | 'scam-stop'
  | 'withdraw-from-contract'
  | 'confirm-withdrawal'
  | 'talk-to-a-person'
  | 'asset-documents';

/** The market in force. `unset` until the owner decides which market launches (RULES-AND-TRUST, header). */
export type Market = Jurisdiction;

/** Props every template takes. */
export interface RoomProps {
  /** The room's name, as the navigation copy has it. */
  title: string;
  description?: string;
  /** At most one room action in the title row. */
  roomAction?: React.ReactNode;
  state: RoomState;
  mode?: Mode;
  /** Legal moments this room carries (RULES-AND-TRUST section B). */
  legal?: readonly LegalMomentId[];
  market?: Market;
  /** Opens the risk summary from the band's fixed link. */
  onRiskSummary?: () => void;
  notices?: readonly Notice[];
  inFlight?: readonly Movement[];
  /** Locale for dates and money; B4's formatter takes over once it lands. */
  locale?: string;
  /** The clock for "updated N min ago"; screenshots freeze it. */
  now?: Date;
  /** IANA zone for times; the browser's own when not given. */
  timeZone?: string;
  /** Live values a fixed legal text states ({percent} in the CFD warning); blank refuses. */
  legalValues?: Readonly<Record<string, string | undefined>>;
}

export type { TemplateId };
