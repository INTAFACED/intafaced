import type { DeskModule } from '@/lib/desk/founder-call';
import type { Part } from '@/lib/desk/part';
import type { ModuleId as AdminModuleId } from '@/lib/modules';

/**
 * Module ops desks: bank, P2P, Academy and the "More" modules.
 *
 * A desk is a catalogue of READS that svc-edge already forwards, plus an honest list of what cannot be read yet.
 * It never holds a figure of its own: every number on the page is a field the owning service returned, stamped with
 * the time this console read it, and a figure the service cannot give is printed as "not available" with the reason.
 */

export type OpsDeskId = 'bank' | 'p2p' | 'academy' | 'more';

/** How one field of an answer is read and shown. Strict: a field of the wrong type makes the whole read invalid. */
export type CellKind =
  | 'text'
  | 'int'
  | 'bool'
  | 'time'
  /** Whole basis points, shown as a percent without floating point. */
  | 'bps'
  /** A decimal string a service formatted (money). Shown exactly as given, never parsed. */
  | 'amount'
  /** An array of strings. */
  | 'list';

export interface Column {
  /** Dotted path into the row (or the record), e.g. `spine.total`. */
  readonly key: string;
  readonly label: string;
  readonly kind: CellKind;
  /** May be null. A missing key is still invalid. */
  readonly nullable?: boolean;
  /** Shown in the row's detail only, not in the table. */
  readonly detail?: boolean;
}

export interface ReadSpec {
  readonly id: string;
  readonly title: string;
  /** One honest sentence on what this read is and is not. */
  readonly note: string;
  readonly module: DeskModule;
  readonly procedure: string;
  readonly input?: Readonly<Record<string, unknown>>;
  /** `record` is one object shown as facts; `list` is rows with a detail each. */
  readonly shape: 'record' | 'list';
  /** List only: the property that holds the rows when the answer is an object (`disputes`, `trades`). */
  readonly rowsKey?: string;
  /** List only: dotted path of a stable id inside a row. */
  readonly idKey?: string;
  readonly columns: readonly Column[];
  /** The page size asked for. A full page means more rows may exist. */
  readonly page?: number;
  /** What an empty answer means. It is never "healthy". */
  readonly emptyText: string;
  /** What a refusal of this founder's session means for this read. */
  readonly forbiddenText: string;
  /** A row on this list can be acted on with a two-founder request (see `RowAction`). */
  readonly rowAction?: RowAction;
}

export type RowAction = 'market.vendor.vet' | 'academy.ambassador';

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
}

export interface DeskSpec {
  readonly id: OpsDeskId;
  /** The console module (ADMIN_MODULES id) that gates this desk's page and API. */
  readonly module: AdminModuleId;
  readonly endpoint: string;
  readonly title: string;
  readonly intro: string;
  readonly sections: readonly DeskSection[];
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
  | { readonly shape: 'list'; readonly rows: readonly Row[]; readonly pageFull: boolean };

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
