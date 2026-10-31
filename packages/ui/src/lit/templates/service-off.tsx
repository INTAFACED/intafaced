/**
 * The one service-off notice (HM-shell-03): an action that needs a piece OUTSIDE INTAFACED, switched off in this build.
 * It lives with the templates so no room draws its own. The sentence comes in the reader’s language from the caller’s copy
 * ("Registering this device needs a push delivery gateway. It is switched off in this build."); the allowlist code
 * follows it in a quieter face and sits in `data-not-connected` for the proof crawler. `service-off` stays on the paragraph
 * as the rooms' and journeys' handle for it. Styling is `templates.css` (`--lit-*` roles only).
 */
/**
 * The not-connected allowlist: a missing piece OUTSIDE INTAFACED. Our own missing back end is
 * never one of these; it refuses with its own typed error or shows an empty state, and must be built. A code not in this list
 * does not type-check as a `NotConnectedCode`, so an own gap cannot borrow the notice.
 */
export const NOT_CONNECTED_CODES = [
  'rail.bank',
  'rail.card',
  'rail.crypto',
  'vendor.kyc',
  'vendor.aml',
  'feed.market',
  'chain.go',
  'hardware',
  'licence',
  'owner.decision',
  'audit.external',
  'vendor.sms',
  'vendor.email',
  'vendor.tax',
  'vendor.travelrule',
  'vendor.cloud',
  'vendor.accounting',
  'feed.news',
  'idp.social',
  'vendor.push',
] as const;
export type NotConnectedCode = (typeof NOT_CONNECTED_CODES)[number];

export interface ServiceOffNoticeProps {
  code: NotConnectedCode;
  /** The whole sentence in the reader's language, from the allowlist copy (apps/customer/src/shared/service-off.tsx):
   *  the action and the outside dependency, a present fact, never a promise. The kit takes copy, as its other parts do. */
  sentence: string;
  className?: string;
  /** `note` where the notice is the reason beside a disabled control, as the room's other reasons are. */
  role?: 'note' | 'status';
}

export function ServiceOffNotice({ code, sentence, className, role }: ServiceOffNoticeProps) {
  return (
    <p className={['service-off lt-service-off', className].filter(Boolean).join(' ')} data-not-connected={code} role={role}>
      {sentence} <span className="lt-service-off-code">{code}</span>
    </p>
  );
}
