import { expandScopes } from '@intafaced/auth';
import { SIGNING_REQUIRED_SCOPE } from '@intafaced/contracts/api-keys';

/** Whether a key with these scopes signs every request by default (DV-auth-01): a key that may place orders does. */
export function signsByDefault(scopes: readonly string[]): boolean {
  return expandScopes(scopes).has(SIGNING_REQUIRED_SCOPE);
}
