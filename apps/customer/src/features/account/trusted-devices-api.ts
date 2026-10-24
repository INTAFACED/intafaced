// hand-declared-ok: svc-identity's trustedDevices answers are declared in its own router, not in packages/contracts yet
import { z } from 'zod';
import type { StepUpBegin } from './security-step-up';

const iso = z.string().datetime({ offset: true });

/** `trustedDevices.list`: whether the check is on, the account's trusted devices, and the sign-ins waiting for approval. */
export const trustedDevicesSchema = z.object({
  check: z.enum(['on', 'off']),
  devices: z.array(
    z.object({
      id: z.string().guid(),
      label: z.string(),
      firstSeenAt: iso,
      lastSeenAt: iso,
      trustedUntil: iso.nullable(),
      current: z.boolean(),
    }),
  ),
  waiting: z.array(z.object({ flowId: z.string().guid(), label: z.string(), createdAt: iso, expiresAt: iso })),
});
export type TrustedDevices = z.infer<typeof trustedDevicesSchema>;

export const deviceRemovedSchema = z.object({ removed: z.boolean(), sessionsEnded: z.number().int().nonnegative() });
export const deviceApprovedSchema = z.object({ approved: z.literal(true) });

/** The step-up for removing one device: bound to the device and this request. */
export function removeStepUp(deviceId: string, clientRequestId: string): StepUpBegin {
  return {
    scope: 'identity.step_up.trusted_device_remove',
    purpose: 'account.trustedDevice.remove',
    target: deviceId,
    fields: { deviceId, clientRequestId },
  };
}

/** The step-up for approving one waiting sign-in: bound to that sign-in's flow. */
export function approveStepUp(flowId: string): StepUpBegin {
  return { scope: 'identity.step_up.trusted_device_approve', purpose: 'account.trustedDevice.approve', target: flowId, fields: { flowId } };
}

/** The refusals this card words itself. */
export const TRUSTED_DEVICE_CODES = ['auth.device_not_trusted', 'identity.device_not_found', 'auth.code_expired'] as const;
export type TrustedDeviceCode = (typeof TRUSTED_DEVICE_CODES)[number];
export const trustedDeviceCode = (code: string | undefined): TrustedDeviceCode | undefined =>
  (TRUSTED_DEVICE_CODES as readonly string[]).includes(code ?? '') ? (code as TrustedDeviceCode) : undefined;
