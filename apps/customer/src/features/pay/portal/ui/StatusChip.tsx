import { portalCopy, type PlainKey } from '../copy';
import { uiCopy } from './copy';
import { chips, type ChipKind as LegacyKind, type Tone } from './status-vocabulary';

/**
 * One status vocabulary for every entity (payment, refund, settlement, payout, approval, dispute, invoice,
 * subscription, mandate, link, KYB, export, webhook endpoint, delivery, member, API key). The word always carries
 * the meaning; the colour and the dot only back it up. Completed is a soft green, never lime.
 */
export type StatusTone = 'done' | 'progress' | 'action' | 'failed';
const toneOf: Record<Tone, StatusTone> = { good: 'done', neutral: 'progress', attention: 'action', bad: 'failed' };

/** The chip itself, for a page that has its own words. */
export function ToneChip({ tone, label, tip }: { tone: StatusTone; label: string; tip?: string }) {
  return (
    <span data-testid="pp-chip" className={`pp-chip pp-chip--${tone}`} title={tip} aria-label={tip ? `${label} (${tip})` : undefined}>
      {label}
    </span>
  );
}

export type StatusEntity = LegacyKind | 'refund' | 'invoice' | 'subscription' | 'mandate' | 'link' | 'endpoint' | 'delivery' | 'key';
type UiKey = Extract<Parameters<typeof uiCopy.t>[0], `chip${string}` | `tip${string}`>;

const fresh: Record<string, Record<string, readonly [UiKey, UiKey, Tone]>> = {
  refund: {
    pending: ['chipRefund_pending', 'tipRefund_pending', 'attention'],
    succeeded: ['chipRefund_succeeded', 'tipRefund_succeeded', 'good'],
    failed: ['chipRefund_failed', 'tipRefund_failed', 'bad'],
  },
  invoice: {
    draft: ['chipInvoice_draft', 'tipInvoice_draft', 'neutral'],
    sent: ['chipInvoice_sent', 'tipInvoice_sent', 'attention'],
    overdue: ['chipInvoice_overdue', 'tipInvoice_overdue', 'bad'],
    paid: ['chipInvoice_paid', 'tipInvoice_paid', 'good'],
    void: ['chipInvoice_void', 'tipInvoice_void', 'neutral'],
  },
  subscription: {
    active: ['chipSubscription_active', 'tipSubscription_active', 'good'],
    paused: ['chipSubscription_paused', 'tipSubscription_paused', 'attention'],
    cancelled: ['chipSubscription_cancelled', 'tipSubscription_cancelled', 'neutral'],
    completed: ['chipSubscription_completed', 'tipSubscription_completed', 'good'],
  },
  mandate: {
    active: ['chipMandate_active', 'tipMandate_active', 'good'],
    revoked: ['chipMandate_revoked', 'tipMandate_revoked', 'bad'],
    expired: ['chipMandate_expired', 'tipMandate_expired', 'neutral'],
  },
  link: {
    active: ['chipLink_active', 'tipLink_active', 'good'],
    inactive: ['chipLink_inactive', 'tipLink_inactive', 'neutral'],
    expired: ['chipLink_expired', 'tipLink_expired', 'neutral'],
  },
  endpoint: {
    active: ['chipEndpoint_active', 'tipEndpoint_active', 'good'],
    disabled: ['chipEndpoint_disabled', 'tipEndpoint_disabled', 'neutral'],
  },
  delivery: {
    delivered: ['chipDelivery_delivered', 'tipDelivery_delivered', 'good'],
    pending: ['chipDelivery_pending', 'tipDelivery_pending', 'attention'],
    failed: ['chipDelivery_failed', 'tipDelivery_failed', 'bad'],
  },
  key: {
    active: ['chipKey_active', 'tipKey_active', 'good'],
    revoked: ['chipKey_revoked', 'tipKey_revoked', 'bad'],
  },
};

export function StatusChip({ entity, value }: { entity: StatusEntity; value: string }) {
  const { t } = portalCopy.useCopy();
  const { t: u } = uiCopy.useCopy();
  const legacy = (chips as Record<string, Record<string, readonly [PlainKey, PlainKey, Tone]>>)[entity]?.[value];
  if (legacy) return <ToneChip tone={toneOf[legacy[2]]} label={t(legacy[0])} tip={t(legacy[1])} />;
  const next = fresh[entity]?.[value];
  if (next) return <ToneChip tone={toneOf[next[2]]} label={u(next[0])} tip={u(next[1])} />;
  // A status the vocabulary has not met is shown as the service sent it, in the quiet tone, never hidden.
  return <ToneChip tone="progress" label={value} />;
}
