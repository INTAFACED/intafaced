import type { QuantModerationEntry, QuantModerationQueue } from '@intafaced/contracts';
import type { Part } from '@/lib/desk/part';

/**
 * The strategy library desk on the market desk (J-algo-dev-10, AL-library-03). Pure, so the route, the server and the
 * browser share one list of what the desk may do.
 *
 * The proxy names its actions one by one: any other `op` is refused before anything reaches svc-quant.
 */
export const LIBRARY_DESK_OPS = ['hide', 'unhide', 'remove', 'dispute-open', 'dispute-resolve'] as const;
export type LibraryDeskOp = (typeof LIBRARY_DESK_OPS)[number];
export const isLibraryDeskOp = (op: unknown): op is LibraryDeskOp => (LIBRARY_DESK_OPS as readonly unknown[]).includes(op);

export interface LibraryDeskView {
  readonly asOf: string;
  readonly queue: Part<QuantModerationQueue>;
}

export type LibraryDeskReply =
  | { readonly ok: true; readonly what: string; readonly entry: QuantModerationEntry }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };

/** The refusal the proxy gives an action it does not list. svc-quant is never called. */
export const NOT_LISTED = {
  ok: false,
  title: 'That action is not on this desk',
  body: 'The strategy library desk lists hide, unhide, remove, open a dispute and resolve a dispute. Nothing else is passed on.',
  next: 'Nothing was changed.',
  code: 'admin.action_not_listed',
  changed: 'no',
} as const satisfies LibraryDeskReply;

export const STATE_WORDS = { listed: 'In the library', hidden: 'Hidden', removed: 'Removed' } as const;
export const ACTION_WORDS = { hide: 'Hid it', unhide: 'Unhid it', remove: 'Removed it' } as const;
