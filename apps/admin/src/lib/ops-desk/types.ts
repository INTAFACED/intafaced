import type { DeskModule } from '@/lib/desk/founder-call';
import type { CommonDeskId } from './common-sections';
import type { Part } from '@/lib/desk/part';
import type { ModuleId as AdminModuleId } from '@/lib/modules';

/**
 * Module ops desks: bank, Personal Pay, P2P, Academy, the "More" modules and Protocol.
 *
 * A desk is a catalogue of READS that svc-edge already forwards, plus an honest list of what cannot be read yet.
 * It never holds a figure of its own: every number on the page is a field the owning service returned, stamped with
 * the time this console read it, and a figure the service cannot give is printed as "not available" with the reason.
 */

export type OpsDeskId = 'bank' | 'p2p' | 'academy' | 'more' | 'protocol' | 'pay';

/** How one field of an answer is read and shown. Strict: a field of the wrong type makes the whole read invalid. */
export type CellKind =
  | 'text'
  | 'int'
  | 'bool'
  | 'time'
  /** Whole basis points, shown as a percent without floating point. */
  | 'bps'
  /** A whole number of seconds, shown as a duration ("3 h 12 min"). The number is the service's; only the display is changed. */
  | 'seconds'
  /** A decimal string a service formatted (money). Shown exactly as given, never parsed. */
  | 'amount'
  /** An array of strings. */
  | 'list'
  /** An array of `{ assetId, amount }`, one money total per asset. Shown as "12.5 USDT, 0.1 BTC", amounts exactly as given. */
  | 'assetAmounts';

export interface Column {
  /** Dotted path into the row (or the record), e.g. `spine.total`. */
  readonly key: string;
  readonly label: string;
  readonly kind: CellKind;
  /** May be null. A missing key is still invalid. */
  readonly nullable?: boolean;
  /** Shown in the row's detail only, not in the table. */
  readonly detail?: boolean;
  /**
   * The key sits inside an object the service may send as null (`halted.reason` when nothing is halted). With this set, a
   * null parent reads as a null value; without it a null parent still makes the whole read invalid. Needs `nullable`.
   */
  readonly parentNullable?: boolean;
  /**
   * The service promises exactly this value (a literal in its output schema, such as `audited: false`). A different value
   * makes the whole read invalid, so a page can never print a claim the service is not allowed to make.
   */
  readonly mustBe?: string | number | boolean;
  /**
   * The service promises this is always null (a literal `null` in its output schema, such as a failure rate it cannot compute). Any
   * other value makes the whole read invalid, so a page can never print a figure the service says it does not have. Needs `nullable`.
   */
  readonly alwaysNull?: boolean;
}

export interface ReadSpec {
  readonly id: string;
  readonly title: string;
  /** One honest sentence on what this read is and is not. */
  readonly note: string;
  readonly module: DeskModule;
  /** The service, as an operator reads it ("chain status"). When set, a failed read says "Could not load <plainName>" with its time. */
  readonly plainName?: string;
  readonly procedure: string;
  readonly input?: Readonly<Record<string, unknown>>;
  /**
   * The service needs a time window (`from` and `to`) and has no default. The desk asks for the last N×24 hours ending at the
   * moment it reads (not calendar days), adds both to `input`, and the read's title says so. See `inputFor`.
   */
  readonly windowDays?: number;
  /**
   * With `windowDays`: the service takes whole UTC days (`YYYY-MM-DD`), not instants. The desk then sends the N calendar days
   * ending today (UTC), today included.
   */
  readonly windowInUtcDays?: true;
  /** Send `{}` as the input when `input` is empty (the procedure's input is an object and refuses none). */
  readonly sendEmptyInput?: boolean;
  /** `record` is one object shown as facts; `list` is rows with a detail each. */
  readonly shape: 'record' | 'list';
  /** List only: the property that holds the rows when the answer is an object (`disputes`, `trades`). */
  readonly rowsKey?: string;
  /** List only: dotted path of a stable id inside a row. */
  readonly idKey?: string;
  /** List only, instead of `idKey`: the service gives these rows no id (a total per vendor and asset). They are shown by position and carry no row action. */
  readonly anonymousRows?: true;
  readonly columns: readonly Column[];
  /** The page size asked for. A full page means more rows may exist (unless `cursorKey` is set: then the service says so exactly). */
  readonly page?: number;
  /**
   * List only: the property of the answer that holds the service's page marker (`nextCursor`: a string, or null on the last page).
   * With it the desk knows exactly whether more rows exist and can read the next page; without it a full page only means "may exist".
   */
  readonly cursorKey?: string;
  /** What an empty answer means. It is never "healthy". */
  readonly emptyText: string;
  /** What a refusal of this founder's session means for this read. */
  readonly forbiddenText: string;
  /**
   * The service's typed refusal codes this read can get (a missing setting, an unknown id), each in a sentence that states the real
   * reason. A code not listed here gets the generic "refused this read" line with the code beside it.
   */
  readonly refusals?: Readonly<Record<string, string>>;
  /** A row on this list can be acted on with a two-founder request (see `RowAction`). */
  readonly rowAction?: RowAction;
  /**
   * List only: reference data, not work (the fiat currencies P2P can trade against). The table starts folded behind its row count
   * and the CSV export, so it does not push the desk's work (disputes, offers, trades) below the first screen. Nothing is hidden:
   * one click opens every row.
   */
  readonly collapsed?: true;
  /**
   * List only: the service gives each row an id but no name (pool totals carry `poolId`). The name comes from another read on the
   * same desk that lists the same things with their names (`bank.pools`), matched by id. The id moves to the row's detail. A row
   * whose id that read does not list, or a failed or missing read, says so in words instead of a name; nothing is guessed.
   */
  readonly namesFrom?: {
    readonly read: string;
    readonly idKey: string;
    readonly nameKey: string;
    readonly label: string;
    readonly missing: string;
  };
}

