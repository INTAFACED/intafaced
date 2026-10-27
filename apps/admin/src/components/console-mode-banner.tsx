import Link from 'next/link';
import { formatWhen } from '@/lib/as-of';
import type { ConsoleModeView } from '@/lib/console-mode/model';

/**
 * The maintenance-mode banner on every console page (OPS-admin-access-08). On: the console is read-only, with the reason.
 * Not known: svc-ops could not be read, so the banner says writes are not held rather than implying either state. Off, or no
 * storage (off by construction): nothing.
 */
export function ConsoleModeBanner({ view }: { view: ConsoleModeView }) {
  if (view.kind === 'read' && view.mode.readOnly)
    return (
      <div className="adm-callout" data-tone="warn" role="status" data-testid="console-mode-banner" data-state="on">
        <strong>Maintenance mode: this console is read-only.</strong> {view.mode.reason}
        {view.mode.changedAt && <> (since {formatWhen(view.mode.changedAt)})</>}. Writes refuse; reads and the halts still work.{' '}
        <Link href="/tools/console-mode">Maintenance mode</Link>
      </div>
    );
  if (view.kind === 'unknown')
    return (
      <div className="adm-callout" data-tone="info" role="status" data-testid="console-mode-banner" data-state="unknown">
        Maintenance mode is not known: {view.message} Writes are not held. <Link href="/tools/console-mode">Maintenance mode</Link>
      </div>
    );
  return null;
}
