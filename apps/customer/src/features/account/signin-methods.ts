import { z } from 'zod';

/** The ways an account signs in (svc-identity `signinMethods`, I-account-lifecycle-07). */
export const signinMethods = z.object({
  password: z.boolean(),
  emailCode: z.object({ on: z.boolean(), address: z.string().nullable(), proved: z.boolean() }),
  passkeys: z.number().int().min(0),
  wallets: z.array(z.object({ address: z.string().regex(/^0x[0-9a-f]{40}$/), linkedAt: z.string() })),
  providers: z.array(z.string()),
});
export type SigninMethods = z.infer<typeof signinMethods>;

/** A method as the service names it, and as the step-up binds it. */
export type MethodName = 'password' | 'email_code' | 'sms_code' | `wallet_siwe:${string}`;
export const walletMethod = (address: string): MethodName => `wallet_siwe:${address.toLowerCase()}`;

/** How many ways in the account has; the last one cannot be removed. */
export function waysIn(methods: SigninMethods): number {
  return (methods.password ? 1 : 0) + (methods.emailCode.on ? 1 : 0) + methods.passkeys + methods.wallets.length + methods.providers.length;
}

/** The body of `stepUp.begin` for adding or removing one way in: the method is the target the service re-hashes. */
export function methodStepUp(change: 'link' | 'unlink', method: MethodName, clientRequestId: string) {
  return {
    scope: change === 'link' ? 'identity.step_up.link_method' : 'identity.step_up.unlink_method',
    purpose: change === 'link' ? 'account.signinMethod.link' : 'account.signinMethod.unlink',
    target: method,
    fields: { method, clientRequestId },
  };
}

/** A phone number in international form, as the service checks it: `+`, then 7 to 15 digits. */
export function cleanPhone(raw: string): string | null {
  const phone = raw.replace(/[\s().-]/g, '');
  return /^\+[1-9][0-9]{6,14}$/.test(phone) ? phone : null;
}