export type RowAction =
  | 'market.vendor.vet'
  | 'market.listing.takedown'
  | 'academy.ambassador'
  | 'academy.residency'
  /** One moderator re-arms an open dispute. The service asks for no second person, so this is a direct action with a reason. */
  | 'p2p.dispute.escalate'
  /** Opening a rejected standing-order transfer reads its full record from svc-bank (`ops.transferDetail`), on request. */
  | 'pay.transfer.detail'
  /** Opening one KYC document's contents from identity's vault (`kyc.getDocument`), with a second founder's approval. */
  | 'identity.kyc_document.open'
  /** Accepting or rejecting one selfie that waits for comparison (`kyc.selfie.decide`), with a second founder's approval. */
  | 'identity.kyc_selfie.decide'
  /** Freezing one deposit address (one founder), or lifting its freeze with a second founder (svc-pay `founderAdmin.depositFreezes`). */
  | 'pay.deposit_address'
  /** Waiting on the sending platform, or releasing a declared deposit held for the inbound travel rule (one founder each). */
  | 'pay.deposit_travel_rule';

/** A control that belongs to a whole section rather than to a row (it needs a typed target). */
export type SectionAction = 'academy.ambassador.appoint' | 'bank.card.status' | 'pay.transfer.lookup' | 'bank.customer.balances';

/** A section that is drawn by its own component from the reads above it, not as a list or facts. */
export type SectionPanel = 'protocol.blockers';

/** Something the desk cannot show, and exactly why. Never rendered as a zero. */
export interface Unavailable {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
  /** The item in admin-BACKEND-NEEDS.md that unblocks it, or null when it waits on a decision rather than on code. */
  readonly need: number | null;
}

/** An action that is switched off, and why. */
export interface DisabledAction {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

export interface DeskLink {
  readonly href: string;
  readonly label: string;
  readonly why: string;
}

export interface DeskSection {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly reads: readonly ReadSpec[];
  readonly unavailable: readonly Unavailable[];
  readonly disabledActions: readonly DisabledAction[];
  readonly links: readonly DeskLink[];
  /** A two-founder control for the whole section, such as appointing a person who is not yet in any list. */
  readonly sectionAction?: SectionAction;
  readonly panel?: SectionPanel;
}

export interface DeskSpec {
  readonly id: OpsDeskId;
  /** The console module (ADMIN_MODULES id) that gates this desk's page and API. */
  readonly module: AdminModuleId;
  readonly endpoint: string;
  readonly title: string;
  readonly intro: string;
  readonly sections: readonly DeskSection[];
  /** The common eight-section set this desk shows above its own sections (`common-sections.ts`). */
  readonly commonSet?: CommonDeskId;
  /** Section pages of this desk: when set, the section navigation links to each page instead of to anchors on this one. */
  readonly pages?: readonly DeskPage[];
}

export interface DeskPage {
  readonly id: string;
  readonly title: string;
  readonly href: string;
}

export type CellValue = string | number | boolean | null | readonly string[];

export interface Cell {
  readonly key: string;
  readonly label: string;
  readonly kind: CellKind;
  readonly detail: boolean;
  readonly value: CellValue;
}

export interface Row {
  readonly id: string;
  readonly cells: readonly Cell[];
}

export type ReadData =
  | { readonly shape: 'record'; readonly cells: readonly Cell[] }
  | {
      readonly shape: 'list';
      readonly rows: readonly Row[];
      /** With a `cursorKey` this is exact (the service gave a next page); without one it only means the page is full. */
      readonly pageFull: boolean;
      /** Only on a list with a `cursorKey`: the service's marker for the next page, or null on the last page. */
      readonly nextCursor?: string | null;
    };

export interface ReadOutcome {
  readonly id: string;
  /** When this console finished reading it. */
  readonly asOf: string;
  readonly part: Part<ReadData>;
}

export interface DeskView {
  readonly deskId: OpsDeskId;
  /** When the desk read started. Each read carries its own finish time. */
  readonly asOf: string;
  readonly reads: Readonly<Record<string, ReadOutcome>>;
}
