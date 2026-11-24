import type { z } from 'zod';
import type { trustedDevicesSchema } from '@intafaced/contracts/identity-account-room';
import type { StepUpBegin } from './security-step-up';

/** `trustedDevices.list`: whether the check is on, the account's trusted devices, and the sign-ins waiting for approval. */
export type TrustedDevices = z.infer<typeof trustedDevicesSchema>;

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
export const TRUSTED_DEVICE_CODES = [
  'auth.device_not_trusted',
  'identity.device_not_found',
  'auth.code_expired',
  'identity.confirm_from_another_device',
] as const;
export type TrustedDeviceCode = (typeof TRUSTED_DEVICE_CODES)[number];
export const trustedDeviceCode = (code: string | undefined): TrustedDeviceCode | undefined =>
  (TRUSTED_DEVICE_CODES as readonly string[]).includes(code ?? '') ? (code as TrustedDeviceCode) : undefined;
