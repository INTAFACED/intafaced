import type { ChipTone } from '@/components/chip';

/**
 * One status vocabulary per entity. Each entry has a label (the text always
 * says it, never colour alone) and a plain-English tooltip.
 */
export interface ChipSpec {
  readonly label: string;
  readonly tone: ChipTone;
  readonly hint: string;
}

const UNKNOWN = (value: string): ChipSpec => ({
  label: value === '' ? 'unknown' : value.replace(/_/g, ' '),
  tone: 'neutral',
  hint: `This service reported "${value}", which this console does not have a description for yet.`,
});

const MERCHANT_STATUS: Record<string, ChipSpec> = {
  pending: { label: 'pending', tone: 'warn', hint: 'Created but not yet cleared to take payments.' },
  active: { label: 'active', tone: 'live', hint: 'Can take payments within its limits.' },
  suspended: { label: 'suspended', tone: 'danger', hint: 'Payments are stopped. An operator suspended this merchant.' },
  closed: { label: 'closed', tone: 'dark', hint: 'Permanently closed. No new activity.' },
};

const KYB_STATUS: Record<string, ChipSpec> = {
  none: { label: 'no KYB', tone: 'dark', hint: 'The merchant has not submitted business verification.' },
  pending: { label: 'KYB pending', tone: 'warn', hint: 'Business verification was submitted and is waiting for a decision.' },
  approved: { label: 'KYB approved', tone: 'live', hint: 'Business verification passed.' },
  rejected: { label: 'KYB rejected', tone: 'danger', hint: 'Business verification was declined.' },
};

const VENUE_MODE: Record<string, ChipSpec> = {
  disabled: { label: 'disabled', tone: 'dark', hint: 'Never routed to.' },
  testnet: { label: 'testnet', tone: 'info', hint: 'Test network only. No real money moves.' },
  live: { label: 'live (blocked)', tone: 'danger', hint: 'Live trading is refused until Nitro and Phantom switch it on.' },
};

const PAYOUT_APPROVAL: Record<string, ChipSpec> = {
  pending: {
    label: 'waiting for founders',
    tone: 'warn',
    hint: 'The merchant’s team has approved. Two founders must now sign before the payout can go.',
  },
  approved: { label: 'approved', tone: 'live', hint: 'Both founders signed. The payout can go ahead.' },
  rejected: { label: 'rejected', tone: 'danger', hint: 'Declined. The payout will not go.' },
  voided: { label: 'voided', tone: 'dark', hint: 'The payout changed after it was requested, so the approval no longer covers it.' },
  expired: { label: 'expired', tone: 'dark', hint: 'It ran out of time before it was fully approved.' },
  consumed: { label: 'used', tone: 'dark', hint: 'The approval was already used by a payout.' },
};

export const payoutApprovalChip = (value: string): ChipSpec => PAYOUT_APPROVAL[value] ?? UNKNOWN(value);

export const merchantStatusChip = (value: string): ChipSpec => MERCHANT_STATUS[value] ?? UNKNOWN(value);
export const kybStatusChip = (value: string): ChipSpec => KYB_STATUS[value] ?? UNKNOWN(value);
export const venueModeChip = (value: string): ChipSpec => VENUE_MODE[value] ?? UNKNOWN(value);

export function enabledChip(enabled: boolean): ChipSpec {
  return enabled
    ? { label: 'on', tone: 'live', hint: 'Switched on.' }
    : { label: 'off', tone: 'dark', hint: 'Switched off. It is never used while off.' };
}

export function routableChip(routable: boolean, missing: readonly string[]): ChipSpec {
  return routable
    ? { label: 'ready', tone: 'live', hint: 'Fully configured and in use.' }
    : {
        label: 'not ready',
        tone: 'warn',
        hint: missing.length
          ? `Not used yet. Still to configure: ${missing.map((m) => m.replace(/_/g, ' ')).join(', ')}.`
          : 'Not used yet.',
      };
}

export function healthChip(health: { healthy: boolean; reason?: string | undefined } | null): ChipSpec {
  if (health === null)
    return { label: 'health unknown', tone: 'neutral', hint: 'No health report yet. Unknown is never shown as healthy.' };
  return health.healthy
    ? { label: 'healthy', tone: 'live', hint: 'The last health check passed.' }
    : { label: 'unhealthy', tone: 'danger', hint: health.reason ?? 'The last health check failed.' };
}

export function railChip(ok: boolean): ChipSpec {
  return ok
    ? { label: 'rail up', tone: 'live', hint: 'This payment rail is answering.' }
    : { label: 'rail down', tone: 'danger', hint: 'This payment rail is not answering.' };
}

export function haltChip(halted: boolean): ChipSpec {
  return halted
    ? { label: 'halted', tone: 'danger', hint: 'This operation is paused.' }
    : { label: 'running', tone: 'live', hint: 'This operation is running.' };
}

export function dualControlChip(needs: boolean): ChipSpec {
  return needs
    ? { label: 'needs second founder', tone: 'warn', hint: 'A second, different founder must approve this change before it saves.' }
    : { label: 'single founder', tone: 'info', hint: 'This change does not need a second founder.' };
}

export const MERCHANT_STATUSES = ['pending', 'active', 'suspended', 'closed'] as const;
export const KYB_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;
