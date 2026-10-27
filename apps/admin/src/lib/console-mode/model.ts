import { CONSOLE_MODE_STORAGE_UNCONFIGURED, consoleModeSchema, type ConsoleMode } from '@intafaced/contracts/ops-console-mode';

/**
 * The console's maintenance mode as this console last read it from svc-ops (OPS-admin-access-08). Pure, so the server
 * loader, the banner and the desk read it the same way.
 *
 *   read          svc-ops answered: the mode, as stored.
 *   unconfigured  svc-ops has no storage for it: it is off by construction, and it cannot be turned on.
 *   unknown       svc-ops could not be read: nothing is assumed, and writes are not held (the gate fails open).
 */
export type ConsoleModeView =
  | { readonly kind: 'read'; readonly mode: ConsoleMode }
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'unknown'; readonly message: string; readonly code: string | null };

export function readConsoleMode(raw: unknown): ConsoleMode | null {
  const parsed = consoleModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const isStorageUnconfigured = (code: string | null): boolean => code === CONSOLE_MODE_STORAGE_UNCONFIGURED;

/** The words the banner and the desk lead with. */
export function consoleModeHeadline(view: ConsoleModeView): string {
  if (view.kind === 'unconfigured') return 'Maintenance mode is off: svc-ops has no storage for it, so it cannot be turned on.';
  if (view.kind === 'unknown') return 'Maintenance mode is not known: svc-ops could not be read, so writes are not held.';
  return view.mode.readOnly ? 'Maintenance mode is on: this console is read-only.' : 'Maintenance mode is off: this console takes writes.';
}
