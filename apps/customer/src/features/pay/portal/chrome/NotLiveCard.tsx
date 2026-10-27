import type { ReactNode } from 'react';
import { chromeCopy } from './copy';
import './chrome.css';

/** The only blockers a not-live card may name (platform/foundations/NOT-CONNECTED-ALLOWLIST.md): outside parties, hardware, licences and owner decisions, never our own back end. */
export type AllowlistCode =
  | 'rail.bank'
  | 'rail.card'
  | 'rail.crypto'
  | 'vendor.kyc'
  | 'vendor.aml'
  | 'vendor.sms'
  | 'vendor.email'
  | 'vendor.tax'
  | 'feed.market'
  | 'chain.go'
  | 'hardware'
  | 'licence'
  | 'owner.decision'
  | 'audit.external';

/**
 * The one treatment for a feature that is not live: a calm card that names what it is waiting for. `reason` is
 * required on purpose, so no card can say "not yet" without saying why. Take it from `reasons` in `chrome/copy.ts`
 * (or word a new one there). `page` fills a whole page that has no data source yet; `section` is one part of a page.
 * Real permission refusals do not use it; they keep the refusal wording. It is never a fake list row.
 */
export function NotLiveCard({
  reason,
  title,
  variant = 'section',
  needs,
  code,
  children,
}: {
  /** What this part is waiting for, in plain words. Shown as the card's caption. */
  reason: string;
  title?: string;
  variant?: 'page' | 'section';
  /** The service read this waits for. Never shown; the review board lists it. */
  needs?: string;
  /** The allowlisted blocker this waits for; shown as a small code line under the reason. */
  code?: AllowlistCode;
  children?: ReactNode;
}) {
  chromeCopy.useCopy();
  return (
    <section
      data-testid="pfo-soon"
      className={`pfo-soon${variant === 'page' ? ' pfo-soon--page' : ''}`}
      aria-label={title ?? reason}
      data-needs={needs}
      data-code={code}
    >
      <p className="pfo-soon-reason">{reason}</p>
      {code && (
        <p className="pfo-soon-code">
          <code>{code}</code>
        </p>
      )}
      {title && <h3>{title}</h3>}
      {children && <p>{children}</p>}
    </section>
  );
}
