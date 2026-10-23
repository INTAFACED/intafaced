import { defineCopy } from './i18n';
import './service-off.css';

/**
 * The codes on platform/foundations/NOT-CONNECTED-ALLOWLIST.md: a missing piece OUTSIDE INTAFACED. Our own missing back end is
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

// The copy rule on the allowlist: name the outside dependency and state the present fact, never a promise.
export const serviceOffCopy = defineCopy('service-off', {
  sentence: '{action} needs {dependency}. It is switched off in this build.',
  'rail.bank': 'a banking partner',
  'rail.card': 'a card issuer',
  'rail.crypto': 'a live network node or custody signer',
  'vendor.kyc': 'an identity verification provider',
  'vendor.aml': 'a sanctions screening provider',
  'feed.market': 'a live market data feed',
  'chain.go': 'the INTACHAIN launch go-ahead',
  hardware: 'physical hardware or a courier',
  licence: 'a licence INTAFACED does not hold',
  'owner.decision': 'an owner decision',
  'audit.external': 'an external security audit',
  'vendor.sms': 'an SMS delivery provider',
  'vendor.email': 'an email delivery provider',
  'vendor.tax': 'a tax calculation provider',
  'vendor.travelrule': 'a Travel Rule network',
  'vendor.cloud': 'a cloud provider account',
  'vendor.accounting': 'an accounting software connection',
  'feed.news': 'a news data feed',
  'idp.social': 'an outside sign-in provider',
  'vendor.push': 'a push delivery gateway',
});

/**
 * The one service-off notice of the shell (HM-shell-03): "<Action> needs <dependency>. It is switched off in this build.", with
 * the allowlist code in the page and in `data-not-connected` for the proof crawler. `action` is the caller's own words for what
 * was pressed, already in the reader's language ("Registering this device", "Stake").
 */
export function ServiceOffNotice({ code, action, className }: { code: NotConnectedCode; action: string; className?: string }) {
  const { t } = serviceOffCopy.useCopy();
  return (
    <p className={className ? `service-off ${className}` : 'service-off'} data-not-connected={code}>
      {t('sentence', { action, dependency: t(code) })} <span className="service-off__code">{code}</span>
    </p>
  );
}
