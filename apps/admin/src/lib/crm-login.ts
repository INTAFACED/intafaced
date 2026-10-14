/** Sign-in checks that run before anything is sent, so a missing field is explained under that field instead of in a browser bubble. */
export type LoginFields = { identifier: string; password: string; totpCode: string };
export type LoginFieldErrors = Partial<Record<keyof LoginFields, string>>;

export function loginFieldErrors({ identifier, password, totpCode }: LoginFields): LoginFieldErrors {
  const errors: LoginFieldErrors = {};
  if (!identifier.trim()) errors.identifier = 'Enter your email or handle.';
  if (!password) errors.password = 'Enter your password.';
  if (!totpCode.trim()) errors.totpCode = 'Enter the code from your authenticator, or a recovery code.';
  return errors;
}

/** The first field with a problem, in the order the form shows them. */
export function firstLoginError(errors: LoginFieldErrors): keyof LoginFields | null {
  return (['identifier', 'password', 'totpCode'] as const).find((field) => errors[field]) ?? null;
}
