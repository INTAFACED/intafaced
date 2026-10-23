// hand-declared-ok: `factorStatus` is declared in svc-identity, not in a browser-safe @intafaced/contracts export
import { z } from 'zod';

const count = z.number().int().min(0);
export const checklistKey = z.enum(['second_factor', 'passkey', 'authenticator', 'recovery_codes']);
export const floorAction = z.enum(['money_out', 'security_change']);

/** `factorStatus`: the caller's own sign-in methods and the derived checklist. `policy` null means no owner setting. */
export const factorStatus = z.object({
  password: z.boolean(),
  authenticator: z.object({ on: z.boolean(), label: z.string().nullable() }),
  passkeys: z.object({ count, kinds: z.object({ platform: count, cross_device: count, security_key: count, unknown: count }) }),
  recoveryCodesLeft: count,
  secondStepRequired: z.object({ floor: z.array(floorAction), policy: z.null() }),
  checklist: z.array(z.object({ key: checklistKey, done: z.boolean() })),
});
export type FactorStatus = z.infer<typeof factorStatus>;
