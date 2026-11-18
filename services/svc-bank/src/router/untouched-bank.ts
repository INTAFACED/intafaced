/**
 * TEST SUPPORT. The whole bank router built over services that no call may touch: proves a door
 * (a preview, a typed refusal) reads and writes nothing. Building the router may read the services,
 * since other routers take theirs at mount; once it is built, any read, call or `new` throws.
 */
import { createBankRouter } from '../router.js';

type BankServices = Parameters<typeof createBankRouter>[0];

export function untouchedBankRouter(what = 'the door'): ReturnType<typeof createBankRouter> {
  let built = false;
  const service = (path: string): BankServices => {
    const touch = (at: string) => {
      if (built) throw new Error(`${what} touched bank.${at}`);
      return service(at);
    };
    const target: object = function () {};
    return new Proxy(target, {
      get: (_t, key) => touch(`${path}.${String(key)}`),
      apply: () => touch(`${path}()`),
      construct: () => touch(`new ${path}`),
    }) as BankServices;
  };
  const made = createBankRouter(service('services'));
  built = true;
  return made;
}
